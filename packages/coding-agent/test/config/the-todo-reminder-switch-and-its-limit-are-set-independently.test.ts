/**
 * WHY: the reminder limit was declared as `todo.reminders.max`, beneath the `todo.reminders`
 * switch, and one config key cannot hold a boolean and a group. Setting the limit while reminders
 * were off replaced the stored `todo.reminders: false` with `{ max: N }`, which turned reminders
 * back on, and turning reminders off dropped the limit. The limit is `todo.reminderLimit` now, the
 * schema registry rejects any path that is the parent of another (its own suite in the kernel
 * covers that class), and a stored `todo.reminders.max` is folded onto the new key at load.
 *
 * Each case loads a real config file through the settings loader, writes through `set`, and reads
 * the written file and a fresh load back.
 *
 * Not caught: a `todo.reminders` group holding a key other than `max`, which this build never
 * declared and the migration drops with the group.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeAgentDir = useTrackedTempDirs("veyyon-todo-reminder-limit-");

describe("the todo reminder switch and its limit", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeAgentDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "todo-reminder-limit"));
			agentDir = "";
		}
	});

	const configPath = () => path.join(agentDir, "config.yml");

	async function load(config: Record<string, unknown>): Promise<Settings> {
		fs.writeFileSync(configPath(), YAML.stringify(config));
		return await Settings.loadIsolated({ agentDir, cwd: agentDir });
	}

	async function written(settings: Settings): Promise<unknown> {
		await settings.flush();
		return YAML.parse(fs.readFileSync(configPath(), "utf8"));
	}

	async function reloaded(): Promise<{ reminders: boolean; limit: number }> {
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		return { reminders: settings.get("todo.reminders"), limit: settings.get("todo.reminderLimit") };
	}

	test("setting the limit while reminders are off keeps them off", async () => {
		const settings = await load({ todo: { reminders: false } });
		settings.set("todo.reminderLimit", 5);

		expect(await written(settings)).toEqual({ todo: { reminders: false, reminderLimit: 5 } });
		expect(await reloaded()).toEqual({ reminders: false, limit: 5 });
	});

	test("turning reminders off keeps the limit", async () => {
		const settings = await load({ todo: { reminderLimit: 2 } });
		settings.set("todo.reminders", false);

		expect(await written(settings)).toEqual({ todo: { reminders: false, reminderLimit: 2 } });
		expect(await reloaded()).toEqual({ reminders: false, limit: 2 });
	});

	test.each([
		["nested", { todo: { reminders: { max: 5 } } }, 5],
		["flat", { "todo.reminders.max": 2 }, 2],
	])(
		"a %s todo.reminders.max loads as the limit, with reminders on, and leaves the file",
		async (_shape, config, limit) => {
			const settings = await load(config);
			expect(settings.get("todo.reminders")).toBe(true);
			expect(settings.get("todo.reminderLimit")).toBe(limit);
			expect(settings.invalidValues).toEqual([]);

			settings.set("ask.notify", "on");
			expect(await written(settings)).toEqual({ todo: { reminderLimit: limit }, ask: { notify: "on" } });
			expect(await reloaded()).toEqual({ reminders: true, limit });
		},
	);

	test.each([
		["nested", { todo: { reminders: { max: 5 }, reminderLimit: 2 } }],
		["flat", { "todo.reminderLimit": 2, todo: { reminders: { max: 5 } } }],
	])("a %s todo.reminderLimit already stored wins over todo.reminders.max", async (_shape, config) => {
		const settings = await load(config);
		expect(settings.get("todo.reminderLimit")).toBe(2);

		settings.set("ask.notify", "on");
		expect(await written(settings)).toEqual({ todo: { reminderLimit: 2 }, ask: { notify: "on" } });
	});
});
