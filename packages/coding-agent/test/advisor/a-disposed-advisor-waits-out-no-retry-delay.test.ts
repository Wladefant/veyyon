/**
 * WHY: an advisor review that failed waited `retryDelayMs` on a `Bun.sleep` before retrying, and
 * disposing the advisor did not end that wait. A session that closed an advisor during the delay
 * kept a live timer, and an embedding process stayed alive, until the delay ran out.
 *
 * The class: disposing an advisor ends every wait its review loop is in. The case runs the loop
 * in a child process with a delay far beyond the spawn bound, disposes it inside the delay, and
 * asserts the child exits on its own.
 *
 * Not caught: the retry delay in flight across a `reset()` or `cancelInFlight()`, which still runs
 * to its end before the loop takes the next batch.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const runtimeUrl = new URL("../../src/advisor/runtime.ts", import.meta.url).href;

/** Far beyond the spawn bound: a retry delay that outlives dispose fails the case by timeout. */
const RETRY_DELAY_MS = 120_000;
/** Bun start-up and the advisor import graph, with room for a loaded machine. */
const SPAWN_BOUND_MS = 30_000;

const PROBE = `
const { setTimeout: sleep } = await import("node:timers/promises");
const { AdvisorRuntime } = await import(${JSON.stringify(runtimeUrl)});
let prompts = 0;
const agent = {
	prompt: async () => {
		prompts++;
		throw new Error("provider unavailable");
	},
	abort: () => {},
	reset: () => {},
	state: { messages: [] },
};
const failed = Promise.withResolvers();
const host = {
	snapshotMessages: () => [{ role: "user", content: "review this", timestamp: 1 }],
	enqueueAdvice: () => {},
	onTurnError: () => failed.resolve(),
};
const runtime = new AdvisorRuntime(agent, host, ${RETRY_DELAY_MS});
runtime.onTurnEnd();
await failed.promise;
// Let the loop requeue the batch and enter its retry delay.
await sleep(50);
runtime.dispose();
console.log(JSON.stringify({ prompts, backlog: runtime.backlog }));
`;

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

describe("a disposed advisor waits out no retry delay", () => {
	it(
		"lets the process exit when the advisor is disposed during the retry delay, not when the delay would end",
		() => {
			const spawnEnv = hermeticSpawnEnv();
			cleanup = spawnEnv.cleanup;
			const run = spawnSync(process.execPath, ["-e", PROBE], {
				encoding: "utf8",
				env: spawnEnv.env,
				timeout: SPAWN_BOUND_MS,
			});
			expect({ status: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() }).toEqual({
				status: 0,
				stdout: '{"prompts":1,"backlog":0}',
				stderr: "",
			});
		},
		SPAWN_BOUND_MS + 5_000,
	);
});
