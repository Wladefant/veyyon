/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/12067
 *
 * Headless `omp -p` could exit successfully with no output while first-turn
 * mnemopi recall awaited an embedding response. The embeddings subprocess was
 * unref'd while idle, and a pending Promise is not an event-loop handle. Keep
 * the worker referenced for the exact lifetime of each pending request so the
 * caller can receive its result, then unref it again for interactive/daemon
 * shutdown behavior.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import {
	createMnemopiEmbedSubprocess,
	MnemopiEmbedClient,
	type MnemopiEmbedWorkerHandle,
	wrapSubprocess,
} from "../src/memory/mnemopi/embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "../src/memory/mnemopi/embed-protocol";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const embedClientPath = path.resolve(import.meta.dir, "../src/memory/mnemopi/embed-client.ts");
const workerClientPath = path.resolve(import.meta.dir, "../src/subprocess/worker-client.ts");

class TrackingEmbedWorker implements MnemopiEmbedWorkerHandle {
	readonly requests: MnemopiEmbedWorkerInbound[] = [];
	readonly #waiters: Array<{ index: number; resolve: (req: MnemopiEmbedWorkerInbound) => void }> = [];
	refCalls = 0;
	unrefCalls = 0;
	#messageHandler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;

	send(message: MnemopiEmbedWorkerInbound): void {
		const index = this.requests.length;
		this.requests.push(message);
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			if (this.#waiters[i].index === index) {
				this.#waiters[i].resolve(message);
				this.#waiters.splice(i, 1);
			}
		}
	}

	waitForRequest(index: number): Promise<MnemopiEmbedWorkerInbound> {
		if (this.requests.length > index) return Promise.resolve(this.requests[index]);
		const { promise, resolve } = Promise.withResolvers<MnemopiEmbedWorkerInbound>();
		this.#waiters.push({ index, resolve });
		return promise;
	}

	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
		this.#messageHandler = handler;
		return () => {
			if (this.#messageHandler === handler) this.#messageHandler = undefined;
		};
	}

	onError(): () => void {
		return () => {};
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: MnemopiEmbedWorkerOutbound): void {
		this.#messageHandler?.(message);
	}

	async terminate(): Promise<void> {
		this.#messageHandler = undefined;
	}
}

describe("issue #12067 — pending mnemopi requests keep print mode alive", () => {
	it("references the embed worker until requests settle, and maintains ref across overlapping in-flight requests", async () => {
		const worker = new TrackingEmbedWorker();
		const client = new MnemopiEmbedClient(() => worker);

		try {
			const initializing = client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			const init = await worker.waitForRequest(0);
			expect(init.type).toBe("init");
			expect(worker.refCalls).toBe(1);
			expect(worker.unrefCalls).toBe(0);

			worker.emit({ type: "ready", id: init.id });
			const model = await initializing;
			expect(model).not.toBeNull();
			expect(worker.unrefCalls).toBe(1);

			// Start two overlapping requests
			const embed1Promise = (async () => {
				for await (const vectors of model!.embed(["first query"])) return vectors;
				throw new Error("worker returned no vectors");
			})();
			const embed1 = await worker.waitForRequest(1);
			expect(embed1.type).toBe("embed");
			expect(worker.refCalls).toBe(2);
			expect(worker.unrefCalls).toBe(1);

			const embed2Promise = (async () => {
				for await (const vectors of model!.embed(["second query"])) return vectors;
				throw new Error("worker returned no vectors");
			})();
			const embed2 = await worker.waitForRequest(2);
			expect(embed2.type).toBe("embed");
			// Already referenced, so refCalls stays 2
			expect(worker.refCalls).toBe(2);
			expect(worker.unrefCalls).toBe(1);

			// Complete request 1 while request 2 is still in flight:
			worker.emit({ type: "vectors", id: embed1.id, vectors: [[0.1, 0.2]] });
			expect(await embed1Promise).toEqual([[0.1, 0.2]]);
			// Worker must NOT be unreferenced yet because request 2 is still active
			expect(worker.unrefCalls).toBe(1);

			// Complete request 2: pending drains to 0, so worker is unreferenced
			worker.emit({ type: "vectors", id: embed2.id, vectors: [[0.3, 0.4]] });
			expect(await embed2Promise).toEqual([[0.3, 0.4]]);
			expect(worker.unrefCalls).toBe(2);
		} finally {
			await client.terminate();
		}
	});

	it("delegates ref and unref to the underlying subprocess via wrapSubprocess and tolerates terminated children", async () => {
		const spawned = createMnemopiEmbedSubprocess();
		const handle = wrapSubprocess(spawned);
		const refSpy = spyOn(spawned.proc, "ref");
		const unrefSpy = spyOn(spawned.proc, "unref");

		handle.ref();
		expect(refSpy).toHaveBeenCalledTimes(1);

		handle.unref();
		expect(unrefSpy).toHaveBeenCalledTimes(1);

		// Terminate and verify post-exit swallow contract
		await handle.terminate();
		await spawned.proc.exited;

		// Force the underlying proc to throw on ref/unref after termination
		refSpy.mockImplementation(() => {
			throw new Error("subprocess terminated");
		});
		unrefSpy.mockImplementation(() => {
			throw new Error("subprocess terminated");
		});

		expect(() => handle.ref()).not.toThrow();
		expect(() => handle.unref()).not.toThrow();
	}, 15_000);

	it("keeps a short-lived caller alive until delayed responses arrive through wrapSubprocess, then exits when idle", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		// Real platform clock delay: external child process tests cross-process OS event-loop
		// liveness. Fake in-process timers cannot keep an external unref'd child from exiting.
		const fixtureWorkerScript = `
			process.on("message", (msg) => {
				if (msg.type === "init") {
					setTimeout(() => {
						process.send({ type: "ready", id: msg.id });
					}, 100);
				} else if (msg.type === "embed") {
					setTimeout(() => {
						process.send({ type: "vectors", id: msg.id, vectors: [[0.125, 0.875]] });
					}, 100);
				}
			});
		`;

		// Short-lived caller that initiates memory recall without top-level await, matching
		// headless print mode. Without proc.ref() on the worker subprocess, the process terminates
		// before receiving output because a pending Promise does not keep the event loop alive.
		const callerScript = `
			import { createWorkerSubprocess } from ${JSON.stringify(workerClientPath)};
			import { wrapSubprocess, MnemopiEmbedClient } from ${JSON.stringify(embedClientPath)};

			const spawned = createWorkerSubprocess({
				spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(fixtureWorkerScript)}] },
				env: {},
				exitLabel: "fixture worker",
				unref: true,
			});
			const client = new MnemopiEmbedClient(() => wrapSubprocess(spawned));

			const t0 = Date.now();
			client.initialize("fast-bge-base-en-v1.5", "/tmp/cache").then(async (model) => {
				if (!model) return;
				for await (const batch of model.embed(["short-lived print mode query"])) {
					const durationMs = Date.now() - t0;
					process.stdout.write(JSON.stringify({ ok: true, vectors: batch, durationMs }));
					break;
				}
			});
		`;

		const { env, cleanup } = hermeticSpawnEnv({
			BUN_ENV: "production",
			NODE_ENV: "production",
			VEYYON_TEST_RUNTIME: "0",
		});
		try {
			const proc = Bun.spawn([process.execPath, "-e", callerScript], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			});

			const [stdoutText, stderrText, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stderrText).toBe("");
			expect(stdoutText).not.toBe("");
			const result = JSON.parse(stdoutText);
			expect(result.ok).toBe(true);
			expect(result.vectors).toEqual([[0.125, 0.875]]);
			expect(result.durationMs).toBeGreaterThanOrEqual(150);
		} finally {
			cleanup();
		}
	}, 30_000);

	it("resets referenced state on crash/reap so a replacement worker references a fresh delayed request", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		// Real platform clock delay: external child process tests cross-process OS event-loop
		// liveness. Fake in-process timers cannot keep an external unref'd child from exiting.
		const fixtureWorkerScript = `
			process.on("message", (msg) => {
				if (msg.type === "init" && msg.model === "crash-on-init") {
					process.exit(1);
				} else if (msg.type === "init") {
					setTimeout(() => {
						process.send({ type: "ready", id: msg.id });
					}, 100);
				}
			});
		`;

		// Caller runs request 1 which crashes worker 1. On error, #reap MUST reset #refed = false.
		// Request 2 on the replacement worker must then be referenced via proc.ref(), keeping the
		// short-lived caller alive without top-level await until worker 2's response arrives.
		const callerScript = `
			import { createWorkerSubprocess } from ${JSON.stringify(workerClientPath)};
			import { wrapSubprocess, MnemopiEmbedClient } from ${JSON.stringify(embedClientPath)};

			let spawnCount = 0;
			const client = new MnemopiEmbedClient(() => {
				spawnCount++;
				const spawned = createWorkerSubprocess({
					spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(fixtureWorkerScript)}] },
					env: {},
					exitLabel: "fixture-worker-" + spawnCount,
					unref: true,
				});
				return wrapSubprocess(spawned);
			});

			const req1 = client.initialize("crash-on-init", "/tmp/cache");

			req1.then((ok1) => {
				const t0 = Date.now();
				client.initialize("fast-bge-base-en-v1.5", "/tmp/cache").then((model2) => {
					const durationMs = Date.now() - t0;
					process.stdout.write(JSON.stringify({ ok: true, req1Result: ok1, model2Ok: model2 !== null, durationMs }));
				});
			});
		`;

		const { env, cleanup } = hermeticSpawnEnv({
			BUN_ENV: "production",
			NODE_ENV: "production",
			VEYYON_TEST_RUNTIME: "0",
		});
		try {
			const proc = Bun.spawn([process.execPath, "-e", callerScript], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			});

			const [stdoutText, stderrText, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stderrText).toBe("");
			expect(stdoutText).not.toBe("");
			const result = JSON.parse(stdoutText);
			expect(result.ok).toBe(true);
			expect(result.req1Result).toBeNull();
			expect(result.model2Ok).toBe(true);
			expect(result.durationMs).toBeGreaterThanOrEqual(80);
		} finally {
			cleanup();
		}
	}, 30_000);

	it("keeps the worker referenced across overlapping requests until the last active request completes in a short-lived caller", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		// Real platform clock delay: external child process tests cross-process OS event-loop
		// liveness. Fake in-process timers cannot keep an external unref'd child from exiting.
		const fixtureWorkerScript = `
			process.on("message", (msg) => {
				if (msg.type === "init") {
					process.send({ type: "ready", id: msg.id });
				} else if (msg.type === "embed") {
					const delay = msg.texts[0] === "fast" ? 50 : 180;
					setTimeout(() => {
						process.send({ type: "vectors", id: msg.id, vectors: [[delay]] });
					}, delay);
				}
			});
		`;

		// Caller runs two overlapping embed requests in the background without top-level await.
		// Completing the fast request (50ms) must NOT unref the worker while the slow request (180ms)
		// is still in flight.
		const callerScript = `
			import { createWorkerSubprocess } from ${JSON.stringify(workerClientPath)};
			import { wrapSubprocess, MnemopiEmbedClient } from ${JSON.stringify(embedClientPath)};

			const spawned = createWorkerSubprocess({
				spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(fixtureWorkerScript)}] },
				env: {},
				exitLabel: "overlapping-fixture",
				unref: true,
			});
			const client = new MnemopiEmbedClient(() => wrapSubprocess(spawned));

			client.initialize("fast-bge-base-en-v1.5", "/tmp/cache").then((model) => {
				if (!model) return;
				const t0 = Date.now();
				let fastDuration = null;
				let slowDuration = null;

				const fastPromise = (async () => {
					for await (const vectors of model.embed(["fast"])) {
						fastDuration = Date.now() - t0;
						return vectors;
					}
				})();

				const slowPromise = (async () => {
					for await (const vectors of model.embed(["slow"])) {
						slowDuration = Date.now() - t0;
						return vectors;
					}
				})();

				Promise.all([fastPromise, slowPromise]).then(([fastVectors, slowVectors]) => {
					const totalDuration = Date.now() - t0;
					process.stdout.write(JSON.stringify({
						ok: true,
						fastVectors,
						slowVectors,
						fastDuration,
						slowDuration,
						totalDuration,
					}));
				});
			});
		`;

		const { env, cleanup } = hermeticSpawnEnv({
			BUN_ENV: "production",
			NODE_ENV: "production",
			VEYYON_TEST_RUNTIME: "0",
		});
		try {
			const proc = Bun.spawn([process.execPath, "-e", callerScript], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			});

			const [stdoutText, stderrText, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stderrText).toBe("");
			expect(stdoutText).not.toBe("");
			const result = JSON.parse(stdoutText);
			expect(result.ok).toBe(true);
			expect(result.fastVectors).toEqual([[50]]);
			expect(result.slowVectors).toEqual([[180]]);
			expect(result.fastDuration).toBeLessThan(result.slowDuration);
			expect(result.totalDuration).toBeGreaterThanOrEqual(160);
		} finally {
			cleanup();
		}
	}, 30_000);
});
