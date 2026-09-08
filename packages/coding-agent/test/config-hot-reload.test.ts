import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
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
		await fs.writeFile(
			file,
			"modelRoles:\n  worker: openai/old\nsubagent:\n  sharedModel: true\n  model: '@worker'\ndefaultEffort:\n  '*': low\n",
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const existing = settings.forkWithRuntimeOverrides();
		const resolve = (store: Settings) => resolveSubagentModel({ settings: store, agentName: "task" }).patterns;
		expect(resolve(settings)).toEqual(["openai/old"]);
		await fs.writeFile(
			file,
			"modelRoles:\n  worker: openai/new\nsubagent:\n  sharedModel: true\n  model: '@worker'\ndefaultEffort:\n  '*': high\nhideThinkingBlock: true\n",
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
		await fs.writeFile(file, "subagent:\n  model: openai/profile\n  thinkingLevel: high\n");
		await fs.writeFile(overlay, "subagent:\n  model: openai/overlay\n");
		const settings = await Settings.loadReadOnly({
			agentDir: dir,
			configFiles: [overlay],
			overrides: { "subagent.model": "openai/runtime" },
		});
		await fs.writeFile(file, "{}\n");
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/runtime");
		expect(settings.getSource("subagent.model")).toBe("runtime");
		expect(settings.get("subagent.thinkingLevel")).toBeUndefined();
	});

	it("rejects malformed or invalid files without mutating disk or live routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const invalid of ["[broken", "- sequence", "subagent:\n  model: 42\n"]) {
			await fs.writeFile(file, invalid);
			await expect(settings.reloadConfig()).rejects.toThrow();
			expect(settings.get("subagent.model")).toBe("openai/old");
			expect(await fs.readFile(file, "utf8")).toBe(invalid);
		}
	});
	it("notifies next-turn consumers once and only for effective routing changes", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "{}\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const changed: string[] = [];
		const unsubscribe = settings.onEffectiveSettingChanged(key => changed.push(key));
		try {
			await fs.writeFile(file, "subagent:\n  agents:\n    task:\n      model: openai/new\n");
			await settings.reloadConfig();
			expect(changed).toEqual(["subagent.agents"]);
			await settings.reloadConfig();
			expect(changed).toEqual(["subagent.agents"]);
		} finally {
			unsubscribe();
		}
	});

	it("rejects reload for the entire active save and preserves the saved value", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		settings.set("subagent.model", "openai/saved");
		const saving = settings.flush();
		try {
			await expect(settings.reloadConfig()).rejects.toThrow("being saved");
		} finally {
			await saving;
		}
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/saved");
		expect(await fs.readFile(file, "utf8")).toContain("openai/saved");
	});
});
