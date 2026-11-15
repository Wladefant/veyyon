/**
 * WHY THIS SUITE EXISTS.
 *
 * A project's daemon broker must outlive whichever client process happened to spawn it, because
 * other clients and supervised daemons still hold its lease. On Windows, Bun puts non-detached
 * children into a kill-on-close job object owned by the spawning process, so an undetached broker
 * dies the instant its spawner exits even when another client is already connected.
 *
 * Covered: a disposable Bun spawner starts the broker in an isolated runtime, an independent
 * client connects to that broker, and after ONLY the disposable spawner exits, the original
 * broker lease PID remains alive and answers an independent RPC without replacement.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isProcessAlive } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerLeasePath } from "../../src/launch/paths";
import { shutdownBroker } from "../helpers/daemon-broker";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { useTempDirs } from "../helpers/temp-dirs";

const IDLE_GRACE_MS = 30_000;
const makeTempDir = useTempDirs();

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
let cleanupHermeticEnv: (() => void) | undefined;
const cleanupClients: DaemonBrokerClient[] = [];
const cleanupRuntimes: Array<{ projectDir: string; runtimeDir: string }> = [];

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("broker-survives-spawner-exit");
});

afterEach(async () => {
	while (cleanupClients.length > 0) {
		const client = cleanupClients.pop();
		if (client) await shutdownBroker(client);
	}
	while (cleanupRuntimes.length > 0) {
		const entry = cleanupRuntimes.pop();
		if (!entry) continue;
		const hasLease = await fs.stat(daemonBrokerLeasePath(entry.runtimeDir)).then(
			() => true,
			() => false,
		);
		if (!hasLease) continue;
		const fallbackClient = await createDaemonBrokerClient(entry.projectDir, {
			runtimeDir: entry.runtimeDir,
		}).catch(() => undefined);
		if (fallbackClient) await shutdownBroker(fallbackClient);
	}
	cleanupHermeticEnv?.();
	cleanupHermeticEnv = undefined;
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

async function readBrokerLeasePid(runtimeDir: string): Promise<number> {
	const claim: unknown = JSON.parse(await fs.readFile(daemonBrokerLeasePath(runtimeDir), "utf8"));
	if (typeof claim !== "object" || claim === null || !("pid" in claim) || typeof claim.pid !== "number") {
		throw new Error("broker lease holds no pid");
	}
	return claim.pid;
}

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	let text = "";
	while (!text.includes("\n")) {
		const chunk = await reader.read();
		if (chunk.done) {
			throw new Error(`Disposable spawner exited before readiness (received: ${JSON.stringify(text)})`);
		}
		text += new TextDecoder().decode(chunk.value);
	}
	return text.split("\n", 1)[0]!.trim();
}

describe("daemon broker lifetime across spawner exit", () => {
	it("keeps the original broker PID alive and serving after its disposable Bun spawner exits", async () => {
		if (!isolatedConfigRoot) throw new Error("isolatedConfigRoot was not initialized");
		const projectDir = makeTempDir("veyyon-spawner-exit-project-");
		const runtimeDir = makeTempDir("veyyon-spawner-exit-runtime-");
		const scriptDir = makeTempDir("veyyon-spawner-exit-script-");
		cleanupRuntimes.push({ projectDir, runtimeDir });
		const spawnerScript = path.join(scriptDir, "spawner.ts");
		const clientModulePath = path.resolve(import.meta.dir, "../../src/launch/client.ts");

		await Bun.write(
			spawnerScript,
			`import { createDaemonBrokerClient } from ${JSON.stringify(clientModulePath)};

const [projectDir, runtimeDir, idleGraceRaw] = process.argv.slice(2);
const idleGraceMs = Number(idleGraceRaw);
const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs });
const ping = await client.request({ op: "ping" });
if (ping.op !== "ping" || ping.pid === undefined) {
	throw new Error("Expected ping response with broker pid");
}
process.stdout.write(JSON.stringify({ pid: ping.pid }) + "\\n");
for await (const _chunk of Bun.stdin.stream()) {
	// Wait for test harness to close stdin before exiting cleanly.
}
process.exit(0);
`,
		);

		const hermetic = hermeticSpawnEnv();
		cleanupHermeticEnv = hermetic.cleanup;
		const spawnerEnv: Record<string, string | undefined> = {
			...hermetic.env,
			VEYYON_CONFIG_DIR: isolatedConfigRoot.envValue,
		};

		const spawner = Bun.spawn([process.execPath, spawnerScript, projectDir, runtimeDir, String(IDLE_GRACE_MS)], {
			cwd: projectDir,
			env: spawnerEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			timeout: 20_000,
		});

		const stderrPromise = new Response(spawner.stderr).text();
		const reader = spawner.stdout.getReader();
		try {
			let readyLine: string;
			try {
				readyLine = await readLine(reader);
			} catch (error) {
				const stderr = await stderrPromise.catch(() => "");
				throw new Error(`${error instanceof Error ? error.message : String(error)} (stderr: ${stderr})`);
			}
			const parsed: unknown = JSON.parse(readyLine);
			if (typeof parsed !== "object" || parsed === null || !("pid" in parsed) || typeof parsed.pid !== "number") {
				throw new Error(`Unexpected spawner ready payload: ${readyLine}`);
			}
			const originalBrokerPid = parsed.pid;
			expect(await readBrokerLeasePid(runtimeDir)).toBe(originalBrokerPid);
			expect(isProcessAlive(originalBrokerPid)).toBeTrue();

			const independentClient = await createDaemonBrokerClient(projectDir, {
				runtimeDir,
				idleGraceMs: IDLE_GRACE_MS,
			});
			cleanupClients.push(independentClient);
			const preExitPing = await independentClient.request({ op: "ping" });
			expect(preExitPing.op).toBe("ping");
			if (preExitPing.op === "ping") {
				expect(preExitPing.pid).toBe(originalBrokerPid);
			}

			// End ONLY the disposable spawner cleanly so Windows libuv job-object cleanup runs if undetached.
			spawner.stdin.end();
			const exitCode = await spawner.exited;
			expect(exitCode).toBe(0);

			expect(isProcessAlive(originalBrokerPid)).toBeTrue();
			expect(await readBrokerLeasePid(runtimeDir)).toBe(originalBrokerPid);

			const postExitPing = await independentClient.request({ op: "ping" });
			expect(postExitPing.op).toBe("ping");
			if (postExitPing.op === "ping") {
				expect(postExitPing.pid).toBe(originalBrokerPid);
			}
		} finally {
			reader.releaseLock();
			if (spawner.exitCode === null) {
				spawner.kill();
				await spawner.exited;
			}
			await stderrPromise.catch(() => "");
		}
	}, 30_000);
});
