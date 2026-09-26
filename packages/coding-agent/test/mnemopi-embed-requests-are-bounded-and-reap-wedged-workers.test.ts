/**
 * Regression test for bounded mnemopi embed worker IPC and process reaping.
 *
 * Upstream commits: a4987ba51858 and 4c80c7b114a4
 *
 * Steady-state embed requests are bounded by a timeout that SIGKILL-reaps wedged
 * workers and their child process tree to prevent hanging memory recall, while
 * first-use runtime installation and model initialization remain unbounded.
 */
import { describe, expect, it, vi } from "bun:test";
import { processHandle } from "@veyyon/utils/native-process";
import { isProcessAlive } from "@veyyon/utils/process-liveness";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "../src/memory/mnemopi/embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "../src/memory/mnemopi/embed-protocol";
import { createWorkerHandle, createWorkerSubprocess } from "../src/subprocess/worker-client";

function silentEmbedWorker(state: { spawns: number; terminated: number }): () => MnemopiEmbedWorkerHandle {
	return () => {
		state.spawns += 1;
		let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		return {
			send(message: MnemopiEmbedWorkerInbound) {
				queueMicrotask(() => {
					if (message.type === "ping") handler?.({ type: "pong", id: message.id });
					else if (message.type === "init") handler?.({ type: "ready", id: message.id });
				});
			},
			onMessage(next) {
				handler = next;
				return () => { if (handler === next) handler = undefined; };
			},
			onError: () => () => {},
			async terminate() {
				state.terminated += 1;
				handler = undefined;
			},
		};
	};
}

describe("mnemopi embed requests are bounded and reap wedged workers", () => {
	it("fails a wedged embed within the budget instead of hanging forever", async () => {
		const state = { spawns: 0, terminated: 0 };
		const client = new MnemopiEmbedClient(silentEmbedWorker(state), { requestTimeoutMs: 50 });
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			expect(model).not.toBeNull();
			const start = Date.now();
			let threw = false;
			try {
				for await (const _ of model!.embed(["hello"])) { /* drain */ }
			} catch (error) {
				threw = true;
				expect(String(error)).toMatch(/timed out/i);
			}
			expect(threw).toBe(true);
			expect(Date.now() - start).toBeLessThan(5_000);
			expect(state.terminated).toBeGreaterThanOrEqual(1);
		} finally {
			await client.terminate();
		}
	}, 10_000);

	it("respawns a fresh worker for the next request after reaping a wedged one", async () => {
		const state = { spawns: 0, terminated: 0 };
		const client = new MnemopiEmbedClient(silentEmbedWorker(state), { requestTimeoutMs: 50 });
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			const spawnsAfterInit = state.spawns;
			await expect((async () => { for await (const _ of model!.embed(["a"])) {} })()).rejects.toThrow(/timed out/i);
			await expect((async () => { for await (const _ of model!.embed(["b"])) {} })()).rejects.toThrow(/timed out/i);
			expect(state.spawns).toBeGreaterThan(spawnsAfterInit);
		} finally {
			await client.terminate();
		}
	}, 10_000);

	it("allows initialization to outlive the steady-state embed budget", async () => {
		vi.useFakeTimers();
		const state = { spawns: 0, terminated: 0 };
		const { promise: initStarted, resolve: markInitStarted } = Promise.withResolvers<void>();
		let completeInit: (() => void) | undefined;
		const client = new MnemopiEmbedClient(
			() => {
				state.spawns += 1;
				let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
				return {
					send(message) {
						if (message.type !== "init") return;
						completeInit = () => handler?.({ type: "ready", id: message.id });
						markInitStarted();
					},
					onMessage(next) {
						handler = next;
						return () => { if (handler === next) handler = undefined; };
					},
					onError: () => () => {},
					async terminate() {
						state.terminated += 1;
						handler = undefined;
					},
				};
			},
			{ requestTimeoutMs: 50 },
		);
		try {
			const initializing = client.initialize("fast-bge-base-en-v1.5", undefined);
			await initStarted;
			vi.advanceTimersByTime(10_000);
			expect(completeInit).toBeDefined();
			completeInit?.();
			const model = await initializing;
			expect(model).not.toBeNull();
			expect(state.spawns).toBe(1);
			expect(state.terminated).toBe(0);
		} finally {
			await client.terminate();
			vi.useRealTimers();
		}
	}, 10_000);

	it("reaps descendant child processes on worker termination without killing ancestors", async () => {
		const isWin = process.platform === "win32";
		const cmd = isWin
			? ["cmd.exe", "/c", "powershell -NoProfile -Command Start-Sleep -Seconds 60"]
			: ["sh", "-c", "sleep 60 & wait"];
		const spawned = createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
			spawnCommand: { cmd },
			env: {},
			exitLabel: "test embed worker",
		});
		const handle = createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, () => {});
		const childPid = spawned.proc.pid;
		expect(childPid).toBeDefined();
		expect(isProcessAlive(childPid)).toBe(true);

		let grandchildPids: number[] = [];
		const nativeHandle = processHandle(childPid);
		if (nativeHandle) {
			for (let i = 0; i < 50; i++) {
				grandchildPids = nativeHandle.children().map(c => c.pid);
				if (grandchildPids.length > 0) break;
				const { promise: tick, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 50);
				await tick;
			}
		}

		await handle.terminate();
		await spawned.proc.exited;

		if (nativeHandle) await nativeHandle.waitForExit({ timeoutMs: 3_000 });
		for (const gpid of grandchildPids) {
			const gHandle = processHandle(gpid);
			if (gHandle) await gHandle.waitForExit({ timeoutMs: 3_000 });
			expect(isProcessAlive(gpid)).toBe(false);
		}
		expect(isProcessAlive(childPid)).toBe(false);
		expect(isProcessAlive(process.pid)).toBe(true);
	}, 15_000);
});
