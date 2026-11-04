/**
 * WHY: model roles (`modelRoles`, `cycleOrder`, `modelTags`, `@role` selectors)
 * were removed. The session model is `defaultModel` and each feature that ran
 * on a role reads its own row under `agent.helpers`. A config written before
 * the removal still holds the role table, and the loader must carry every
 * choice it made to the setting that now owns it rather than dropping the
 * user's models on the floor or leaving a dead key behind.
 *
 * The class closed: a role value that a helper used to read is lost, a helper
 * reads a different role than it used to, an `@role` reference survives into a
 * model chain where nothing expands it any more, or a value with no successor
 * vanishes without a report. The helper sweep enumerates `HELPER_IDS`, so a new
 * helper fails here until its legacy role sources are recorded.
 *
 * Gap: the suite checks the migrated settings, not what the features do with
 * them; `every-helper-runs-the-session-model-until-configured` covers that.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HELPER_IDS, type HelperId, helperModelPatterns } from "@veyyon/coding-agent/task/helper-settings";
import { logger } from "@veyyon/utils";
import * as YAML from "yaml";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeAgentDir = useTrackedTempDirs("veyyon-model-roles-migration-");

/** The roles each helper read before it had its own row, in the order it tried them. */
const LEGACY_SOURCES: Record<HelperId, readonly string[]> = {
	advisor: ["advisor"],
	plan: ["plan"],
	vision: ["vision"],
	commit: ["commit", "smol"],
	title: ["tiny", "commit", "smol"],
	memory: ["tiny", "smol"],
	autoThinking: ["tiny", "smol"],
	unexpectedStop: ["tiny", "smol"],
	speech: ["tiny", "smol"],
	completion: [],
};

const ROLE_NAMES = ["advisor", "plan", "vision", "commit", "tiny", "smol"] as const;

let agentDir = "";

beforeEach(() => {
	agentDir = makeAgentDir();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function load(config: Record<string, unknown>): Promise<Settings> {
	fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	return Settings.loadIsolated({ agentDir, cwd: agentDir });
}

function roleModel(role: string): string {
	return `legacy/${role}-model`;
}

describe("a config holding model roles loads as defaultModel and helpers", () => {
	test("every helper has its legacy role sources recorded", () => {
		expect(Object.keys(LEGACY_SOURCES).sort()).toEqual([...HELPER_IDS].sort());
	});

	test("modelRoles.default becomes defaultModel, keeping its chain and effort", async () => {
		const settings = await load({ modelRoles: { default: ["openai/gpt-5:high", "anthropic/claude-sonnet-5"] } });
		expect(settings.get("defaultModel")).toEqual(["openai/gpt-5:high", "anthropic/claude-sonnet-5"]);
	});

	test("the interactive alias becomes defaultModel when default is absent", async () => {
		const settings = await load({ modelRoles: { interactive: "openai/gpt-5" } });
		expect(settings.get("defaultModel")).toBe("openai/gpt-5");
	});

	test("a defaultModel already on disk wins over the role", async () => {
		const settings = await load({
			defaultModel: "openai/gpt-5",
			modelRoles: { default: "anthropic/claude-sonnet-5" },
		});
		expect(settings.get("defaultModel")).toBe("openai/gpt-5");
	});

	/**
	 * For each helper and each position in its source list, set only the roles
	 * from that position on: the helper must take exactly the role at that
	 * position. Then set every role: it must take the first.
	 */
	for (const id of HELPER_IDS) {
		const sources = LEGACY_SOURCES[id];
		test(`the ${id} helper takes the first of ${JSON.stringify(sources)} that is set`, async () => {
			for (let first = 0; first < sources.length; first++) {
				const roles = Object.fromEntries(sources.slice(first).map(role => [role, roleModel(role)]));
				const settings = await load({ modelRoles: roles });
				expect(helperModelPatterns(settings, id)).toEqual([roleModel(sources[first])]);
			}
			const unrelated = Object.fromEntries(
				ROLE_NAMES.filter(role => !sources.includes(role)).map(role => [role, roleModel(role)]),
			);
			const settings = await load({ modelRoles: unrelated });
			expect(helperModelPatterns(settings, id)).toEqual([]);
		});
	}

	test("a helper model already on disk wins over every role", async () => {
		const settings = await load({
			modelRoles: Object.fromEntries(ROLE_NAMES.map(role => [role, roleModel(role)])),
			agent: { helpers: Object.fromEntries(HELPER_IDS.map(id => [id, { model: `kept/${id}` }])) },
		});
		for (const id of HELPER_IDS) expect(helperModelPatterns(settings, id)).toEqual([`kept/${id}`]);
	});

	test("an @role, pi/role or * reference in a model chain becomes the role's models", async () => {
		const settings = await load({
			modelRoles: { default: "p/main", smol: ["p/small", "p/small-backup"], slow: "p/large:low" },
			agent: { model: "@slow:high", agents: { scout: { model: ["@smol", "p/backup"] } } },
			compaction: { model: "pi/smol" },
			retry: { fallbackChains: { default: ["*", "p/other"] } },
		});
		expect(settings.get("agent.model")).toBe("p/large:high");
		expect(settings.get("agent.agents").scout?.model).toEqual(["p/small", "p/small-backup", "p/backup"]);
		expect(settings.get("compaction.model")).toBe("p/small,p/small-backup");
		expect(settings.get("retry.fallbackChains")).toEqual({ default: ["p/main", "p/other"] });
	});

	test("values with no successor are dropped and every one is reported", async () => {
		const warn = vi.spyOn(logger, "warn");
		const settings = await load({
			modelRoles: { default: "p/main", slow: "p/large", reviewer: "p/custom" },
			cycleOrder: ["smol", "slow"],
			modelTags: { fast: { name: "Fast" } },
			agent: { model: ["@unset-role", "p/kept"] },
			retry: { fallbackChains: { smol: ["p/x"], "p/main": ["p/y"] } },
		});
		expect(settings.get("agent.model")).toEqual(["p/kept"]);
		expect(settings.get("retry.fallbackChains")).toEqual({ "p/main": ["p/y"] });
		const report = warn.mock.calls.find(([message]) => String(message).includes("model roles were removed"));
		expect(report).toBeDefined();
		const fields = report?.[1] as { dropped: string[] } | undefined;
		expect(fields?.dropped.sort()).toEqual(
			[
				"@unset-role",
				"cycleOrder",
				"modelRoles.reviewer=p/custom",
				"modelRoles.slow=p/large",
				"modelTags",
				"retry.fallbackChains.smol",
			].sort(),
		);
	});

	test("a config with nothing to drop reports nothing", async () => {
		const warn = vi.spyOn(logger, "warn");
		await load({ modelRoles: { default: "p/main", tiny: "p/tiny" } });
		expect(warn.mock.calls.some(([message]) => String(message).includes("model roles were removed"))).toBe(false);
	});

	test("the interactive retry chain becomes the default chain", async () => {
		const settings = await load({ retry: { fallbackChains: { interactive: ["p/a", "p/b"] } } });
		expect(settings.get("retry.fallbackChains")).toEqual({ default: ["p/a", "p/b"] });
	});

	test("mnemopi.llmMode smol becomes online, the memory helper", async () => {
		const settings = await load({ mnemopi: { llmMode: "smol" } });
		// The stored value, not `get`: `smol` is outside the enum, which already reads as the default.
		expect(settings.layerValue("profile", ["mnemopi", "llmMode"])).toBe("online");
	});

	test("the role keys are gone from the file written back", async () => {
		const settings = await load({
			modelRoles: { default: "p/main", plan: "p/plan" },
			cycleOrder: ["smol"],
			modelTags: { fast: {} },
		});
		settings.set("defaultModel", "p/main");
		await settings.flush();
		const onDisk = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
		expect(onDisk.modelRoles).toBeUndefined();
		expect(onDisk.cycleOrder).toBeUndefined();
		expect(onDisk.modelTags).toBeUndefined();
		expect(onDisk.defaultModel).toBe("p/main");
		const agent = onDisk.agent as { helpers?: Record<string, { model?: unknown }> } | undefined;
		expect(agent?.helpers?.plan?.model).toBe("p/plan");
	});
});
