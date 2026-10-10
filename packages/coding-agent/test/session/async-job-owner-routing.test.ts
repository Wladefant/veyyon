import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { createOwnedAsyncJobManager } from "../../src/session/async-jobs";

describe("background completion owner routing", () => {
	it("routes lane launch exits only to the lane and Main jobs only to Main", async () => {
		const main: string[] = [];
		const lane: string[] = [];
		const manager = createOwnedAsyncJobManager({
			options: {},
			settings: Settings.isolated({}),
			sessionManager: {
				allocateArtifactPath: () => {
					throw new Error("unexpected artifact");
				},
			},
			target: ownerId =>
				ownerId === "Lane"
					? { deliverAsyncJobResult: id => lane.push(id) }
					: { deliverAsyncJobResult: id => main.push(id) },
		})!;
		try {
			const laneJob = manager.register("launch", "lane exit", async () => "exit", { ownerId: "Lane" });
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2000 });
			expect(main).toEqual([]);
			expect(lane).toEqual([laneJob]);
			const mainJob = manager.register("bash", "main exit", async () => "exit", { ownerId: "Main" });
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2000 });
			expect(main).toEqual([mainJob]);
			expect(manager.getAllJobs().length).toBe(2);
		} finally {
			await manager.dispose();
		}
	});
	it("retains a detached owner's completion until that owner reattaches", async () => {
		const received: string[] = [];
		let attached = false;
		const manager = createOwnedAsyncJobManager({
			options: {},
			settings: Settings.isolated({}),
			sessionManager: { allocateArtifactPath: async () => ({}) },
			target: () => (attached ? { deliverAsyncJobResult: id => received.push(id) } : undefined),
		})!;
		try {
			const id = manager.register("launch", "detached lane", async () => "exit", { ownerId: "Lane" });
			await manager.waitForAll();
			expect(await manager.drainDeliveries({ timeoutMs: 50 })).toBe(false);
			attached = true;
			expect(await manager.drainDeliveries({ timeoutMs: 2000 })).toBe(true);
			expect(received).toEqual([id]);
		} finally {
			await manager.dispose();
		}
	});
	it("re-resolves an owner disposed while formatting without enqueueing into it", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stale: string[] = [];
		const live: string[] = [];
		let owner = { isDisposed: false, deliverAsyncJobResult: (id: string) => stale.push(id) };
		const manager = createOwnedAsyncJobManager({
			options: {},
			settings: Settings.isolated({}),
			sessionManager: {
				allocateArtifactPath: async () => {
					entered.resolve();
					await release.promise;
					return {};
				},
			},
			target: () => owner,
		})!;
		try {
			const id = manager.register("launch", "format race", async () => "x".repeat(13000), { ownerId: "Lane" });
			await entered.promise;
			owner.isDisposed = true;
			release.resolve();
			await manager.waitForAll();
			expect(await manager.drainDeliveries({ timeoutMs: 50 })).toBe(false);
			expect(stale).toEqual([]);
			owner = { isDisposed: false, deliverAsyncJobResult: id => live.push(id) };
			expect(await manager.drainDeliveries({ timeoutMs: 2000 })).toBe(true);
			expect(live).toEqual([id]);
		} finally {
			release.resolve();
			await manager.dispose();
		}
	});
	it("keeps the delivery owner after the inspection entry expires", async () => {
		// The native delivery loop uses Bun.sleep. Await its retry event rather than a test delay.
		const delivered = Promise.withResolvers<void>();
		let firstAttempt = true;
		const received: (string | undefined)[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 1,
			onJobComplete: (_id, _text, job) => {
				if (firstAttempt) {
					firstAttempt = false;
					throw new Error("owner detached");
				}
				received.push(job?.ownerId);
				delivered.resolve();
			},
		});
		try {
			const id = manager.register("launch", "expired inspection", async () => "exit", { ownerId: "Lane" });
			await delivered.promise;
			expect(manager.getJob(id)).toBeUndefined();
			expect(received).toEqual(["Lane"]);
		} finally {
			await manager.dispose();
		}
	});
});
