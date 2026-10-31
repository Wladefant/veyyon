/**
 * WHY: print mode decided a run's outcome from the tail of the session's context, and the session
 * drops a classifier refusal from that context once the turn settles. A refused `-p` run therefore
 * read its own prompt as the tail, printed nothing and exited 0, so a script read a refusal as an
 * empty success. The class this closes: a run that ended in an error the session no longer holds
 * in its context, in every output mode print mode accepts, for a refusal with or without a streamed
 * tool call, and for one that arrives after the run already finished a tool turn. It drives the
 * real `AgentSession` and `Agent` against a scripted provider.
 *
 * A later prompt that is answered is the control: the outcome is the latest run's, not any
 * refusal the session ever saw. Not caught: which turn a run that did not end in an error reports
 * (print mode reads the context tail for it, as before), an error turn that a retry or a fallback
 * recovers, whose outcome the retry suites pin, and the stdout drain ordering before the exit
 * (stdout is mocked here).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { EXIT_FAILURE } from "@veyyon/coding-agent/cli/exit-codes";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { type PrintModeOptions, runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../agent/test/helpers";

const OUTPUT_MODES: PrintModeOptions["mode"][] = ["text", "json"];
const REFUSAL_LINE = "Refusal (cyber): Classifier declined this turn.";

const REFUSAL: MockResponse = {
	content: [{ type: "toolCall", id: "toolu_refused", name: "read", arguments: { path: "a.txt" } }],
	stopReason: "error",
	stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
	errorMessage: REFUSAL_LINE,
};

/** The provider's replies to one prompt, ending in a classifier refusal. */
const REFUSED_RUNS: Record<string, MockResponse[]> = {
	"text-only": [{ ...REFUSAL, content: ["Classifier declined this turn."] }],
	"with a streamed tool call": [REFUSAL],
	"after a tool turn": [
		{ content: [{ type: "toolCall", id: "toolu_ran", name: "read", arguments: { path: "b" } }] },
		REFUSAL,
	],
};

describe("a print run whose turn a classifier refused", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let exitCodes: number[];
	let stderr: string;
	let stdout: string;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-refused-print-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		exitCodes = [];
		stderr = "";
		stdout = "";
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
			exitCodes.push(Number(code ?? 0));
			return undefined as never;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr += String(chunk);
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk, callback) => {
			stdout += String(chunk);
			if (typeof callback === "function") callback();
			return true;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function startSession(responses: MockResponse[]): AgentSession {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const mock = createMockModel({ responses });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "anthropic-test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
			}),
			modelRegistry,
		});
		return session;
	}

	for (const [shape, replies] of Object.entries(REFUSED_RUNS)) {
		it.each(OUTPUT_MODES)(`fails and states the refusal, ${shape}, in %s mode`, async mode => {
			const refused = startSession(replies);
			await runPrintMode(refused, { mode, initialMessage: "Run the check" });
			// The run's own context no longer ends at the refused turn, which is what hid it.
			expect(refused.state.messages.at(-1)?.role).not.toBe("assistant");
			expect(exitCodes).toEqual([EXIT_FAILURE]);
			expect(stderr).toContain(`${REFUSAL_LINE}\n`);
		});
	}

	it.each(OUTPUT_MODES)("control: a later prompt that is answered ends the run in success, in %s mode", async mode => {
		const recovered = startSession([REFUSAL, { content: ["Answered."] }]);
		await runPrintMode(recovered, { mode, initialMessage: "Run the check", messages: ["Try again"] });
		expect(exitCodes).toEqual([]);
		expect(stderr).not.toContain(REFUSAL_LINE);
		if (mode === "text") expect(stdout).toBe("Answered.\n");
	});
});
