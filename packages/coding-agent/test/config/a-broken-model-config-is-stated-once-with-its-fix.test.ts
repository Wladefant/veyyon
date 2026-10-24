import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import { EXIT_FAILURE } from "@veyyon/coding-agent/cli/exit-codes";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * WHY. A `models.yml` that failed to load was reported three times over and pointed away from
 * itself. The resolution failure spliced the load error, which already ends with its own `Fix:`
 * line, into the middle of a sentence, so the text read "fall back to the defaults.. Fix the model
 * configuration and retry". The launch then printed the same load error again on its own, and a
 * print run closed with "Set an API key environment variable" and "Or create <the file that
 * exists>". A prompt typed into such a session said "run /login", which cannot select a model the
 * broken file declares.
 *
 * The class closed here is "a model configuration load error stated more than once, spliced into
 * another sentence, or followed by a remedy that does not fix the file". Every load-failure stage
 * a broken file reaches (an empty file, a YAML parse error, a schema error) is driven through the
 * real CLI with and without `--model`, and the prompt path is driven through a real
 * `AgentSession` whose registry failed to load.
 *
 * Not caught: the interactive startup notice, which is built from the same notice list as the print
 * run but drawn by the TUI, and a registry error raised by something other than the config file.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

const LOAD_ERROR_TITLE = "Failed to load config file models";

const BROKEN_FILES: ReadonlyArray<{ readonly stage: string; readonly body: string }> = [
	{ stage: "an empty file", body: "" },
	{ stage: "a YAML parse error", body: "providers: [unclosed\n" },
	{ stage: "a schema error", body: "providers: 5\n" },
];

const INVOCATIONS: ReadonlyArray<{ readonly name: string; readonly args: readonly string[] }> = [
	{ name: "with --model naming a model the file declares", args: ["-p", "--model", "local/bench", "hi"] },
	{ name: "with no --model", args: ["-p", "hi"] },
];

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

async function runPrint(args: readonly string[], modelsYml: string | undefined) {
	const { home, env, cleanup } = hermeticSpawnEnv();
	try {
		if (modelsYml !== undefined) {
			const agentDir = path.join(home, ".veyyon", "profiles", "default", "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(path.join(agentDir, "models.yml"), modelsYml);
		}
		const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
			env,
			cwd: home,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		return { code, stderr };
	} finally {
		cleanup();
	}
}

describe("a print run with a models.yml that failed to load", () => {
	for (const file of BROKEN_FILES) {
		for (const invocation of INVOCATIONS) {
			it(`states ${file.stage} once, with its fix and nothing else, ${invocation.name}`, async () => {
				const { code, stderr } = await runPrint(invocation.args, file.body);

				expect(code).toBe(EXIT_FAILURE);
				expect(stderr).toContain("The model configuration failed to load, so ");
				expect(occurrences(stderr, LOAD_ERROR_TITLE)).toBe(1);
				expect(stderr.split("\n").filter(line => line.startsWith("Fix:"))).toHaveLength(1);
				expect(stderr).not.toMatch(/[^.]\.\.(?!\.)/);
				expect(stderr).not.toContain("Set an API key environment variable");
				expect(stderr).not.toContain("Or create ");
			}, 60_000);
		}
	}

	it("control: with no models.yml and no credentials it still gives the key advice", async () => {
		const { code, stderr } = await runPrint(["-p", "hi"], undefined);

		expect(code).toBe(EXIT_FAILURE);
		expect(stderr).not.toContain(LOAD_ERROR_TITLE);
		expect(stderr).toContain("Set an API key environment variable");
	}, 60_000);
});

describe("a prompt sent with no model while the model configuration is broken", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-broken-models-yml-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	async function promptError(modelsYml: string | undefined): Promise<string> {
		const modelsPath = path.join(tempDir.path(), "models.yml");
		if (modelsYml !== undefined) fs.writeFileSync(modelsPath, modelsYml);
		session = new AgentSession({
			// `model: undefined` as the session factory passes it when startup resolved none; an
			// omitted key would get the agent's own fallback model instead.
			agent: new Agent({ initialState: { model: undefined, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, modelsPath),
		});
		try {
			await session.prompt("hello");
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error("Expected the prompt to fail with no model selected");
	}

	for (const file of BROKEN_FILES) {
		it(`names the load error of ${file.stage} instead of sending the reader to sign in`, async () => {
			const message = await promptError(file.body);

			expect(message).toStartWith("No model selected, so there is nothing to send the prompt to.");
			expect(occurrences(message, LOAD_ERROR_TITLE)).toBe(1);
			expect(message).toContain(path.join(tempDir.path(), "models.yml"));
			expect(message).not.toContain("/login");
		});
	}

	it("control: with no models.yml it sends the reader to sign in", async () => {
		const message = await promptError(undefined);

		expect(message).toStartWith("No model selected, so there is nothing to send the prompt to.");
		expect(message).not.toContain(LOAD_ERROR_TITLE);
		expect(message).toContain("run /login to sign in");
	});
});
