import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { buildModel } from "@veyyon/catalog/build";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { groupSettingPaths } from "@veyyon/kernel/settings/store";
import { resolveEffort } from "../src/config/effort-resolver";
import type { ModelRegistry } from "../src/config/model-registry";
import { type SettingPath, Settings } from "../src/config/settings";
import { InputController, type InputControllerContext } from "../src/modes/terminal/controllers/input-controller";
import { AgentSession } from "../src/session/agent-session";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { resolveAgentModel } from "../src/task/agent-settings";
import { createSubagentSettingsForCwd } from "../src/task/executor";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const dirs = useTrackedTempDirs("config-reload-");
const liveSessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of liveSessions.splice(0)) {
		await session.dispose();
	}
});

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
			session: { isCompacting: false, reloadRules: async () => [] },
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
		await fs.writeFile(
			file,
			'agent:\n  model: openai/old\n  sharedModel: true\ncompaction:\n  threshold: "200000"\n',
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			settings,
			cwd: dir,
			output: text => {
				output.push(text);
			},
			session: { reloadRules: async () => [] } as unknown as AgentSession,
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
		await fs.writeFile(
			file,
			"agent:\n  model: openai/new\n  sharedModel: true\ndefaultEffort:\n  '*': high\ncompaction:\n  threshold: \"400000\"\n",
		);
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		expect(await executeAcpBuiltinSlashCommand("/reload-config", runtime)).toEqual({ consumed: true });
		expect(resolveAgentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/new"]);
		expect(output[0]).toContain('agent.model: applied ("openai/old" → "openai/new")');
		expect(output[0]).toContain("agent.sharedModel: unchanged");
		expect(output[0]).toContain('compaction.threshold: applied ("200000" → "400000")');
		expect(output[0]).toContain("defaultEffort: restart-required — pickInitialThinkingLevel captures it at startup");
		await executeAcpBuiltinSlashCommand("/reload-config", runtime);
		expect(output[1]).toContain("No effective routing changes.");
	});

	it("changes new spawn routing and preserves existing forks", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(
			file,
			"agent:\n  sharedModel: true\n  model: openai/old\ndefaultEffort:\n  '*': low\n",
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const existing = settings.forkWithRuntimeOverrides();
		const resolve = (store: Settings) => resolveAgentModel({ settings: store, agentName: "task" }).patterns;
		expect(resolve(settings)).toEqual(["openai/old"]);
		await fs.writeFile(
			file,
			"agent:\n  sharedModel: true\n  model: openai/new\ndefaultEffort:\n  '*': low\n",
		);
		const result = await settings.reloadConfig();
		expect(resolve(settings)).toEqual(["openai/new"]);
		expect(resolve(existing)).toEqual(["openai/old"]);
		expect(resolveEffort({ defaultEffort: settings.get("defaultEffort") }).level as string).toBe("low");
		expect(settings.get("hideThinkingBlock")).toBe(false);
		expect(result.restartRequired).toEqual([]);
		expect(result.changed.map(row => row.path)).toEqual(["agent.model"]);
		expect((await settings.reloadConfig()).changed).toEqual([]);
	});

	it("reports startup effort as restart-only while applying the model change", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "defaultEffort:\n  '*': low\nagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.writeFile(file, "defaultEffort:\n  '*': high\nagent:\n  model: openai/new\n");
		const result = await settings.reloadConfig();
		expect(settings.get("defaultEffort")).toEqual({ "*": "low" });
		expect(settings.get("agent.model")).toBe("openai/new");
		expect(result.outcomes).toContainEqual({
			path: "defaultEffort",
			status: "restart-required",
			reason: expect.stringContaining("resolveAgentThinkingLevel always supplies a concrete"),
		});
	});

	it("preserves startup defaultModel while applying an agent model in the same file", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, JSON.stringify({ defaultModel: "openai/old", agent: { model: "openai/old" } }));
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.writeFile(file, JSON.stringify({ defaultModel: "openai/new", agent: { model: "openai/new" } }));
		const result = await settings.reloadConfig();
		expect(settings.get("defaultModel")).toBe("openai/old");
		expect(settings.get("agent.model")).toBe("openai/new");
		expect(result.restartRequired).toContain("defaultModel");
		expect(result.outcomes).toContainEqual({
			path: "defaultModel",
			status: "restart-required",
			reason: expect.any(String),
		});
		expect(result.changed).toEqual([{ path: "agent.model", before: "openai/old", after: "openai/new" }]);
	});

	it("retains startup defaultModel without blocking direct lane changes", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(
			file,
			"defaultModel: openai/old\nagent:\n  model: openai/old\n",
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.writeFile(
			file,
			"defaultModel: openai/new\nagent:\n  model: openai/new\n",
		);
		const result = await settings.reloadConfig();
		expect(result.restartRequired).toContain("defaultModel");
		expect(settings.get("defaultModel")).toBe("openai/old");
		expect(settings.get("agent.model")).toBe("openai/new");
	});

	it("re-resolves the advisor runtime model on /reload-config without rebinding Main or existing forks", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const models = ["main-model", "advisor-old", "advisor-new"].map(id =>
			buildModel({
				id,
				name: id,
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 2048,
			}),
		);
		const mainModel = models[0]!;
		const modelRegistry = {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
		} as unknown as ModelRegistry;

		const writeAdvisor = (id: string) =>
			fs.writeFile(
				file,
				JSON.stringify({
					agent: {
						helpers: { advisor: { model: `openai/${id}` } },
						sharedModel: true,
						model: "openai/main-model",
					},
					advisor: { enabled: true },
				}),
			);
		await writeAdvisor("advisor-old");

		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const existingFork = await createSubagentSettingsForCwd(settings, dir);
		const agent = new Agent({
			initialState: {
				model: mainModel,
				systemPrompt: ["Main"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.inMemory(dir);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		liveSessions.push(session);

		expect(session.isAdvisorActive()).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.id).toBe("advisor-old");
		expect(session.model?.id).toBe("main-model");
		expect(resolveAgentModel({ settings: existingFork, agentName: "task" }).patterns).toEqual([
			"openai/main-model",
		]);

		await writeAdvisor("advisor-new");

		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			settings,
			cwd: dir,
			session,
			sessionManager,
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		const dispatchResult = await executeAcpBuiltinSlashCommand("/reload-config", runtime);
		expect(dispatchResult).toEqual({ consumed: true });

		expect(session.getAdvisorAgent()?.state.model.id).toBe("advisor-new");
		expect(session.model?.id).toBe("main-model");
		expect(session.agent.state.model.id).toBe("main-model");
		expect(resolveAgentModel({ settings: existingFork, agentName: "task" }).patterns).toEqual([
			"openai/main-model",
		]);
		expect(existingFork.get("agent.helpers")).toEqual({
			advisor: { model: "openai/advisor-old" },
		});
		expect(output[0]).toContain("config: reloaded");
		const advisor = session.getAdvisorAgent();
		await executeAcpBuiltinSlashCommand("/reload-config", runtime);
		expect(session.getAdvisorAgent()).toBe(advisor);
		expect(output[1]).toContain("No effective routing changes.");
	});

	it("names an unrecognized root key instead of silently accepting it", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "{}");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.writeFile(file, "thinkingLevel: high\nagent:\n  model: openai/new\n  unknownSetting: true\n");
		const result = await settings.reloadConfig();
		expect(result.restartRequired).toEqual(expect.arrayContaining(["thinkingLevel", "agent.unknownSetting"]));
		expect(settings.get("agent.model")).toBe("openai/new");
	});
	it("reloads compaction settings from disk and reports applied values", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(
			file,
			'compaction:\n  threshold: "200000"\n  idleThresholdTokens: 120000\n  keepRecentTokens: 20000\n',
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });

		await fs.writeFile(
			file,
			'compaction:\n  threshold: "400000"\n  idleThresholdTokens: 240000\n  keepRecentTokens: 40000\n',
		);
		const result = await settings.reloadConfig();

		expect(settings.getGroup("compaction")).toMatchObject({
			threshold: "400000",
			idleThresholdTokens: 240000,
			keepRecentTokens: 40000,
		});
		expect(result.outcomes).toContainEqual({
			path: "compaction.threshold",
			status: "applied",
		});
		const unchanged = await settings.reloadConfig();
		expect(unchanged.outcomes).toContainEqual({
			path: "compaction.threshold",
			status: "unchanged",
		});
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
			expect(settings.get("agent.model")).toBe("openai/new");
			expect(notifications).toEqual(["agent.model"]);
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
	function setPath(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
		const segments = dottedPath.split(".");
		let current = obj;
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i];
			const next = current[seg];
			if (!next || typeof next !== "object" || Array.isArray(next)) {
				const nested: Record<string, unknown> = {};
				current[seg] = nested;
				current = nested;
			} else {
				current = next as Record<string, unknown>;
			}
		}
		current[segments[segments.length - 1]] = value;
	}

	// WHY: /reload-config applies spawn routing plus the compaction group and nothing else. A path that
	// is in the schema but in neither set must come back restart-required with its old value kept.
	// CLASS: the table is pinned to the schema's own `compaction.*` paths by exact equality, so a new
	// compaction setting turns this red until someone records a before/after for it. GAP: it does not
	// prove that a running session re-reads the value; that is each consumer's own contract.
	const COMPACTION_RELOAD_CASES: readonly { path: string; before: unknown; after: unknown }[] = [
		{ path: "compaction.enabled", before: true, after: false },
		{ path: "compaction.remote", before: true, after: false },
		{ path: "compaction.midTurnEnabled", before: true, after: false },
		{ path: "compaction.strategy", before: "summary", after: "summary" },
		{ path: "compaction.threshold", before: "200000", after: "400000" },
		{ path: "compaction.thresholdTokens", before: 100000, after: 200000 },
		{ path: "compaction.thresholdPercent", before: 80, after: 90 },
		{ path: "compaction.model", before: "openai/old", after: "openai/new" },
		{ path: "compaction.modelFallbackStrategy", before: "auto", after: "configured-only" },
		{ path: "compaction.modelContextWindow", before: 200000, after: 400000 },
		{ path: "compaction.handoffSaveToDisk", before: false, after: true },
		{ path: "compaction.laneHandoffThresholdTokens", before: 100000, after: 200000 },
		{ path: "compaction.reserveTokens", before: 16000, after: 32000 },
		{ path: "compaction.keepRecentTokens", before: 10000, after: 20000 },
		{ path: "compaction.autoContinue", before: true, after: false },
		{ path: "compaction.remoteEndpoint", before: "https://old.invalid", after: "https://new.invalid" },
		{ path: "compaction.idleEnabled", before: false, after: true },
		{ path: "compaction.idleThresholdTokens", before: 120000, after: 240000 },
		{ path: "compaction.idleTimeoutSeconds", before: 300, after: 600 },
		{ path: "compaction.supersedeReads", before: true, after: false },
		{ path: "compaction.dropUseless", before: true, after: false },
	];

	it("covers every compaction setting the schema declares", () => {
		expect(COMPACTION_RELOAD_CASES.map(row => row.path).sort()).toEqual([...groupSettingPaths("compaction")].sort());
	});

	it("reloads every compaction setting from disk with an applied or unchanged outcome", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const oldRaw: Record<string, unknown> = {};
		const newRaw: Record<string, unknown> = {};
		for (const row of COMPACTION_RELOAD_CASES) {
			setPath(oldRaw, row.path, row.before);
			setPath(newRaw, row.path, row.after);
		}
		await fs.writeFile(file, JSON.stringify(oldRaw));
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.writeFile(file, JSON.stringify(newRaw));

		const result = await settings.reloadConfig();

		expect(result.restartRequired).toEqual([]);
		for (const row of COMPACTION_RELOAD_CASES) {
			const expected = JSON.stringify(row.before) === JSON.stringify(row.after) ? "unchanged" : "applied";
			expect(result.outcomes).toContainEqual({ path: row.path, status: expected });
			expect(settings.get(row.path as SettingPath)).toEqual(row.after);
		}
	});

	it("rejects an invalid compaction value and keeps the previous one", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(
			file,
			JSON.stringify({ compaction: { keepRecentTokens: 20000 }, agent: { model: "openai/old" } }),
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.writeFile(
			file,
			JSON.stringify({ compaction: { keepRecentTokens: "lots" }, agent: { model: "openai/new" } }),
		);

		await expect(settings.reloadConfig()).rejects.toThrow("Invalid config settings");

		expect(settings.get("compaction.keepRecentTokens")).toBe(20000);
		expect(settings.get("agent.model")).toBe("openai/old");
	});

	const RESTART_REQUIRED_BOUNDARY_CASES = [
		{ category: "startup captured", path: "temperature", before: 0.2, after: 0.8 },
		{ category: "outside routing and compaction", path: "git.enabled", before: true, after: false },
		{ category: "outside routing and compaction", path: "retry.enabled", before: true, after: false },
		{
			category: "credential",
			path: "dev.autoqaPush.token",
			before: "dummy-token-initial",
			after: "dummy-token-updated",
		},
		{ category: "credential", path: "firecrawl.apiKey", before: "dummy-key-initial", after: "dummy-key-updated" },
	] as const;

	it.each(RESTART_REQUIRED_BOUNDARY_CASES)(
		"retains old value and reports restart-required for $path ($category)",
		async ({ path: settingPath, before, after }) => {
			const dir = dirs();
			const file = path.join(dir, "config.yml");
			const oldRaw: Record<string, unknown> = {};
			setPath(oldRaw, settingPath, before);
			await fs.writeFile(file, JSON.stringify(oldRaw, null, 2));

			const settings = await Settings.loadReadOnly({ agentDir: dir });
			expect(settings.get(settingPath as SettingPath)).toEqual(before);

			const newRaw: Record<string, unknown> = {};
			setPath(newRaw, settingPath, after);
			await fs.writeFile(file, JSON.stringify(newRaw, null, 2));

			const result = await settings.reloadConfig();

			expect(settings.get(settingPath as SettingPath)).toEqual(before);
			expect(result.restartRequired).toContain(settingPath);
			expect(result.outcomes).toContainEqual(
				expect.objectContaining({
					path: settingPath,
					status: "restart-required",
				}),
			);
		},
	);
});
