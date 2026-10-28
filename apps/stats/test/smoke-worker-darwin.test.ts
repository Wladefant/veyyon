import { describe, expect, it } from "bun:test";
import { smokeTestSyncWorker } from "@veyyon/stats/aggregator";
import { installStatsTestIsolation } from "./helpers/temp-agent";
import { installWorkerStandIn } from "./helpers/worker-stand-in";

installStatsTestIsolation("@pi-stats-smoke-darwin-");

describe("smokeTestSyncWorker", () => {
	it("skips the worker spawn on darwin so veyyon --smoke-test stays off the macOS abort surface", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const workers = installWorkerStandIn(new Error("worker should not be created on darwin"));
		try {
			await expect(smokeTestSyncWorker()).resolves.toBeUndefined();
			expect(workers.constructed).toBe(0);
		} finally {
			workers.restore();
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});
});
