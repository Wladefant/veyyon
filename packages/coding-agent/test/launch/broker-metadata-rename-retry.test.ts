import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@veyyon/natives";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { DaemonBroker } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerTokenPath, managedDaemonMetaPath } from "../../src/launch/paths";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.join(os.tmpdir(), "veyyon-launch-rename-retry");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});
let patchedChildren = false;

beforeEach(() => {
	const proto: object = Process.prototype;
	if (!("children" in proto) || typeof Reflect.get(proto, "children") !== "function") {
		Reflect.set(proto, "children", () => []);
		patchedChildren = true;
	}
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-rename-retry");
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

const cleanupDirs: string[] = [];
const cleanupClients: DaemonBrokerClient[] = [];
const cleanupBrokers: { broker: DaemonBroker; run: Promise<void> }[] = [];

afterEach(async () => {
	while (cleanupClients.length > 0) cleanupClients.pop()?.close();
	while (cleanupBrokers.length > 0) {
		const tracked = cleanupBrokers.pop();
		if (!tracked) continue;
		await tracked.broker.shutdown().catch(() => {});
		await tracked.run.catch(() => {});
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
	if (patchedChildren) {
		Reflect.deleteProperty(Process.prototype, "children");
		patchedChildren = false;
	}
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(testRoot, prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function startInProcessBroker(
	projectDir: string,
	runtimeDir: string,
): Promise<{ broker: DaemonBroker; client: DaemonBrokerClient }> {
	const token = "testtoken" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(daemonBrokerTokenPath(runtimeDir), token, { encoding: "utf8", mode: 0o600 });
	const broker = new DaemonBroker(projectDir, runtimeDir, token, 10_000);
	const run = broker.run();
	cleanupBrokers.push({ broker, run });
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
	cleanupClients.push(client);
	return { broker, client };
}

describe("daemon metadata rename retries", () => {
	it("persists terminal state after transient Windows EEXIST/EPERM rename denials without moving target aside", async () => {
		const projectDir = await tempDir("project-");
		const runtimeDir = await tempDir("runtime-");
		const metadataPath = managedDaemonMetaPath(path.join(runtimeDir, "daemons", "rename"));
		const { client } = await startInProcessBroker(projectDir, runtimeDir);

		const realRename = fs.rename;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		let denials = 0;
		let targetMovedAside = false;
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (String(source) === metadataPath) {
				targetMovedAside = true;
			}
			if (
				denials < 2 &&
				String(target) === metadataPath &&
				(await fs.readFile(String(source), "utf8")).includes('"state":"exited"')
			) {
				Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
				const code = denials++ === 0 ? "EEXIST" : "EPERM";
				throw Object.assign(new Error(`rename denied by reader (${code})`), { code });
			}
			return realRename(source, target);
		});

		try {
			await client.request({
				op: "start",
				spec: {
					name: "rename",
					application: process.execPath,
					args: ["-e", "process.exit(0)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const waited = await client.request({ op: "wait", name: "rename", for: "exit", timeoutMs: 10_000 });
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.daemon.state).toBe("exited");
			// Wait for the broker's persistQueue to flush before inspecting meta.json on disk.
			await client.request({ op: "shutdown" });
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			renameSpy.mockRestore();
		}

		expect(denials).toBe(2);
		expect(targetMovedAside).toBe(false);
		expect(await Bun.file(metadataPath).json()).toMatchObject({ daemon: { state: "exited" } });
	}, 20_000);
});
