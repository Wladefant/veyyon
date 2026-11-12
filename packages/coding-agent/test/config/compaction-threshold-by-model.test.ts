import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveThresholdWithOrigin, type CompactionSettings } from "@veyyon/agent-core/compaction/threshold";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeAgentDir = useTrackedTempDirs("veyyon-compaction-threshold-model-");
let agentDir = "";

afterEach(async () => {
	if (agentDir) {
		await removeWithRetries(guardDestructivePath(agentDir, "compaction-threshold-by-model"));
		agentDir = "";
	}
});

function writeConfig(value: unknown): void {
	fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(value));
}

describe("per-model compaction threshold settings", () => {
	it("rejects a non-string entry with a diagnostic while retaining valid entries on a real load", async () => {
		agentDir = makeAgentDir();
		writeConfig({ compaction: { thresholdByModel: { "valid/*": "35%", "bad-number": 42 } } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		expect(settings.get("compaction.thresholdByModel")).toEqual({ "valid/*": "35%" });
		expect(settings.invalidValues).toContainEqual(expect.objectContaining({
			path: "compaction.thresholdByModel",
			reason: expect.stringContaining("bad-number"),
		}));
	});

	it("rejects an unparseable string entry with a diagnostic while retaining valid entries", async () => {
		agentDir = makeAgentDir();
		writeConfig({ compaction: { thresholdByModel: { "valid/*": "35%", "bad-value": "not-a-threshold" } } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		expect(settings.get("compaction.thresholdByModel")).toEqual({ "valid/*": "35%" });
		expect(settings.invalidValues).toContainEqual(expect.objectContaining({
			path: "compaction.thresholdByModel",
			reason: expect.stringContaining("bad-value"),
		}));
	});

	it("resolves a changed model threshold from the same loaded Settings instance", async () => {
		agentDir = makeAgentDir();
		writeConfig({ compaction: { thresholdByModel: { "model-a": "25%" } } });
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		const compaction = (): CompactionSettings => ({
			enabled: settings.get("compaction.enabled"),
			strategy: settings.get("compaction.strategy"),
			threshold: settings.get("compaction.threshold"),
			thresholdByModel: settings.get("compaction.thresholdByModel"),
			thresholdTokens: settings.get("compaction.thresholdTokens"),
			thresholdPercent: settings.get("compaction.thresholdPercent"),
			activeModelId: "model-a",
			reserveTokens: 40_000,
			keepRecentTokens: settings.get("compaction.keepRecentTokens"),
		});

		expect(resolveThresholdWithOrigin(200_000, compaction()).tokens).toBe(50_000);
		writeConfig({ compaction: { thresholdByModel: { "model-a": "60%" } } });
		await settings.reloadConfig();
		expect(resolveThresholdWithOrigin(200_000, compaction()).tokens).toBe(120_000);
	});
});
