/**
 * WHY: a launch name stopped answering once its process had exited and the broker had purged
 * the live record. `stop`, `describe`, `logs`, `wait`, `send` and `restart` looked up the live
 * record alone and threw `Unknown daemon <name>` once the cleanup wait (15 minutes by default)
 * had passed, while `list` still showed the same name under "Recently completed". Stopping or
 * describing a detached process that had finished by itself failed every time.
 *
 * The class this closes: every name-addressed op of the launch tool, read off the schema the
 * tool publishes, answers for a purged name the way it answered for the same exited generation
 * before the purge, for a clean exit and for a persistent process that failed. A new op turns the
 * suite red until the decision table records what it answers. The suite drives the real
 * `LaunchTool` against a real broker process; nothing on the path is stubbed.
 *
 * What it does not catch: `logs` after the purge holds only the retained tail (40 lines, 4000
 * bytes), so a longer output reads shorter than it did before the purge; a name whose record has
 * left the store (100 records or 24 hours) is unknown again; and the snapshot rebuilt from a
 * completion has no `readyAt` or `readyMatch`, which no op renders for a finished process.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { closeDaemonClients, createDaemonBrokerClient } from "@veyyon/coding-agent/launch/client";
import { daemonCompletionsPath } from "@veyyon/coding-agent/launch/paths";
import { resetLaunchExitWatchesForTests } from "@veyyon/coding-agent/tools/shell/launch-exit-watch";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { type LaunchParams, LaunchTool, type LaunchToolDetails } from "../../src/tools/shell/launch";
import { makeToolSession } from "../helpers/tool-session";

const CLEANUP_WAIT_MS = 4_000;

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const cleanupDirs: string[] = [];

beforeAll(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-purged-name");
});

afterAll(() => {
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

afterEach(async () => {
	await closeDaemonClients();
	resetLaunchExitWatchesForTests();
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

/** What one tool call returned: its text, or the message it failed with. */
type Answer = { text: string } | { error: string };

interface Decision {
	/** The calls whose answers must match before and after the purge. */
	calls(name: string): LaunchParams[];
	/** Strips what differs between two launches of one spec; absent means the answers match byte for byte. */
	normalize?(text: string): string;
}

/**
 * Every name-addressed op and what it must answer for a purged name. `restart` launches a new
 * generation each time, so its pid and uptime differ and are stripped before comparing.
 */
const DECISIONS: Record<string, Decision> = {
	describe: { calls: name => [{ op: "describe", name }] },
	logs: {
		calls: name => [
			{ op: "logs", name },
			{ op: "logs", name, lines: 2 },
			{ op: "logs", name, head: true, lines: 1 },
			{ op: "logs", name, grep: "MARKER" },
			{ op: "logs", name, follow: true, timeout: 0.05 },
		],
	},
	wait: {
		calls: name => [
			{ op: "wait", name, for: "exit" },
			{ op: "wait", name, for: "ready", timeout: 0.05 },
			{ op: "wait", name, pattern: "beta \\w+", timeout: 0.05 },
			{ op: "wait", name, pattern: "never printed", timeout: 0.05 },
		],
	},
	send: { calls: name => [{ op: "send", name, text: "input" }] },
	stop: { calls: name => [{ op: "stop", name }] },
	restart: {
		calls: name => [{ op: "restart", name }],
		normalize: text => text.replace(/ pid=\d+/, "").replace(/ uptime=\S+/, ""),
	},
};

/** Every op the launch tool accepts, read off its published schema; throws rather than sweep nothing. */
function opsAcceptedBy(tool: LaunchTool): string[] {
	const schema: unknown = tool.parameters.toJsonSchema();
	if (!schema || typeof schema !== "object" || !("properties" in schema)) {
		throw new Error("launch schema exposes no properties");
	}
	const properties: unknown = schema.properties;
	if (!properties || typeof properties !== "object" || !("op" in properties)) {
		throw new Error("launch schema exposes no op property");
	}
	const op: unknown = properties.op;
	if (!op || typeof op !== "object") throw new Error("launch op has no schema");
	if ("enum" in op && Array.isArray(op.enum)) return op.enum.map(String);
	if ("anyOf" in op && Array.isArray(op.anyOf)) {
		return op.anyOf.map(member => {
			if (!member || typeof member !== "object" || !("const" in member)) {
				throw new Error("launch op union member is not a literal");
			}
			return String(member.const);
		});
	}
	throw new Error("launch op is no longer a literal union");
}

async function answer(tool: LaunchTool, params: LaunchParams): Promise<Answer> {
	try {
		const result = await tool.execute("call", params);
		const block = result.content.find(item => item.type === "text");
		return { text: block?.type === "text" ? block.text : "" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function listed(tool: LaunchTool): Promise<LaunchToolDetails> {
	const result = await tool.execute("list", { op: "list" });
	if (!result.details) throw new Error("list returned no details");
	return result.details;
}

// The broker and its processes are separate OS processes, so progress is observed, not clock-advanced.
async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(25);
	}
	return condition();
}

async function exitedAll(tool: LaunchTool, names: string[]): Promise<boolean> {
	const { daemons = [] } = await listed(tool);
	return names.every(name => {
		const state = daemons.find(daemon => daemon.name === name)?.state;
		return state === "exited" || state === "failed";
	});
}

async function purgedAll(tool: LaunchTool, names: string[]): Promise<boolean> {
	const { daemons = [] } = await listed(tool);
	return names.every(name => !daemons.some(daemon => daemon.name === name));
}

/** A project whose process prints three lines and ends with `exitCode` after 300 ms. */
async function project(exitCodes: number[]): Promise<{ tool: LaunchTool; scripts: Map<number, string> }> {
	const dir = await tempDir("veyyon-launch-purged-");
	const scripts = new Map<number, string>();
	for (const code of exitCodes) {
		const script = path.join(dir, `exit-${code}.ts`);
		await fs.writeFile(
			script,
			`console.log("alpha");\nconsole.log("beta MARKER");\nconsole.log("gamma");\nsetTimeout(() => process.exit(${code}), 300);\n`,
		);
		scripts.set(code, script);
	}
	const session = makeToolSession({
		cwd: dir,
		settings: { get: key => (key === "launch.cleanupWaitMs" ? CLEANUP_WAIT_MS : undefined) },
	});
	return { tool: new LaunchTool(session), scripts };
}

describe("a launch operation answers the same before and after an exited process is purged", () => {
	it("records a decision for every name-addressed op the tool accepts", async () => {
		const { tool } = await project([]);
		const nameAddressed = opsAcceptedBy(tool).filter(op => op !== "start" && op !== "list");
		expect(Object.keys(DECISIONS).sort()).toEqual(nameAddressed.sort());
	});

	it("answers every op for a purged clean exit and a purged persistent failure as it did before the purge", async () => {
		const outcomes = [0, 3];
		const { tool, scripts } = await project(outcomes);
		const cases = Object.entries(DECISIONS).flatMap(([op, decision]) =>
			outcomes.map(code => ({ op, decision, code, name: `${op}-${code}` })),
		);
		const names = cases.map(entry => entry.name);
		for (const entry of cases) {
			const started = await answer(tool, {
				op: "start",
				name: entry.name,
				application: process.execPath,
				args: [scripts.get(entry.code) ?? ""],
				pty: false,
				// The failing processes also differ in lifetime, which every terminal label states.
				persist: entry.code !== 0,
			});
			expect(started).toEqual({ text: expect.stringContaining(`Started ${entry.name}`) });
		}
		expect(await until(() => exitedAll(tool, names), 20_000)).toBeTrue();

		const before = new Map<string, Answer[]>();
		for (const entry of cases) {
			const answers: Answer[] = [];
			for (const call of entry.decision.calls(entry.name)) answers.push(await answer(tool, call));
			before.set(entry.name, answers);
		}
		// The answers above have to come from live records, or the comparison proves nothing.
		const { daemons = [] } = await listed(tool);
		expect(names.filter(name => !daemons.some(daemon => daemon.name === name))).toEqual([]);

		expect(await until(() => purgedAll(tool, names), CLEANUP_WAIT_MS * 4)).toBeTrue();

		for (const entry of cases) {
			const normalize = entry.decision.normalize ?? ((text: string) => text);
			const shape = (answers: Answer[]) =>
				answers.map(item => ("text" in item ? { text: normalize(item.text) } : item));
			const after: Answer[] = [];
			for (const call of entry.decision.calls(entry.name)) after.push(await answer(tool, call));
			expect({ name: entry.name, answers: shape(after) }).toEqual({
				name: entry.name,
				answers: shape(before.get(entry.name) ?? []),
			});
		}

		// What the comparison stands on: the purged answers state the outcome, not an unknown name.
		expect(await answer(tool, { op: "stop", name: "stop-3" })).toEqual({
			text: expect.stringMatching(/^Stopped stop-3: failed exit=3 .* lifetime=broker-shutdown terminated-by=process-exit/),
		});
		expect(await answer(tool, { op: "send", name: "send-0", text: "input" })).toEqual({
			error: "Daemon send-0 is exited",
		});
		expect(await answer(tool, { op: "logs", name: "logs-0", grep: "MARKER" })).toEqual({
			text: expect.stringMatching(/^beta MARKER\n\[logs-0: exited; cursor=\d+\]$/),
		});

		// The purged restart ran its spec again: the new generation prints the same output.
		expect(await until(() => exitedAll(tool, ["restart-0"]), 20_000)).toBeTrue();
		expect(await answer(tool, { op: "logs", name: "restart-0", grep: "MARKER", lines: 1 })).toEqual({
			text: expect.stringMatching(/^beta MARKER\n/),
		});
		expect(await answer(tool, { op: "describe", name: "restart-0" })).toEqual({
			text: expect.stringContaining(`Command: ${process.execPath} ${scripts.get(0)}`),
		});
	}, 90_000);

	it("answers a reused name with its newest generation", async () => {
		const { tool, scripts } = await project([0, 3]);
		for (const code of [0, 3]) {
			await answer(tool, {
				op: "start",
				name: "reused",
				application: process.execPath,
				args: [scripts.get(code) ?? ""],
				pty: false,
			});
			expect(await until(() => exitedAll(tool, ["reused"]), 20_000)).toBeTrue();
		}
		expect(await until(() => purgedAll(tool, ["reused"]), CLEANUP_WAIT_MS * 4)).toBeTrue();
		expect(await answer(tool, { op: "describe", name: "reused" })).toEqual({
			text: expect.stringMatching(/^reused: failed exit=3 .*\nCommand: .*exit-3\.ts/s),
		});
	}, 60_000);

	it("still rejects a name no generation ran under", async () => {
		const { tool } = await project([]);
		expect(await answer(tool, { op: "describe", name: "never-started" })).toEqual({
			error: "Unknown daemon never-started",
		});
	});

	it("rejects a store written before records kept a state and spec, rather than serving it", async () => {
		const projectDir = await tempDir("veyyon-launch-v1-project-");
		const runtimeDir = await tempDir("veyyon-launch-v1-runtime-");
		const now = Date.now();
		await fs.writeFile(
			daemonCompletionsPath(runtimeDir),
			JSON.stringify({
				version: 1,
				records: [
					{
						name: "old-job",
						id: crypto.randomUUID(),
						terminatedBy: "process-exit",
						exitReason: "exited with code 0",
						exitCode: 0,
						createdAt: now - 2_000,
						startedAt: now - 1_000,
						exitedAt: now,
						restartCount: 0,
						outputBytes: 4,
						outputTail: "old\n",
					},
				],
			}),
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			await expect(client.request({ op: "describe", name: "old-job" })).rejects.toThrow("Unknown daemon old-job");
			const list = await client.request({ op: "list" });
			if (list.op !== "list") throw new Error("unexpected list result");
			expect(list.completions).toEqual([]);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 30_000);
});
