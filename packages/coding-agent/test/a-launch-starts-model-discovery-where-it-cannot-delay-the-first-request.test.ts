/**
 * WHY: a single-shot run (`-p`, `--mode json`) started background model discovery the moment its
 * session existed. The discovery's catalog reload and `models.dev` parse ran on the event loop while
 * the run built its first provider request, delaying that request by about 30 ms of a 165 ms run,
 * and its network fetch was cut off when the run exited. The class this closes: a launch mode that
 * starts discovery where it delays the first request, starts it more than once, or never starts it.
 * Every `Mode` is pinned to the moment its launch starts discovery by exact equality, so a new mode
 * fails here until someone records that moment. Each mode runs through `runRootCommand` with a real
 * session on a scripted provider; only the protocol runners, which own stdin, are replaced at their
 * injection points, and each one records the moment it holds a session.
 *
 * Not caught: the terminal, which starts discovery after its first frame and runs only on a TTY, and
 * whether a refresh started mid-stream finishes before a short run exits; a run that exits first
 * drops it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import type { Args, Mode } from "@veyyon/coding-agent/cli/args";
import { MODE_VALUES } from "@veyyon/coding-agent/cli/flag-tables";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runRootCommand } from "@veyyon/coding-agent/main";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem, TempDir } from "@veyyon/utils";

/** When a launch starts background model discovery. */
type DiscoveryStart =
	/** After the first response starts streaming: the run's first request is already out. */
	| "after-first-response"
	/** Once the session exists, before the client sends a prompt; protocol clients list models first. */
	| "with-session";

const DISCOVERY_STARTS: Record<Mode, DiscoveryStart> = {
	text: "after-first-response",
	json: "after-first-response",
	rpc: "with-session",
	"rpc-ui": "with-session",
	acp: "with-session",
};

/**
 * What the run records, in order, for each moment. A print run sends two prompts, so starting
 * discovery again on the second response, or before the first request, changes the sequence.
 */
const EXPECTED_TIMELINE: Record<DiscoveryStart, readonly string[]> = {
	"after-first-response": ["request", "discovery", "request"],
	"with-session": ["discovery", "runner"],
};

const MOCK_API_SOURCE = "a-launch-starts-model-discovery-where-it-cannot-delay-the-first-request";
const RUNNER_STOP = "runner holds its session";
/** Process env the protocol modes set for their embedders; an in-process run leaks it otherwise. */
const MODE_ENV_KEYS = ["VEYYON_NO_TITLE", "VEYYON_NO_PTY"] as const;

describe("when a launch starts model discovery", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let savedEnv: Map<string, string | undefined>;
	let savedExitCode: typeof process.exitCode;
	let timeline: string[];

	beforeEach(() => {
		timeline = [];
		savedEnv = new Map(MODE_ENV_KEYS.map(key => [key, process.env[key]]));
		savedExitCode = process.exitCode;
		vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {
			timeline.push("discovery");
		});
		// A print run quits the process once its prompts settle.
		vi.spyOn(postmortem, "quit").mockImplementation(async () => {});
		vi.spyOn(process.stdout, "write").mockImplementation((_chunk, callback) => {
			if (typeof callback === "function") callback();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(MOCK_API_SOURCE);
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		for (const key of MODE_ENV_KEYS) {
			const previous = savedEnv.get(key);
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
		process.exitCode = savedExitCode;
	});

	/** Launch `mode` through `runRootCommand` and return what it recorded. */
	async function launch(mode: Mode): Promise<string[]> {
		tempDir = TempDir.createSync("@veyyon-discovery-start-");
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const auth = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage = auth;
		auth.setRuntimeApiKey("mock", "mock-key");
		registerMockApi(MOCK_API_SOURCE);
		const model = createMockModel({
			handler: () => {
				timeline.push("request");
				return { content: ["ok"] };
			},
		});
		const isPrint = DISCOVERY_STARTS[mode] === "after-first-response";
		const args = {
			mode: mode === "text" ? undefined : mode,
			print: mode === "text",
			messages: isPrint ? ["first prompt", "second prompt"] : [],
			fileArgs: [],
			unknownFlags: new Map(),
			unrecognizedFlags: [],
			noExtensions: true,
			noSkills: true,
			noRules: true,
			noTools: true,
			noLsp: true,
			sessionDir: tempDir.join("sessions"),
		} as Args;
		const stopRunner = (): never => {
			throw new Error(RUNNER_STOP);
		};
		try {
			await runRootCommand(args, [], {
				discoverAuthStorage: async () => auth,
				settings: Settings.isolated({ "compaction.enabled": false }),
				readPipedInput: async () => undefined,
				createAgentSession: options =>
					createAgentSession({
						...options,
						cwd,
						model,
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
					}),
				runRpcMode: async attached => {
					timeline.push("runner");
					await attached.session.dispose();
					return stopRunner();
				},
				runAcpMode: async createAcpSession => {
					const session = await createAcpSession(cwd);
					timeline.push("runner");
					await session.dispose();
					return stopRunner();
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== RUNNER_STOP) throw error;
		}
		return timeline;
	}

	it("records a moment for every launch mode", () => {
		expect(Object.keys(DISCOVERY_STARTS).sort()).toEqual([...MODE_VALUES].sort());
	});

	for (const mode of MODE_VALUES) {
		const start = DISCOVERY_STARTS[mode];
		it(`starts it ${start} in ${mode} mode`, async () => {
			expect(await launch(mode)).toEqual([...EXPECTED_TIMELINE[start]]);
		}, 30_000);
	}
});
