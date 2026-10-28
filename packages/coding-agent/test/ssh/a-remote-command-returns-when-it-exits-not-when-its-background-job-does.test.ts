/**
 * WHY: `ssh host 'cd dir && nohup job > log 2>&1 &'` returns only when the channel closes, and the
 * channel stays open while any remote process holds the command's stdout or stderr. The `&` there
 * backgrounds the whole `&&` list in a subshell that keeps both, so the ssh tool sat until its
 * timeout, reported the launch as cancelled, and held every other tool call behind it. The class is
 * every way a background process can hold the output: an and-or list, a pipeline, a subshell, a
 * brace group, a bare command, one holding stderr only, and a command that moved its own stdout or
 * exited early.
 *
 * The suite runs the remote command under real local POSIX shells in place of `$SHELL -c` on the
 * remote, so a backgrounded process holds the output pipe the way it holds the ssh channel. It does
 * not run sshd or the OpenSSH client: that the client exits once killed, closing the session, is
 * shown by a real-host run, not here. zsh runs only where it is installed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SSHHostInfo, SSHHostOs, SSHHostShell } from "@veyyon/coding-agent/ssh/connection-manager";
import * as connectionManager from "@veyyon/coding-agent/ssh/connection-manager";
import { executeSSH } from "@veyyon/coding-agent/ssh/ssh-executor";
import * as sshfsMount from "@veyyon/coding-agent/ssh/sshfs-mount";
import { $which, type ChildProcess, ptree, TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const realSpawn = ptree.spawn;
const HOST = { name: "remote", host: "remote" };
/** Longer than the call's timeout, so a call that waits for the job is cancelled instead of returning. */
const JOB_SECONDS = 9;
const CALL_TIMEOUT_MS = 6_000;
/** The grace after the marker plus process start, far under the timeout. */
const RETURN_BOUND_MS = 3_000;

/** Which login shells receive the exit marker; a new shell fails to compile until it is decided here. */
const SHELL_REPORTS_EXIT: Record<SSHHostShell, boolean> = {
	bash: true,
	zsh: true,
	sh: true,
	cmd: false,
	powershell: false,
	unknown: false,
};
const OS_REPORTS_EXIT: Record<SSHHostOs, boolean> = { linux: true, macos: true, unknown: true, windows: false };

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

function hostInfo(os: SSHHostOs, shell: SSHHostShell): SSHHostInfo {
	return { version: 4, os, shell, compatEnabled: false };
}

function mockConnection(os: SSHHostOs, shell: SSHHostShell): void {
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(hostInfo(os, shell));
	vi.spyOn(connectionManager, "buildRemoteCommand").mockImplementation(async (_host, command) => [command]);
	vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
}

/** Runs each command the executor would send over ssh under `shellPath -c`, as sshd runs `$SHELL -c`. */
function runRemoteUnder(shellPath: string, shell: SSHHostShell, os: SSHHostOs = "linux"): string[] {
	const sent: string[] = [];
	mockConnection(os, shell);
	vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>(argv: string[]) => {
		const command = argv[argv.length - 1];
		sent.push(command);
		return realSpawn([shellPath, "-c", command], {
			timeout: CALL_TIMEOUT_MS,
			stdin: "pipe",
			stderr: "full",
		}) as unknown as ChildProcess<In>;
	});
	return sent;
}

const POSIX_SHELLS = (["sh", "bash", "zsh"] as const)
	.map(shell => ({ shell, path: $which(shell) }))
	.filter((entry): entry is { shell: "sh" | "bash" | "zsh"; path: string } => entry.path !== null);

/**
 * Every shape that leaves a background process holding stdout or stderr after the command exits.
 * `only` limits a shape to the shell where it holds: dash runs the last command of a backgrounded
 * list in place of the list's subshell, so the reported shape releases the output there.
 */
const HOLDERS: { name: string; command: string; output: string; exitCode: number; only?: SSHHostShell }[] = [
	{
		name: "the reported and-or list",
		command: `cd / && sleep ${JOB_SECONDS} > /dev/null 2>&1 < /dev/null & echo started`,
		output: "started\n",
		exitCode: 0,
		only: "bash",
	},
	{
		name: "an and-or list",
		command: `cd / && sleep ${JOB_SECONDS} > /dev/null 2>&1 < /dev/null && true & echo started`,
		output: "started\n",
		exitCode: 0,
	},
	{
		name: "a pipeline",
		command: `sleep ${JOB_SECONDS} | cat > /dev/null & echo started`,
		output: "started\n",
		exitCode: 0,
	},
	{ name: "a subshell", command: `(sleep ${JOB_SECONDS}) & echo started`, output: "started\n", exitCode: 0 },
	{ name: "a brace group", command: `{ sleep ${JOB_SECONDS}; } & echo started`, output: "started\n", exitCode: 0 },
	{ name: "a bare command", command: `sleep ${JOB_SECONDS} & echo started`, output: "started\n", exitCode: 0 },
	{
		name: "a command holding stderr only",
		command: `sleep ${JOB_SECONDS} > /dev/null & echo started`,
		output: "started\n",
		exitCode: 0,
	},
	{
		name: "a command that exits early",
		command: `sleep ${JOB_SECONDS} & echo started; exit 3`,
		output: "started\n",
		exitCode: 3,
	},
	{
		name: "a command that moved its own stdout",
		command: `echo started; exec > /dev/null; sleep ${JOB_SECONDS} &`,
		output: "started\n",
		exitCode: 0,
	},
	{
		name: "a command with its own EXIT trap",
		command: `trap 'echo cleanup' EXIT; sleep ${JOB_SECONDS} & echo started`,
		output: "started\ncleanup\n",
		exitCode: 0,
	},
];

/** Commands with no background process: the output and status come back exactly as the shell produced them. */
const PLAIN: { name: string; command: string; output: string; exitCode: number }[] = [
	{ name: "a trailing newline", command: "echo out", output: "out\n", exitCode: 0 },
	{ name: "no trailing newline", command: "printf 'a\\nb'", output: "a\nb", exitCode: 0 },
	{ name: "no output", command: "true", output: "", exitCode: 0 },
	{ name: "a failing last command", command: "echo out; false", output: "out\n", exitCode: 1 },
	{ name: "an explicit exit", command: "echo out; exit 255", output: "out\n", exitCode: 255 },
	{ name: "errexit", command: "set -e; false; echo unreached", output: "", exitCode: 1 },
	{ name: "a heredoc as the last line", command: "cat <<EOF\nbody\nEOF", output: "body\n", exitCode: 0 },
	{ name: "a trailing comment", command: "echo out # note", output: "out\n", exitCode: 0 },
	{ name: "a leading subshell", command: "(echo nested; exit 4)", output: "nested\n", exitCode: 4 },
	{
		name: "a record separator and a cut-off marker prefix (the sink drops the separators)",
		command: "printf 'a\\036b\\036__veyyon_exit_'",
		output: "ab__veyyon_exit_",
		exitCode: 0,
	},
];

describe("an ssh command returns when it exits, not when its background job does", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs the sweep under sh and bash at least", () => {
		expect(POSIX_SHELLS.map(entry => entry.shell)).toEqual(expect.arrayContaining(["sh", "bash"]));
	});

	for (const { shell, path: shellPath } of POSIX_SHELLS) {
		it(`returns at the command's exit under ${shell} whatever holds the output`, async () => {
			runRemoteUnder(shellPath, shell);
			const results = await Promise.all(
				HOLDERS.filter(holder => holder.only === undefined || holder.only === shell).map(async holder => {
					const started = performance.now();
					const result = await executeSSH(HOST, holder.command, { timeout: CALL_TIMEOUT_MS });
					return { holder, result, elapsedMs: performance.now() - started };
				}),
			);
			for (const { holder, result, elapsedMs } of results) {
				expect({ name: holder.name, cancelled: result.cancelled, exitCode: result.exitCode }).toEqual({
					name: holder.name,
					cancelled: false,
					exitCode: holder.exitCode,
				});
				expect(elapsedMs).toBeLessThan(RETURN_BOUND_MS);
				const [notice, ...rest] = result.output.split("\n");
				expect(notice).toStartWith("[SSH: The command exited while a background process still held its output");
				expect(rest.join("\n")).toBe(holder.output);
			}
		}, 30_000);

		it(`returns output and status byte-exact under ${shell} when nothing is left behind`, async () => {
			runRemoteUnder(shellPath, shell);
			for (const plain of PLAIN) {
				const result = await executeSSH(HOST, plain.command, { timeout: CALL_TIMEOUT_MS });
				expect({ name: plain.name, output: result.output, exitCode: result.exitCode }).toEqual({
					name: plain.name,
					output: plain.output,
					exitCode: plain.exitCode,
				});
			}
		}, 30_000);

		it(`leaves a job with redirected output running after the call returns under ${shell}`, async () => {
			runRemoteUnder(shellPath, shell);
			using dir = TempDir.createSync("@ssh-detach-");
			const done = path.join(dir.path(), "done");
			const result = await executeSSH(
				HOST,
				`cd / && (sleep 1; echo done > '${done}') > /dev/null 2>&1 < /dev/null & echo started`,
				{ timeout: CALL_TIMEOUT_MS },
			);
			expect(result.exitCode).toBe(0);
			expect(fs.existsSync(done)).toBe(false);
			const deadline = Date.now() + 5_000;
			while (!fs.existsSync(done) && Date.now() < deadline) await sleep(50);
			expect(fs.readFileSync(done, "utf8")).toBe("done\n");
		}, 30_000);
	}

	it("sends the command verbatim to a login shell that cannot parse the marker", async () => {
		for (const os of Object.keys(OS_REPORTS_EXIT) as SSHHostOs[]) {
			for (const shell of Object.keys(SHELL_REPORTS_EXIT) as SSHHostShell[]) {
				const sent = runRemoteUnder("/bin/sh", shell, os);
				await executeSSH(HOST, "echo out", { timeout: CALL_TIMEOUT_MS });
				const wrapped = sent[0] !== "echo out";
				expect({ os, shell, wrapped }).toEqual({
					os,
					shell,
					wrapped: OS_REPORTS_EXIT[os] && SHELL_REPORTS_EXIT[shell],
				});
				vi.restoreAllMocks();
			}
		}
	});
});

/**
 * The marker reaches the executor cut wherever the transport cuts it. A remote that never closes the
 * session isolates the stripping: the status can only come from the marker, and the output only from
 * what the stripping lets through. A remote that closes the session part way into a marker shows
 * that the bytes held back as a possible marker still come back.
 */
describe("the exit marker is removed wherever the output is cut", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * `pieces` receives the call's token and the command, so concurrent calls can each cut differently.
	 * With `sessionExit` the session closes after the pieces with that status; without it, it stays open.
	 */
	function spawnRemote(pieces: (token: string, command: string) => Uint8Array[], sessionExit?: number): void {
		mockConnection("linux", "bash");
		vi.spyOn(ptree, "spawn").mockImplementation(<In extends TestStdin>(argv: string[]) => {
			const remote = argv[argv.length - 1];
			const token = /__veyyon_exit_ ([0-9a-f]{16})/.exec(remote)?.[1];
			const command = /^\( (.*)\n\)\n/.exec(remote)?.[1];
			if (!token || command === undefined) throw new Error(`no exit marker in ${remote}`);
			const chunks = pieces(token, command);
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(chunk);
						if (sessionExit !== undefined) controller.close();
					},
				}),
				stderr: undefined,
				exited: sessionExit === undefined ? Promise.withResolvers<number>().promise : Promise.resolve(sessionExit),
				[Symbol.dispose]() {},
			} as unknown as ChildProcess<In>;
		});
	}

	const encoder = new TextEncoder();
	/** Output around the marker, including text the stripping must pass through untouched. */
	const before = (token: string) =>
		`echo of the command: __veyyon_exit_ ${token}\n\u001e__veyyon_exit_${token}X\npartial`;
	/** `before` as the output sink shows it, with the record separator dropped. */
	const shown = (token: string) => `echo of the command: __veyyon_exit_ ${token}\n__veyyon_exit_${token}X\npartial`;
	const after = "late output from a background job\n";

	it("at every byte boundary", async () => {
		const tokens = new Map<number, string>();
		const stream = (token: string) => encoder.encode(`${before(token)}\u001e__veyyon_exit_${token}:7\n${after}`);
		spawnRemote((token, command) => {
			const cut = Number(command);
			tokens.set(cut, token);
			const bytes = stream(token);
			return [bytes.subarray(0, cut), bytes.subarray(cut)];
		});
		// Every token has the same length, so any one sizes the sweep.
		const length = stream("0".repeat(16)).length;
		const cuts = Array.from({ length: length + 1 }, (_, cut) => cut);
		const results = await Promise.all(cuts.map(cut => executeSSH(HOST, String(cut), { timeout: CALL_TIMEOUT_MS })));
		const seen = results.map((result, cut) => ({
			cut,
			exitCode: result.exitCode,
			body: result.output.slice(result.output.indexOf("\n") + 1),
		}));
		expect(seen).toEqual(cuts.map(cut => ({ cut, exitCode: 7, body: `${shown(tokens.get(cut) ?? "")}${after}` })));
	}, 30_000);

	it("one byte at a time", async () => {
		let token = "";
		spawnRemote(t => {
			token = t;
			const bytes = encoder.encode(`${before(t)}\u001e__veyyon_exit_${t}:255\n${after}`);
			return Array.from(bytes, byte => Uint8Array.of(byte));
		});
		const result = await executeSSH(HOST, "job", { timeout: CALL_TIMEOUT_MS });
		expect(result.exitCode).toBe(255);
		expect(result.output.slice(result.output.indexOf("\n") + 1)).toBe(`${shown(token)}${after}`);
	});

	it("returns the start of a marker the session closed in the middle of", async () => {
		const prefixes = new Map<number, string>();
		spawnRemote((token, command) => {
			const prefix = `\u001e__veyyon_exit_${token}:25`.slice(0, Number(command));
			prefixes.set(Number(command), prefix);
			return [encoder.encode(`out\n${prefix}`)];
		}, 255);
		const lengths = Array.from({ length: `\u001e__veyyon_exit_${"0".repeat(16)}:25`.length }, (_, i) => i + 1);
		const results = await Promise.all(lengths.map(n => executeSSH(HOST, String(n), { timeout: CALL_TIMEOUT_MS })));
		expect(
			results.map((result, i) => ({ length: lengths[i], exitCode: result.exitCode, output: result.output })),
		).toEqual(
			lengths.map(length => ({
				length,
				exitCode: 255,
				output: `out\n${(prefixes.get(length) ?? "").replace("\u001e", "")}`,
			})),
		);
	});
});
