import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveEffort } from "../src/config/effort-resolver";
import { Settings } from "../src/config/settings";
import { resolveSubagentModel } from "../src/task/subagent-settings";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const dirs = useTrackedTempDirs("config-reload-");

describe("config hot reload", () => {
	it("changes new spawn routing, preserves existing forks, and reports restart-only settings", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await Bun.write(
			file,
			"modelRoles:\n  worker: openai/old\nsubagent:\n  model: '@worker'\ndefaultEffort:\n  '*': low\n",
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const existing = settings.forkWithRuntimeOverrides();
		const resolve = (store: Settings) => resolveSubagentModel({ settings: store, agentName: "task" }).patterns;
		expect(resolve(settings)).toEqual(["openai/old"]);
		await Bun.write(
			file,
			"modelRoles:\n  worker: openai/new\nsubagent:\n  model: '@worker'\ndefaultEffort:\n  '*': high\nhideThinkingBlock: true\n",
		);
		const result = await settings.reloadConfig();
		expect(resolve(settings)).toEqual(["openai/new"]);
		expect(resolve(existing)).toEqual(["openai/old"]);
		expect(resolveEffort({ defaultEffort: settings.get("defaultEffort") }).level).toBe("high");
		expect(settings.get("hideThinkingBlock")).toBe(false);
		expect(result.restartRequired).toContain("hideThinkingBlock");
		expect(result.changed.map(row => row.path)).toEqual(expect.arrayContaining(["modelRoles", "defaultEffort"]));
		expect((await settings.reloadConfig()).changed).toEqual([]);
	});

	it("preserves override precedence and applies removed routing fields", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const overlay = path.join(dir, "overlay.yml");
		await Bun.write(file, "subagent:\n  model: openai/profile\n  thinkingLevel: high\n");
		await Bun.write(overlay, "subagent:\n  model: openai/overlay\n");
		const settings = await Settings.loadReadOnly({
			agentDir: dir,
			configFiles: [overlay],
			overrides: { "subagent.model": "openai/runtime" },
		});
		await Bun.write(file, "{}\n");
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/runtime");
		expect(settings.getSource("subagent.model")).toBe("runtime");
		expect(settings.get("subagent.thinkingLevel")).toBeUndefined();
	});

	it("rejects malformed or invalid files without mutating disk or live routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await Bun.write(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const invalid of ["[broken", "- sequence", "subagent:\n  model: 42\n"]) {
			await Bun.write(file, invalid);
			await expect(settings.reloadConfig()).rejects.toThrow();
			expect(settings.get("subagent.model")).toBe("openai/old");
			expect(await Bun.file(file).text()).toBe(invalid);
		}
	});
});
