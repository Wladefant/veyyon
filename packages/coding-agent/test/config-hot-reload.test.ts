import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveEffort } from "../src/config/effort-resolver";
import { Settings } from "../src/config/settings";
import { InputController, type InputControllerContext } from "../src/modes/terminal/controllers/input-controller";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { resolveAgentModel } from "../src/task/agent-settings";
import { createSubagentSettingsForCwd } from "../src/task/executor";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const dirs = useTrackedTempDirs("config-reload-");

describe("config hot reload", () => {
	it.each([
		{ name: "ordinary overlap", laterModels: ["new"], finishOlderFirst: false },
		{ name: "ABA overlap", laterModels: ["new", "old"], finishOlderFirst: false },
		{ name: "a newer no-op reload", laterModels: ["old"], finishOlderFirst: false },
		{ name: "a newer reload still reading", laterModels: ["new"], finishOlderFirst: true },
	])(
		"rejects stale routing after $name without rebinding existing workers",
		async ({ laterModels, finishOlderFirst }) => {
			const dir = dirs();
			const file = path.join(dir, "config.yml");
			const writeModel = (model: string) =>
				fs.writeFile(file, JSON.stringify({ agent: { model: `openai/${model}`, sharedModel: true } }));
			await writeModel("old");
			const settings = await Settings.loadReadOnly({ agentDir: dir });
			const existing = await createSubagentSettingsForCwd(settings, dir);
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const newerEntered = Promise.withResolvers<void>();
			const newerResume = Promise.withResolvers<void>();
			const realFile = Bun.file.bind(Bun);
			let reads = 0;
			const readBarrier = spyOn(Bun, "file").mockImplementation(((target: string, options?: BlobPropertyBag) => {
				const source = realFile(target, options);
				if (target !== file || reads >= (finishOlderFirst ? 2 : 1)) return source;
				const first = reads++ === 0;
				return new Proxy(source, {
					get(source, property) {
						if (property === "text") {
							return async () => {
								const text = await source.text();
								(first ? entered : newerEntered).resolve();
								await (first ? resume : newerResume).promise;
								return text;
							};
						}
						const value = Reflect.get(source, property, source);
						return typeof value === "function" ? value.bind(source) : value;
					},
				});
			}) as typeof Bun.file);
			await writeModel("stale");
			const delayed = settings.reloadConfig().then(
				() => undefined,
				(error: unknown) => error,
			);
			let newer: Promise<unknown> | undefined;
			try {
				await entered.promise;
				for (const model of laterModels) {
					await writeModel(model);
					const reload = settings.reloadConfig();
					if (finishOlderFirst) {
						newer = reload.catch((error: unknown) => error);
						await newerEntered.promise;
					} else {
						await reload;
					}
				}
				resume.resolve();
				const failure = await delayed;
				if (finishOlderFirst) {
					expect(settings.get("agent.model")).toBe("openai/old");
					newerResume.resolve();
					expect(await newer).not.toBeInstanceOf(Error);
				}
				const expected = `openai/${laterModels.at(-1)}`;
				expect((await fs.readFile(file, "utf8")).includes(expected)).toBe(true);
				expect(settings.get("agent.model")).toBe(expected);
				const next = await createSubagentSettingsForCwd(settings, dir);
				expect(resolveAgentModel({ settings: next, agentName: "task" }).patterns).toEqual([expected]);
				expect(resolveAgentModel({ settings: existing, agentName: "task" }).patterns).toEqual(["openai/old"]);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toContain("Settings changed during reload");
			} finally {
				resume.resolve();
				newerResume.resolve();
				await delayed;
				await newer;
				readBarrier.mockRestore();
			}
		},
	);

	it("contains rejected reloads through the real TUI follow-up dispatcher and permits retry", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		let draft = "/reload-config";
		const errors: string[] = [];
		const statuses: string[] = [];
		const history: string[] = [];
		const ctx = {
			settings,
			session: { isCompacting: false },
			sessionManager: { getCwd: () => dir },
			editor: {
				getExpandedText: () => draft,
				setText: (text: string) => {
					draft = text;
				},
				addToHistory: (text: string) => {
					history.push(text);
				},
				pendingImages: [],
				pendingImageLinks: [],
			},
			showError: (text: string) => {
				errors.push(text);
			},
			showStatus: (text: string) => {
				statuses.push(text);
			},
		} as unknown as InputControllerContext;
		const input = new InputController(ctx);
		await fs.writeFile(file, "agent: [");
		await expect(input.handleFollowUp()).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(statuses.join("\n")).toContain("Config reload failed");
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		expect(draft).toBe("/reload-config");
		await fs.writeFile(file, "agent:\n  model: openai/new\n  sharedModel: true\n");
		await expect(input.handleFollowUp()).resolves.toBeUndefined();
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/new"]);
		expect(draft).toBe("");
		expect(history).toEqual(["/reload-config", "/reload-config"]);
	});

	it("dispatches the real text command with an off/on routing differential", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			settings,
			cwd: dir,
			output: text => {
				output.push(text);
			},
			get session(): never {
				throw new Error("reload must not rebind the session");
			},
			get sessionManager(): never {
				throw new Error("reload must not touch session persistence");
			},
			refreshCommands: () => {
				throw new Error("reload must not refresh plugins");
			},
			reloadPlugins: async () => {
				throw new Error("reload must not reload plugins");
			},
		};
		await fs.writeFile(file, "agent:\n  model: openai/new\n  sharedModel: true\n");
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		expect(await executeAcpBuiltinSlashCommand("/reload-config", runtime)).toEqual({ consumed: true });
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/new"]);
		expect(output[0]).toContain('agent.model: "openai/old" → "openai/new"');
		await executeAcpBuiltinSlashCommand("/reload-config", runtime);
		expect(output[1]).toContain("No effective routing changes.");
	});

	it("changes new spawn routing, preserves existing forks, and reports restart-only settings", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(
			file,
			"modelRoles:\n  worker: openai/old\nagent:\n  sharedModel: true\n  model: '@worker'\ndefaultEffort:\n  '*': low\n",
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const existing = settings.forkWithRuntimeOverrides();
		const resolve = (store: Settings) => resolveAgentModel({ settings: store, agentName: "task" }).patterns;
		expect(resolve(settings)).toEqual(["openai/old"]);
		await fs.writeFile(
			file,
			"modelRoles:\n  worker: openai/new\nagent:\n  sharedModel: true\n  model: '@worker'\ndefaultEffort:\n  '*': high\nhideThinkingBlock: true\n",
		);
		const result = await settings.reloadConfig();
		expect(resolve(settings)).toEqual(["openai/new"]);
		expect(resolve(existing)).toEqual(["openai/old"]);
		expect(resolveEffort({ defaultEffort: settings.get("defaultEffort") }).level as string).toBe("high");
		expect(settings.get("hideThinkingBlock")).toBe(false);
		expect(result.restartRequired).toContain("hideThinkingBlock");
		expect(result.changed.map(row => row.path)).toEqual(expect.arrayContaining(["modelRoles", "defaultEffort"]));
		expect((await settings.reloadConfig()).changed).toEqual([]);
	});

	it("preserves override precedence and applies removed routing fields", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const overlay = path.join(dir, "overlay.yml");
		await fs.writeFile(file, "agent:\n  model: openai/profile\n  thinkingLevel: high\n");
		await fs.writeFile(overlay, "agent:\n  model: openai/overlay\n");
		const settings = await Settings.loadReadOnly({
			agentDir: dir,
			configFiles: [overlay],
			overrides: { "agent.model": "openai/runtime" },
		});
		await fs.writeFile(file, "{}\n");
		await settings.reloadConfig();
		expect(settings.get("agent.model")).toBe("openai/runtime");
		expect(settings.getSource("agent.model")).toBe("runtime");
		expect(settings.get("agent.thinkingLevel")).toBeUndefined();
	});

	it("rejects malformed or invalid files without mutating disk or live routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const invalid of [
			"[broken",
			"- sequence",
			"agent:\n  model: 42\n",
			"agent: 42\n",
			"agent: null\n",
			"agent: []\n",
		]) {
			await fs.writeFile(file, invalid);
			await expect(settings.reloadConfig()).rejects.toThrow();
			expect(settings.get("agent.model")).toBe("openai/old");
			expect(await fs.readFile(file, "utf8")).toBe(invalid);
		}
	});
	it("rejects invalid roster members at every depth and preserves prior spawn routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  agents:\n    task:\n      model: openai/old\n");
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
			{ agents: [] },
			{ agents: null },
		]) {
			for (const lane of [member, { agents: member }, { agents: { agents: member } }]) {
				const contents = JSON.stringify({ agent: { agents: { task: lane } } });
				await fs.writeFile(file, contents);
				await expect(settings.reloadConfig()).rejects.toThrow("Invalid config settings");
				expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
				expect(await fs.readFile(file, "utf8")).toBe(contents);
			}
		}
		await fs.writeFile(
			file,
			JSON.stringify({
				agent: {
					agents: {
						task: {
							model: "openai/allowed",
							thinkingLevel: "high",
							agents: { enabled: true, thinkingLevel: " ", maxNestedSpawnDepth: -1 },
						},
					},
				},
			}),
		);
		await settings.reloadConfig();
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/allowed"]);
	});

	it("rejects semantic-invalid nested lanes with the startup schema diagnostic", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  agents:\n    task:\n      model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const member of [
			{ maxNestedSpawnDepth: 1.5 },
			{ maxNestedSpawnDepth: -2 },
			{ thinkingLevel: "impossible" },
		]) {
			await fs.writeFile(file, JSON.stringify({ agent: { agents: { task: { agents: member } } } }));
			const startup = await Settings.loadReadOnly({ agentDir: dir });
			expect(startup.invalidValues).toHaveLength(1);
			const diagnostic = startup.invalidValues[0].reason;
			expect(diagnostic).toContain("agent.agents.task.agents");
			await expect(settings.reloadConfig()).rejects.toThrow(diagnostic);
			expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		}
	});

	it("keeps the activated snapshot across reload and later saves without firing restart-only hooks", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "hideThinkingBlock: false\nagent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		const notifications: string[] = [];
		const unsubscribe = settings.onEffectiveSettingChanged(key => notifications.push(key));
		try {
			await fs.writeFile(file, "hideThinkingBlock: true\nagent:\n  model: openai/new\n  sharedModel: true\n");
			expect((await settings.reloadConfig()).restartRequired).toContain("hideThinkingBlock");
			expect(settings.get("hideThinkingBlock")).toBe(false);
			for (const model of ["openai/saved", "openai/saved-again"]) {
				settings.set("agent.model", model);
				await settings.flush();
				expect(settings.get("hideThinkingBlock")).toBe(false);
				expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual([model]);
				expect(await fs.readFile(file, "utf8")).toContain("hideThinkingBlock: true");
				expect((await settings.reloadConfig()).restartRequired).toContain("hideThinkingBlock");
			}
			expect(notifications).not.toContain("hideThinkingBlock");
			// An explicit setter remains an activation, unlike a disk-preserving save.
			settings.set("hideThinkingBlock", true);
			await settings.flush();
			expect(settings.get("hideThinkingBlock")).toBe(true);
			expect(notifications.filter(key => key === "hideThinkingBlock")).toHaveLength(1);
			expect((await settings.reloadConfig()).restartRequired).not.toContain("hideThinkingBlock");
		} finally {
			unsubscribe();
		}
	});

	it("reloads defaults when the main file is deleted", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.unlink(file);
		await settings.reloadConfig();
		const startup = await Settings.loadReadOnly({ agentDir: dir });
		expect(settings.get("agent.model")).toBe(startup.get("agent.model"));
		expect(await fs.readdir(dir)).not.toContain("config.yml");
	});

	it("rediscovers the alternate main filename and saves to it", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const alternate = path.join(dir, "config.yaml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		await fs.rename(file, alternate);
		await fs.writeFile(alternate, "agent:\n  model: openai/new\n");
		await settings.reloadConfig();
		expect(settings.get("agent.model")).toBe("openai/new");
		settings.set("agent.model", "openai/saved");
		await settings.flush();
		expect(await fs.readFile(alternate, "utf8")).toContain("openai/saved");
		expect(await fs.readdir(dir)).not.toContain("config.yml");
	});

	it("does not fall through an unreadable main candidate to an alternate", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.unlink(file);
		await fs.mkdir(file);
		await fs.writeFile(path.join(dir, "config.yaml"), "agent:\n  model: openai/new\n");
		await expect(settings.reloadConfig()).rejects.toThrow();
		expect(settings.get("agent.model")).toBe("openai/old");
	});

	it("notifies next-turn consumers once and only for effective routing changes", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "{}\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const changed: string[] = [];
		const unsubscribe = settings.onEffectiveSettingChanged(key => changed.push(key));
		try {
			await fs.writeFile(file, "agent:\n  agents:\n    task:\n      model: openai/new\n");
			await settings.reloadConfig();
			expect(changed).toEqual(["agent.agents"]);
			await settings.reloadConfig();
			expect(changed).toEqual(["agent.agents"]);
		} finally {
			unsubscribe();
		}
	});

	it("rejects reload for the entire active save and preserves the saved value", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "agent:\n  model: openai/old\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		settings.set("agent.model", "openai/saved");
		const saving = settings.flush();
		try {
			await expect(settings.reloadConfig()).rejects.toThrow("being saved");
		} finally {
			await saving;
		}
		await settings.reloadConfig();
		expect(settings.get("agent.model")).toBe("openai/saved");
		expect(await fs.readFile(file, "utf8")).toContain("openai/saved");
	});
});
