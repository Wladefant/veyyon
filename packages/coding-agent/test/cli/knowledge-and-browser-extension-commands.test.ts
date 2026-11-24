/**
 * Registered CLI behavior of `commands/knowledge.ts` and `commands/browser-extension.ts`, run through
 * the real `cli.ts` entry in a hermetic home. Only refusals and the no-state outputs are asserted:
 * no token is written, read, or printed, and no relay is started.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const cliEntry = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");

interface SpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[]): Promise<SpawnResult> {
	const { home, env, cleanup } = hermeticSpawnEnv();
	try {
		const spawnEnv: Record<string, string | undefined> = {
			...env,
			...(process.platform === "win32" ? { USERPROFILE: home } : {}),
		};
		const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
			env: spawnEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		cleanup();
	}
}

describe("knowledge command through the registered CLI", () => {
	it("refuses an export with neither --out nor --plan", async () => {
		const result = await runCli(["knowledge", "export"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Specify --out for export or --plan for review");
	}, 60_000);

	it("refuses a status with no catalog directory", async () => {
		const result = await runCli(["knowledge", "status"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Must specify catalog directory with --from <dir> or positional argument");
	}, 60_000);

	it("refuses a category outside the knowledge categories before any work starts", async () => {
		const result = await runCli(["knowledge", "apply", "--from", "catalog", "--categories", "bogus"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Invalid --categories value");
	}, 60_000);

	it("fails loudly when verify is pointed at a directory with no catalog", async () => {
		const result = await runCli(["knowledge", "verify", "no-such-catalog"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr.trim().length).toBeGreaterThan(0);
	}, 60_000);
});

describe("browser-extension command through the registered CLI", () => {
	it("reports no stored token and no running relay on a fresh profile", async () => {
		const result = await runCli(["browser-extension", "status"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Token stored: no");
		expect(result.stdout).toContain("Relay: not running");
	}, 60_000);

	it("reports that there was no token to clear and no relay to disconnect", async () => {
		const cleared = await runCli(["browser-extension", "clear-token"]);
		expect(cleared.code).toBe(0);
		expect(cleared.stdout).toContain("No token was stored.");

		const disconnected = await runCli(["browser-extension", "disconnect"]);
		expect(disconnected.code).toBe(0);
		expect(disconnected.stdout).toContain("No relay is running. Nothing is attached.");
	}, 60_000);

	it("stores nothing when set-token reads no token from stdin", async () => {
		const result = await runCli(["browser-extension", "set-token"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("No token was read. Nothing was stored.");
	}, 60_000);

	it("refuses an action it does not define, naming the action", async () => {
		const result = await runCli(["browser-extension", "bogus"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('Unknown action "bogus"');
	}, 60_000);
});
