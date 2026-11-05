import { describe, expect, it } from "bun:test";
import { smokeTestSyncWorker } from "@veyyon/stats/aggregator";
import { restorePlatform, setPlatform } from "../../../packages/utils/test/helpers/platform-override";
import { installStatsTestIsolation } from "./helpers/temp-agent";
import { installWorkerStandIn } from "./helpers/worker-stand-in";

installStatsTestIsolation("@pi-stats-smoke-darwin-");

describe("smokeTestSyncWorker", () => {
	it("skips the worker spawn on darwin so veyyon --smoke-test stays off the macOS abort surface", async () => {
		setPlatform("darwin");
		const workers = installWorkerStandIn(new Error("worker should not be created on darwin"));
		try {
			await expect(smokeTestSyncWorker()).resolves.toBeUndefined();
			expect(workers.constructed).toBe(0);
		} finally {
			workers.restore();
			restorePlatform();
		}
	});
});
