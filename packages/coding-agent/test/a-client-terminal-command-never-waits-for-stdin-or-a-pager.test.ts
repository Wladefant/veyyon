/**
 * A command run on an ACP client terminal never waits for stdin or a pager.
 *
 * WHY THIS SUITE EXISTS (issue #565). The local executor closes stdin and applies the
 * non-interactive environment. The ACP `terminal/create` path did neither: it sent the bare
 * command and no environment, so the client spawned it with its own open stdin pipe and its own
 * PAGER. A command that reads stdin or launches a pager then waited on a pipe nobody writes.
 *
 * The suite drives the real BashTool through a terminal bridge that spawns the real selected
 * shell. The bridge keeps the child's stdin an OPEN pipe it never closes, the state a real client
 * leaves it in, and seeds hostile PAGER and GH_PAGER into its own environment. A pre-fix build
 * therefore hangs on the stdin reader and launches the hostile pager, and the elapsed bound
 * fails it. Assertions read the child's own output, not a spy on what was forwarded.
 *
 * GAP THIS DOES NOT CLOSE: the children are portable Bun script fixtures that stand in for the
 * undocumented `gh` and python commands from the report. They reproduce the stdin and pager
 * mechanics, not the exact command that first hung. Only a run against a real client terminal
 * covers that command.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import type {
	ClientBridge,
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
} from "@veyyon/kernel/session/client-bridge";
import type { ShellConfig } from "@veyyon/utils/procmgr";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";

useIsolatedGlobalSettings();

/** A pager the client inherits that does not exist. A pre-fix child that launches it fails loudly. */
const HOSTILE_PAGER = "veyyon-hostile-pager-must-not-run";
/** Upper bound on any single command. A child that waits for stdin blows past it. */
const ELAPSED_BOUND_MS = 5_000;
/** Backstop passed to the bash tool. A hang the bound misses still ends here, not forever. */
const COMMAND_TIMEOUT_S = 10;

const STDIN_CONSUMER = `let bytes = 0;
for await (const chunk of process.stdin) bytes += chunk.length;
process.stdout.write(\`STDIN_BYTES=\${bytes}\\n\`);
`;

const PAGER_LAUNCHER = `import { spawn } from "node:child_process";
const key = process.argv[2];
const pager = process.env[key] ?? "";
const child = spawn(pager, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
child.stdin.on("error", () => {});
let out = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => { out += chunk; });
child.on("error", err => {
	process.stdout.write(\`PAGER_LAUNCH_FAILED[\${key}]=\${err.code}\\n\`);
	process.exitCode = 1;
});
child.on("close", () => {
	process.stdout.write(\`PAGER_OUT[\${key}]=\${out.trim()}\\n\`);
});
child.stdin.end(\`input-for-\${key}\\n\`);
`;

interface FixtureDir {
	dir: string;
	consumer: string;
	launcher: string;
	redirectInput: string;
}

let fixtures: FixtureDir;
let shellConfig: ShellConfig;

beforeAll(async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-noninteractive-"));
	const consumer = path.join(dir, "stdin-consumer.mjs");
	const launcher = path.join(dir, "pager-launcher.mjs");
	const redirectInput = path.join(dir, "redirect-input.txt");
	await fs.writeFile(consumer, STDIN_CONSUMER);
	await fs.writeFile(launcher, PAGER_LAUNCHER);
	await fs.writeFile(redirectInput, "redirect-payload");
	fixtures = { dir, consumer, launcher, redirectInput };
	shellConfig = (await Settings.init()).getShellConfig();
});

afterAll(async () => {
	await removeWithRetries(fixtures.dir);
});

interface ClientTerminalFixture {
	bridge: ClientBridge;
	live: Set<ChildProcess>;
}

/**
 * A terminal bridge that spawns what `terminal/create` asks for, the way an ACP client does.
 * Its stdin is an open pipe it never closes. Its base environment carries hostile pagers, and
 * the request's env entries overlay that base, as a client applies them.
 */
function makeClientTerminal(): ClientTerminalFixture {
	const live = new Set<ChildProcess>();
	let nextId = 0;

	const bridge: ClientBridge = {
		capabilities: { terminal: true },
		async createTerminal(params): Promise<ClientBridgeTerminalHandle> {
			const env: NodeJS.ProcessEnv = { ...process.env, PAGER: HOSTILE_PAGER, GH_PAGER: HOSTILE_PAGER };
			for (const entry of params.env ?? []) env[entry.name] = entry.value;

			const child = spawn(params.command, params.args ?? [], {
				cwd: params.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			live.add(child);
			const { stdin, stdout, stderr } = child;
			if (!stdout || !stderr) throw new Error("terminal child did not expose stdout and stderr");
			stdout.setEncoding("utf8");
			stderr.setEncoding("utf8");

			let output = "";
			stdout.on("data", chunk => {
				output += chunk;
			});
			stderr.on("data", chunk => {
				output += chunk;
			});
			const stdoutClosed = Promise.withResolvers<void>();
			const stderrClosed = Promise.withResolvers<void>();
			stdout.once("close", () => stdoutClosed.resolve());
			stderr.once("close", () => stderrClosed.resolve());
			const streamsDone = Promise.all([stdoutClosed.promise, stderrClosed.promise]);
			const exited = Promise.withResolvers<ClientBridgeTerminalExitStatus>();
			child.once("error", err => exited.reject(err));
			child.once("exit", (exitCode, signal) => exited.resolve({ exitCode, signal }));

			let exitStatus: ClientBridgeTerminalExitStatus | null = null;
			const stop = (): void => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				stdin?.destroy();
				live.delete(child);
			};

			nextId += 1;
			return {
				terminalId: `term-${nextId}`,
				async waitForExit() {
					const status = await exited.promise;
					await streamsDone;
					exitStatus = status;
					return status;
				},
				async currentOutput() {
					return { output, truncated: false, exitStatus };
				},
				async kill() {
					stop();
				},
				async release() {
					stop();
				},
			};
		},
	};
	return { bridge, live };
}

let active: ClientTerminalFixture | undefined;

afterEach(() => {
	// Kill everything a failing test left running, so no child outlives the suite.
	if (!active) return;
	for (const child of active.live) {
		child.stdin?.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	active.live.clear();
	active = undefined;
});

function makeSession(terminal: ClientTerminalFixture) {
	return makeToolSession({
		cwd: fixtures.dir,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "acp-noninteractive",
		allocateOutputArtifact: async (kind: string) => ({
			id: `${kind}-1`,
			path: path.join(fixtures.dir, `${kind}-1.txt`),
		}),
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bashInterceptor.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules: () => [],
			getShellConfig: () => shellConfig,
		},
		getClientBridge: () => terminal.bridge,
	});
}

/** A shell-safe word for a path. Backslashes become slashes so Git Bash on Windows reads them. */
function shellWord(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
}

/** Run a Bun script fixture through the same runtime that runs this suite. */
function bunScript(script: string, ...args: string[]): string {
	return [process.execPath, script, ...args].map(shellWord).join(" ");
}

/** Run `command` on the client terminal and return its output text and elapsed time. */
async function runOnClientTerminal(
	id: string,
	command: string,
	env?: Record<string, string>,
): Promise<{ text: string; elapsedMs: number }> {
	const terminal = makeClientTerminal();
	active = terminal;
	const started = performance.now();
	const result = await new BashTool(makeSession(terminal)).execute(id, {
		command,
		timeout: COMMAND_TIMEOUT_S,
		...(env ? { env } : {}),
	});
	const elapsedMs = performance.now() - started;
	const text = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	return { text, elapsedMs };
}

describe("a command on a client terminal gets an end of stdin unless it asks for input", () => {
	/**
	 * The core regression. The adapter's stdin is an open pipe nobody writes. Before the fix the
	 * child inherited that pipe and blocked until the timeout. The elapsed bound is the real
	 * assertion: output alone would still pass after a full-timeout wait.
	 */
	it("finishes a child that reads stdin to EOF without waiting", async () => {
		const { text, elapsedMs } = await runOnClientTerminal("stdin-eof", bunScript(fixtures.consumer));
		expect(text).toContain("STDIN_BYTES=0");
		expect(elapsedMs).toBeLessThan(ELAPSED_BOUND_MS);
	});

	/**
	 * The wrapper changes the stdin contract, so an explicit `< file` must still reach the child.
	 * Otherwise closing stdin on the group would silently discard the file.
	 */
	it("still delivers a file named by an input redirect", async () => {
		const { text, elapsedMs } = await runOnClientTerminal(
			"stdin-redirect",
			`${bunScript(fixtures.consumer)} < ${shellWord(fixtures.redirectInput)}`,
		);
		expect(text).toContain("STDIN_BYTES=16");
		expect(elapsedMs).toBeLessThan(ELAPSED_BOUND_MS);
	});

	/** A heredoc overrides the group's stdin. Its body must arrive intact. */
	it("still delivers a heredoc body", async () => {
		const { text, elapsedMs } = await runOnClientTerminal(
			"stdin-heredoc",
			`${bunScript(fixtures.consumer)} <<'EOF'\nhello\nEOF`,
		);
		expect(text).toContain("STDIN_BYTES=6");
		expect(elapsedMs).toBeLessThan(ELAPSED_BOUND_MS);
	});

	/** A pipeline feeds its consumer from the upstream command, not from the group's `/dev/null`. */
	it("still delivers the output of an upstream pipeline stage", async () => {
		const { text, elapsedMs } = await runOnClientTerminal(
			"stdin-pipeline",
			`printf 'abc' | ${bunScript(fixtures.consumer)}`,
		);
		expect(text).toContain("STDIN_BYTES=3");
		expect(elapsedMs).toBeLessThan(ELAPSED_BOUND_MS);
	});
});

describe("a command on a client terminal runs with the non-interactive environment", () => {
	/**
	 * A pager launched by the command must be `cat`, not the hostile inherited value. A pre-fix
	 * build sends no env, so the launcher spawns the missing hostile name and reports the failure.
	 */
	it("launches PAGER and GH_PAGER as cat, not the hostile inherited pager", async () => {
		const { text, elapsedMs } = await runOnClientTerminal(
			"pager",
			`${bunScript(fixtures.launcher, "PAGER")}; ${bunScript(fixtures.launcher, "GH_PAGER")}`,
		);
		expect(text).toContain("PAGER_OUT[PAGER]=input-for-PAGER");
		expect(text).toContain("PAGER_OUT[GH_PAGER]=input-for-GH_PAGER");
		expect(text).not.toContain("PAGER_LAUNCH_FAILED");
		expect(elapsedMs).toBeLessThan(ELAPSED_BOUND_MS);
	});

	/** A caller's explicit env must still beat the non-interactive default. */
	it("lets a caller env override beat the non-interactive default", async () => {
		const { text } = await runOnClientTerminal("override", `echo "PAGER=[$PAGER]"`, {
			PAGER: "sentinel-pager-override",
		});
		expect(text).toContain("PAGER=[sentinel-pager-override]");
	});
});
