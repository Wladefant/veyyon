import { describe, expect, it } from "bun:test";
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
});
