import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveEffort } from "../src/config/effort-resolver";
import { Settings } from "../src/config/settings";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { resolveSubagentModel } from "../src/task/subagent-settings";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const dirs = useTrackedTempDirs("config-reload-");

describe("config hot reload", () => {
	it("dispatches the real text command with an off/on routing differential", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			settings,
			cwd: dir,
			output: text => {
				output.push(text);
			},
			get session() {
				throw new Error("reload must not rebind the session");
			},
			get sessionManager() {
				throw new Error("reload must not touch session persistence");
			},
			refreshCommands: () => {
				throw new Error("reload must not refresh plugins");
			},
			reloadPlugins: async () => {
				throw new Error("reload must not reload plugins");
			},
		};
		await fs.writeFile(file, "subagent:\n  model: openai/new\n  sharedModel: true\n");
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		expect(await executeAcpBuiltinSlashCommand("/reload-config", runtime)).toEqual({ consumed: true });
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/new"]);
		expect(output[0]).toContain('subagent.model: "openai/old" → "openai/new"');
		await executeAcpBuiltinSlashCommand("/reload-config", runtime);
		expect(output[1]).toContain("No effective routing changes.");
	});

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
		for (const invalid of [
			"[broken",
			"- sequence",
			"subagent:\n  model: 42\n",
			"subagent: 42\n",
			"subagent: null\n",
			"subagent: []\n",
		]) {
			await fs.writeFile(file, invalid);
			await expect(settings.reloadConfig()).rejects.toThrow();
			expect(settings.get("subagent.model")).toBe("openai/old");
			expect(await fs.readFile(file, "utf8")).toBe(invalid);
		}
	});
	it("rejects invalid roster members at every depth and preserves prior spawn routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  agents:\n    task:\n      model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const member of [
			{ model: 42 },
			{ model: ["openai/new", 42] },
			{ enabled: "false" },
			{ thinkingLevel: 42 },
			{ maxNestedSpawnDepth: "2" },
			{ maxNestedSpawnDepth: 1.5 },
			{ maxNestedSpawnDepth: -2 },
			{ thinkingLevel: "impossible" },
			{ subagents: [] },
			{ subagents: null },
		]) {
			for (const lane of [member, { subagents: member }, { subagents: { subagents: member } }]) {
				const contents = JSON.stringify({ subagent: { agents: { task: lane } } });
				await fs.writeFile(file, contents);
				await expect(settings.reloadConfig()).rejects.toThrow("Invalid config settings");
				expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
				expect(await fs.readFile(file, "utf8")).toBe(contents);
			}
		}
		await fs.writeFile(
			file,
			JSON.stringify({
				subagent: {
					agents: {
						task: {
							model: "openai/allowed",
							thinkingLevel: "high",
							subagents: { enabled: true, thinkingLevel: " ", maxNestedSpawnDepth: -1 },
						},
					},
				},
			}),
		);
		await settings.reloadConfig();
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/allowed"]);
	});

	it("reloads defaults when the main file is deleted", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.unlink(file);
		await settings.reloadConfig();
		const startup = await Settings.loadReadOnly({ agentDir: dir });
		expect(settings.get("subagent.model")).toBe(startup.get("subagent.model"));
		expect(await fs.readdir(dir)).not.toContain("config.yml");
	});

	it("rediscovers the alternate main filename and saves to it", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const alternate = path.join(dir, "config.yaml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		await fs.rename(file, alternate);
		await fs.writeFile(alternate, "subagent:\n  model: openai/new\n");
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/new");
		settings.set("subagent.model", "openai/saved");
		await settings.flush();
		expect(await fs.readFile(alternate, "utf8")).toContain("openai/saved");
		expect(await fs.readdir(dir)).not.toContain("config.yml");
	});

	it("does not fall through an unreadable main candidate to an alternate", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.unlink(file);
		await fs.mkdir(file);
		await fs.writeFile(path.join(dir, "config.yaml"), "subagent:\n  model: openai/new\n");
		await expect(settings.reloadConfig()).rejects.toThrow();
		expect(settings.get("subagent.model")).toBe("openai/old");
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
