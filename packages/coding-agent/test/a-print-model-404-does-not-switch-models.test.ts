// A print run used to report success after a fallback answered for an explicit model.
// Drive the real CLI and session retry ladder. Only the provider stream is scripted.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync } from "node:fs";
import type { AssistantMessage } from "@veyyon/ai";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { emptyUsage } from "@veyyon/catalog/models";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runRootCommand } from "@veyyon/coding-agent/main";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem, TempDir } from "@veyyon/utils";

const PROVIDER = "print-404-fixture";
const PRIMARY = `${PROVIDER}/primary`;
const FALLBACK = `${PROVIDER}/fallback`;
const HTTP_ERROR = 'Provider request failed (404): Requested entity was not found. NOT_FOUND';
const EXIT = new Error("print process exited");

const launchModes = [["-p"], ["--mode", "json"]];

describe("print-mode model availability", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let stdout: string;
	let stderr: string;
	let exit: number | undefined;
	let requested: string[];

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-print-404-");
		auth = await AuthStorage.create(temp.join("auth.db"));
		auth.setRuntimeApiKey(PROVIDER, "fixture-key");
		stdout = stderr = "";
		exit = undefined;
		requested = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk, callback) => {
			stdout += String(chunk);
			if (typeof callback === "function") callback();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk, callback) => {
			stderr += String(chunk);
			if (typeof callback === "function") callback();
			return true;
		});
		vi.spyOn(process, "exit").mockImplementation(code => {
			exit = Number(code);
			throw EXIT;
		});
		vi.spyOn(postmortem, "quit").mockImplementation(async () => {});
		vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(PROVIDER);
		auth.close();
		temp.removeSync();
	});

	async function launch(args: string[]): Promise<void> {
		const cwd = temp.join("project");
		mkdirSync(cwd);
		const argv = [...args, "--no-session", "Reply briefly"];
		try {
			await runRootCommand(parseArgs(argv), argv, {
				discoverAuthStorage: async () => auth,
				settings: Settings.isolated({
					defaultModel: PRIMARY,
					"compaction.enabled": false,
					"retry.enabled": true,
					"retry.modelFallback": true,
					"retry.fallbackChains": { [PRIMARY]: [FALLBACK] },
				}),
				readPipedInput: async () => undefined,
				createAgentSession: options => {
					options.modelRegistry?.registerProvider(PROVIDER, {
						baseUrl: "http://127.0.0.1:1",
						api: PROVIDER,
						apiKey: "literal:fixture-key",
						models: ["primary", "fallback"].map(id => ({
							id,
							name: id,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8_192,
						})),
						streamSimple: model => {
							requested.push(`${model.provider}/${model.id}`);
							const failed = model.id === "primary";
							const message: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								content: failed ? [] : [{ type: "text", text: "FALLBACK ANSWER" }],
								usage: { ...emptyUsage(), credentialId: "23" },
								timestamp: Date.now(),
								stopReason: failed ? "error" : "stop",
								...(failed ? { errorStatus: 404, errorMessage: HTTP_ERROR } : {}),
							};
							const stream = new AssistantMessageEventStream();
							stream.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
							stream.end(message);
							return stream;
						},
					}, PROVIDER);
					return createAgentSession({
						...options,
						cwd,
						sessionManager: SessionManager.inMemory(cwd),
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMCP: false,
						enableLsp: false,
						skipPythonPreflight: true,
						rules: [],
						workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
					});
				},
			});
		} catch (error) {
			if (error !== EXIT) throw error;
		}
	}

	for (const mode of launchModes) {
		it(`fails on a 404 from an explicit model in ${mode.join(" ")}`, async () => {
			await launch([...mode, "--model", PRIMARY]);
			expect(requested).toEqual([PRIMARY]);
			expect(exit).toBe(1);
			expect(stderr).toContain(`${PRIMARY} (account #23, HTTP 404)`);
			expect(stdout).not.toContain("FALLBACK ANSWER");
		});

		it(`warns about configured fallback in ${mode.join(" ")}`, async () => {
			await launch(mode);
			expect(requested).toEqual([PRIMARY, FALLBACK]);
			expect(stdout).toContain("FALLBACK ANSWER");
			expect(stderr).toContain("Warning: Model fallback");
			expect(stderr).toContain(PRIMARY);
			expect(stderr).toContain(FALLBACK);
			if (mode[0] === "--mode") expect(() => stdout.trim().split("\n").map(line => JSON.parse(line))).not.toThrow();
		});
	}
});
