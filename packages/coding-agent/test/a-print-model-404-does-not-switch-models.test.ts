// A print run used to report success after a fallback answered for an explicit model.
// Drive the real CLI and session retry ladder. Only the provider stream is scripted.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync } from "node:fs";
import type { AssistantMessage } from "@veyyon/ai";
import { resolveApiKeyOnce } from "@veyyon/ai/auth-retry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/registry/oauth";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { emptyUsage } from "@veyyon/catalog/models";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runRootCommand } from "@veyyon/coding-agent/main";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem, TempDir } from "@veyyon/utils";

const PROVIDER = "openai-codex";
const AUTH_FIXTURE = "explicit-print-account-fixture";
const PRIMARY = `${PROVIDER}/gpt-5.6-sol`;
const FALLBACK = `${PROVIDER}/gpt-5.5`;
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
	let requestKeys: (string | undefined)[];

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-print-404-");
		auth = await AuthStorage.create(temp.join("auth.db"));
		auth.setRuntimeApiKey(PROVIDER, "fixture-key");
		stdout = stderr = "";
		exit = undefined;
		requested = [];
		requestKeys = [];
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
		unregisterOAuthProviders(AUTH_FIXTURE);
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
				createAgentSession: async options => {
					const created = await createAgentSession({
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
					created.session.agent.streamFn = async (model, _context, options) => {
						if (args.includes("--account")) requestKeys.push(await resolveApiKeyOnce(options?.apiKey));
						const selector = `${model.provider}/${model.id}`;
						requested.push(selector);
						const failed = selector === PRIMARY;
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
						stream.push(
							failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message },
						);
						stream.end(message);
						return stream;
					};
					return created;
				},
			});
		} catch (error) {
			if (error !== EXIT) throw error;
		}
		if (requested.length === 0) throw new Error(`Fixture never called the provider: ${stderr || stdout}`);
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

	it("sends the print request with only the explicitly pinned account", async () => {
		auth.removeRuntimeApiKey(PROVIDER);
		await auth.set(
			PROVIDER,
			["first", "second"].map(accountId => ({
				type: "oauth" as const,
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 60 * 60_000,
				accountId,
			})),
		);
		registerOAuthProvider({
			id: PROVIDER,
			name: "Print OAuth fixture",
			sourceId: AUTH_FIXTURE,
			async login() {
				throw new Error("Unexpected login in the print fixture");
			},
			async refreshToken() {
				throw new Error("Unexpected refresh in the print fixture");
			},
			getApiKey: credential => credential.access,
		});
		expect(await auth.getOAuthAccessAt(PROVIDER, 1)).toMatchObject({ ok: true, accountId: "second" });
		await launch(["-p", "--model", PRIMARY, "--account", "2"]);
		expect(requested).toEqual([PRIMARY]);
		expect(requestKeys).toEqual(["access-second"]);
		expect(exit).toBe(1);
	});
});
