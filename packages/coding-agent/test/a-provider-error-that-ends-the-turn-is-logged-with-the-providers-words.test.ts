/**
 * WHY: a provider error that no retry or fallback recovered ended the turn with only a debug
 * "retry classification" line in the log, logged once per recovery check (three identical lines per
 * failure), and the provider's own message (an `invalid_request_error` body, a request id) appeared
 * nowhere in the log. A failure read from the logs could not say why the request was rejected, and
 * counted three failures for each one.
 *
 * Class closed: every turn a provider error ends, whether terminal on the first answer or after the
 * retries ran out, logs one warn holding the provider's words, its status and its classification;
 * a turn a retry recovered logs none; one failure logs its classification once. Driven through a real
 * `AgentSession` and its retry runtime with a mock stream.
 *
 * Not caught: a failure that never reaches the settle path (a session disposed mid-turn), and the
 * wording of the provider's message, which is the provider's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../agent/test/helpers";

const ENDED = "Provider error ended the turn";

const INVALID_REQUEST =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.input_schema: type is required"},"request_id":"req_0000000000"}';
const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe("a provider error that ends the turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-turn-error-log-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	function model(): Model {
		const found = requireBundledModel("anthropic", "claude-sonnet-4-5");
		return found;
	}

	/** Run one prompt on a stream that throws `failures` (one per attempt, the last repeating) and then answers. */
	async function runTurn(failures: readonly string[], answerAfter: number, maxRetries: number): Promise<void> {
		const mock = createMockModel();
		let attempt = 0;
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				const index = attempt++;
				if (index < answerAfter) mock.push({ throw: failures[Math.min(index, failures.length - 1)]! });
				else mock.push({ content: ["ok"] });
				return mock.stream(requested, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": maxRetries,
			}),
			modelRegistry,
		});
		await session.prompt("go");
		await session.waitForIdle();
	}

	function endedLogs(calls: ReadonlyArray<readonly unknown[]>): Array<Record<string, unknown>> {
		return calls.filter(call => call[0] === ENDED).map(call => (call[1] ?? {}) as Record<string, unknown>);
	}

	it("logs a terminal rejection once, with the provider's message and its classification", async () => {
		const warn = vi.spyOn(logger, "warn");
		const debug = vi.spyOn(logger, "debug");
		await runTurn([INVALID_REQUEST], Number.POSITIVE_INFINITY, 3);

		const ended = endedLogs(warn.mock.calls);
		expect(ended).toHaveLength(1);
		const last = session?.messages.at(-1);
		expect(last).toMatchObject({ role: "assistant", stopReason: "error" });
		const recorded = last as { provider: string; model: string };
		expect(ended[0]).toMatchObject({ provider: recorded.provider, model: recorded.model, kind: "status:400" });
		expect(String(ended[0]?.error)).toContain("tools.0.input_schema: type is required");
		expect(String(ended[0]?.error)).toContain("req_0000000000");
		// One failure, one classification line, however many recovery checks classified it.
		expect(debug.mock.calls.filter(call => call[0] === "retry classification")).toHaveLength(1);
	});

	it("logs nothing as ended when a retry recovers the turn", async () => {
		const warn = vi.spyOn(logger, "warn");
		await runTurn([OVERLOADED], 1, 3);

		expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(endedLogs(warn.mock.calls)).toEqual([]);
	});

	it("logs the final error once when the retries run out", async () => {
		const warn = vi.spyOn(logger, "warn");
		await runTurn([OVERLOADED], Number.POSITIVE_INFINITY, 2);

		const ended = endedLogs(warn.mock.calls);
		expect(ended).toHaveLength(1);
		expect(String(ended[0]?.error)).toContain("Overloaded");
	});
});
