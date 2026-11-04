/**
 * WHY: the ssh tool ran a command with a `cwd` as `cd -- '<cwd>' && <command>`. `&&` binds the
 * directory change to the first and-or list only, so a `;`, `&` or newline later in the command ran
 * the rest outside `cwd`, and after a failed `cd`, in the login directory: a session's
 * `set -e; touch …; cargo test` ran `touch` and `cargo` in the remote home when the cwd was missing.
 * The class is every top-level separator after which a part of the command can escape the directory
 * change, under every login shell the prefix reaches: the exit-marker shells, a shell without the
 * marker, and Windows compat shells.
 *
 * The suite runs the tool's real command composition and the real executor, with local POSIX shells
 * in place of the remote login shell, started in a directory standing in for the remote home. It does
 * not cover native Windows `cmd` and PowerShell prefixes.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as discovery from "@veyyon/coding-agent/discovery";
import type { SSHHost } from "@veyyon/coding-agent/discovery/capability/ssh";
import type { SSHHostInfo } from "@veyyon/coding-agent/ssh/connection-manager";
import * as connectionManager from "@veyyon/coding-agent/ssh/connection-manager";
import * as sshfsMount from "@veyyon/coding-agent/ssh/sshfs-mount";
import { loadSshTool } from "@veyyon/coding-agent/tools/shell/ssh";
import { $which, type ChildProcess, ptree, TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedAgentDir({ globalSettings: true });

const realSpawn = ptree.spawn;
const HOST: SSHHost = {
	name: "remote",
	host: "remote.example.com",
	_source: { provider: "test", providerName: "Test", path: "/dev/null", level: "user" },
};

type TestStdin = "pipe" | "ignore" | Buffer | Uint8Array | null;

/** One part of the command after each top-level separator: `&`, `;`, a newline, `||` and a pipeline. */
const COMMAND = "touch one & wait; touch two\ntouch three\nfalse || touch four\ntouch five | cat";
const FILES = ["five", "four", "one", "three", "two"];

const sh = $which("sh");
const bash = $which("bash");
const zsh = $which("zsh");

/** The login shell each host info stands for, run locally in its place. */
const LOGINS: { name: string; info: SSHHostInfo; login: string | null }[] = [
	{ name: "bash", info: { version: 4, os: "linux", shell: "bash", compatEnabled: false }, login: bash },
	{ name: "sh", info: { version: 4, os: "linux", shell: "sh", compatEnabled: false }, login: sh },
	{ name: "zsh", info: { version: 4, os: "macos", shell: "zsh", compatEnabled: false }, login: zsh },
	{
		name: "a shell without the exit marker",
		info: { version: 4, os: "linux", shell: "unknown", compatEnabled: false },
		login: sh,
	},
	{
		name: "Windows compat bash",
		info: { version: 4, os: "windows", shell: "cmd", compatShell: "bash", compatEnabled: true },
		login: bash === null ? null : sh,
	},
	{
		name: "Windows compat sh",
		info: { version: 4, os: "windows", shell: "powershell", compatShell: "sh", compatEnabled: true },
		login: sh,
	},
];

function remoteRunsIn(home: string, info: SSHHostInfo, login: string): void {
	vi.spyOn(discovery, "loadCapability").mockResolvedValue({
		items: [HOST],
		all: [HOST],
		warnings: [],
		providers: ["test"],
	});
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue(info);
	vi.spyOn(connectionManager, "buildRemoteCommand").mockImplementation(async (_host, command) => [command]);
	vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
	vi.spyOn(ptree, "spawn").mockImplementation(
		<In extends TestStdin>(argv: string[]) =>
			realSpawn([login, "-c", argv[argv.length - 1]], {
				cwd: home,
				timeout: 10_000,
				stdin: "pipe",
				stderr: "full",
			}) as unknown as ChildProcess<In>,
	);
}

async function runTool(cwd: string) {
	const tool = await loadSshTool(makeToolSession({ cwd: "/tmp" }));
	if (!tool) throw new Error("expected SSH tool");
	return tool.execute("call", { host: HOST.name, command: COMMAND, cwd });
}

describe("a remote command with a cwd runs wholly in that directory, or not at all", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("covers sh and bash at least", () => {
		expect(LOGINS.filter(entry => entry.login !== null).map(entry => entry.name)).toEqual(
			expect.arrayContaining(["bash", "sh", "a shell without the exit marker", "Windows compat sh"]),
		);
	});

	for (const { name, info, login } of LOGINS) {
		if (login === null) continue;

		it(`runs every part of the command in the cwd under ${name}`, async () => {
			using home = TempDir.createSync("@ssh-home-");
			using work = TempDir.createSync("@ssh-cwd-");
			remoteRunsIn(home.path(), info, login);
			await runTool(work.path());
			expect({ cwd: fs.readdirSync(work.path()).sort(), home: fs.readdirSync(home.path()) }).toEqual({
				cwd: FILES,
				home: [],
			});
		});

		it(`runs no part of the command when the cwd is missing under ${name}`, async () => {
			using home = TempDir.createSync("@ssh-home-");
			using work = TempDir.createSync("@ssh-cwd-");
			remoteRunsIn(home.path(), info, login);
			await expect(runTool(path.join(work.path(), "missing"))).rejects.toThrow(/exited with code [1-9]/);
			expect({ cwd: fs.readdirSync(work.path()), home: fs.readdirSync(home.path()) }).toEqual({ cwd: [], home: [] });
		});
	}
});
