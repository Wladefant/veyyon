/**
 * An export lands in the directory the session is in, and reads its path the way `/move` does.
 *
 * WHY THIS SUITE EXISTS. `/export` resolved its destination against the process working directory.
 * An ACP server holds several sessions and its working directory is at most one of theirs, so a
 * session exported into another project's directory and reported a bare relative file name that
 * located nothing. The terminal also read only the first whitespace-separated word of the argument,
 * so `/export my session.html` wrote a file named `my`, and ACP kept the quotes of
 * `/export "my session.html"` in the file name.
 *
 * THE CLASS. Every surface that exports the open session: each handler the `/export` builtin
 * declares (the terminal's, and the text one ACP and print mode share), and the RPC `export_html`
 * command. Each runs against a real file-backed session while the process working directory is
 * another directory, once without a path and once with a relative path that holds a space. The
 * builtin's surfaces are read from its declaration at run time, so a new one turns this suite red
 * until a row drives it.
 *
 * WHAT IT DOES NOT CATCH. `~` expansion belongs to `resolveToCwd` and is not exercised here, since
 * this suite writes nothing under the home directory. A new RPC command that writes a file is not
 * enumerated. The HTML the export contains is proven in the export suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { handleRpcCommand, type RpcCommandHost } from "@veyyon/coding-agent/modes/rpc/rpc-commands";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { APP_NAME, getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

const REPORTED = "Session exported to: ";

/** What one surface reported after exporting, and anything it showed as a failure. */
interface Outcome {
	reported: string | undefined;
	failures: string[];
}

/** One surface: exports `session` given the `/export` argument text, or the RPC `outputPath`. */
type Surface = (session: AgentSession, input: { args: string; outputPath: string | undefined }) => Promise<Outcome>;

function reportedPath(lines: readonly string[]): string | undefined {
	return lines.find(line => line.startsWith(REPORTED))?.slice(REPORTED.length);
}

/** The `/export` builtin, keyed by the handler each row drives. */
const BUILTIN_SURFACES: Record<string, Surface> = {
	handleTui: async (session, { args }) => {
		const statuses: string[] = [];
		const failures: string[] = [];
		// Opening the browser is the one external effect; the export itself is real.
		vi.spyOn(CommandController.prototype, "openInBrowser").mockImplementation(() => {});
		const controller = new CommandController({
			session,
			sessionManager: session.sessionManager,
			showStatus: (text: string) => statuses.push(text),
			showError: (text: string) => failures.push(text),
		} as unknown as CommandControllerContext);
		const runtime = {
			ctx: {
				collabGuest: undefined,
				editor: { setText: () => {} },
				showWarning: (text: string) => failures.push(text),
				handleExportCommand: (outputPath: string | undefined) => controller.handleExportCommand(outputPath),
			},
		} as unknown as TuiSlashCommandRuntime;
		await executeBuiltinSlashCommand(`/export ${args}`.trimEnd(), runtime);
		return { reported: reportedPath(statuses), failures };
	},
	handle: async (session, { args }) => {
		const output: string[] = [];
		await executeAcpBuiltinSlashCommand(`/export ${args}`.trimEnd(), {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		});
		const reported = reportedPath(output);
		return { reported, failures: reported === undefined ? output : [] };
	},
};

const SURFACES: Record<string, Surface> = {
	...Object.fromEntries(Object.entries(BUILTIN_SURFACES).map(([name, run]) => [`/export (${name})`, run])),
	"RPC export_html": async (session, { outputPath }) => {
		const response = await handleRpcCommand(
			{ type: "export_html", outputPath },
			session,
			{} as unknown as RpcCommandHost,
		);
		if (!response.success) return { reported: undefined, failures: [response.error] };
		const data: unknown = Reflect.get(response, "data");
		const reported = typeof data === "object" && data !== null ? Reflect.get(data, "path") : undefined;
		return { reported: typeof reported === "string" ? reported : undefined, failures: [] };
	},
};

/** An export request, and the file name it must produce in the session's directory. */
interface Case {
	args: string;
	outputPath: string | undefined;
	fileName: (name: string) => boolean;
}

const CASES: Record<string, Case> = {
	"without a path": {
		args: "",
		outputPath: undefined,
		fileName: name => name.startsWith(`${APP_NAME}-session-`) && name.endsWith(".html"),
	},
	"with a relative path that holds a space": {
		args: '"my session.html"',
		outputPath: "my session.html",
		fileName: name => name === "my session.html",
	},
};

describe("an export lands in the directory the session is in", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let originalProjectDir = "";
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("veyyon-export-cwd-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
		const bundled = requireBundledModel("anthropic", "claude-sonnet-4-5");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	beforeEach(() => {
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("veyyon-export-cwd-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
	});

	function makeDir(name: string): string {
		const dir = path.join(tempDir.path(), name);
		fs.mkdirSync(dir, { recursive: true });
		return fs.realpathSync(dir);
	}

	/** A file-backed session in its own directory, with the process working directory elsewhere. */
	function harness(): { session: AgentSession; sessionDir: string; elsewhere: string } {
		const sessionDir = makeDir("project");
		const elsewhere = makeDir("elsewhere");
		const sessionManager = SessionManager.create(sessionDir, makeDir("sessions"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		setProjectDir(elsewhere);
		return { session, sessionDir, elsewhere };
	}

	it("drives every surface the /export builtin declares", () => {
		const command = lookupBuiltinSlashCommand("export");
		const declared = (["handle", "handleTui"] as const).filter(surface => command?.[surface] !== undefined);
		expect(declared).toEqual(["handle", "handleTui"]);
		expect(Object.keys(BUILTIN_SURFACES).sort()).toEqual([...declared].sort());
	});

	for (const [surfaceName, surface] of Object.entries(SURFACES)) {
		for (const [caseName, exportCase] of Object.entries(CASES)) {
			it(`${surfaceName} ${caseName} writes into the session's directory and reports the absolute path`, async () => {
				const { session, sessionDir, elsewhere } = harness();

				const { reported, failures } = await surface(session, exportCase);

				expect(failures).toEqual([]);
				expect(reported).toBeDefined();
				const written = fs.readdirSync(sessionDir);
				expect(written).toHaveLength(1);
				expect(exportCase.fileName(written[0] ?? "")).toBe(true);
				expect(reported).toBe(path.join(sessionDir, written[0] ?? ""));
				expect(fs.readdirSync(elsewhere)).toEqual([]);
			});
		}
	}
});
