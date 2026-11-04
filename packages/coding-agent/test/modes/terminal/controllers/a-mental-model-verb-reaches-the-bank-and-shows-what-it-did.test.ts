/**
 * `/memory mm <verb>` (`CommandController.handleMemoryCommand`) runs one call against the session's Hindsight
 * bank and shows one outcome.
 *
 * Contracts:
 *  - the verbs run only on the session's own Hindsight state with mental models enabled; an aliased (agent) state
 *    or the disabled setting is refused before the bank is called;
 *  - `list` shows the bank's models sorted by id, or a status for an empty bank;
 *  - `show` and `history` need an id, report a missing model, and otherwise show a panel; `history` diffs each
 *    entry against the content after it, the newest against the model's current content;
 *  - `seed` creates every built-in seed for the scope that the bank does not hold yet, counts the rest as present,
 *    and warns per seed that fails without stopping the others;
 *  - `refresh` without an id touches only the models that opted into auto-refresh, and says so when none did;
 *  - `delete` removes the model and reloads the session's mental-model cache, or reports a missing model;
 *  - `reload` reports whether the cache reloaded;
 *  - a bank call that throws shows an error naming the verb, and an unknown verb prints the verb usage.
 *
 * Subject: `modes/terminal/controllers/memory-command-controller.ts`, driven through
 * `CommandController.handleMemoryCommand`.
 *
 * Gap: `refresh` paths that queue a refresh wait a fixed grace period on a real timer before reloading, so they
 * are not driven here; the empty and none-opted-in paths that return before it are. The Hindsight client's own
 * wire calls are owned by the Hindsight suites.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { MentalModelSummary } from "@veyyon/coding-agent/memory/hindsight";
import { resolveSeedsForScope, seedAlreadyExists } from "@veyyon/coding-agent/memory/hindsight";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import type { Component } from "@veyyon/tui";
import { useTruecolorTheme } from "../../../helpers/theme-assertions";

useTruecolorTheme("dark");

const BANK = "bank-a";
const VERB_USAGE = "Usage: /memory mm <list|show|refresh|history|seed|reload|delete>";

interface HistoryEntry {
	previous_content: string | null;
	changed_at: string;
}

interface Bank {
	models: MentalModelSummary[];
	history?: HistoryEntry[];
	/** Thrown by every bank call, when set. */
	failure?: Error;
	/** Seed ids whose creation fails. */
	failingSeeds?: string[];
	reloads?: boolean;
}

interface MmRun {
	statuses: string[];
	warnings: string[];
	errors: string[];
	panels: string[];
	/** Every bank call, in order, as `verb arg`. */
	calls: string[];
	reloaded: number;
}

function summary(id: string, overrides: Partial<MentalModelSummary> = {}): MentalModelSummary {
	return { id, name: `Model ${id}`, ...overrides } as MentalModelSummary;
}

async function runMm(
	command: string,
	bank: Bank,
	stateOverrides: { aliasOf?: unknown; mentalModelsEnabled?: boolean } = {},
): Promise<MmRun> {
	const run: MmRun = { statuses: [], warnings: [], errors: [], panels: [], calls: [], reloaded: 0 };
	const fail = () => {
		if (bank.failure) throw bank.failure;
	};
	const client = {
		listMentalModels: async (bankId: string, options: { detail: string }) => {
			run.calls.push(`list ${bankId} ${options.detail}`);
			fail();
			return { items: bank.models };
		},
		getMentalModel: async (bankId: string, id: string) => {
			run.calls.push(`get ${bankId} ${id}`);
			fail();
			return bank.models.find(model => model.id === id) ?? null;
		},
		getMentalModelHistory: async (bankId: string, id: string) => {
			run.calls.push(`history ${bankId} ${id}`);
			fail();
			return bank.history ?? [];
		},
		createMentalModel: async (bankId: string, _name: string, _query: string, options: { id: string }) => {
			run.calls.push(`create ${bankId} ${options.id}`);
			fail();
			if (bank.failingSeeds?.includes(options.id)) throw new Error("bank refused the seed");
			return {};
		},
		refreshMentalModel: async (bankId: string, id: string) => {
			run.calls.push(`refresh ${bankId} ${id}`);
			fail();
		},
		deleteMentalModel: async (bankId: string, id: string) => {
			run.calls.push(`delete ${bankId} ${id}`);
			fail();
			return bank.models.some(model => model.id === id);
		},
	};
	const state = {
		bankId: BANK,
		client,
		aliasOf: stateOverrides.aliasOf,
		config: { mentalModelsEnabled: stateOverrides.mentalModelsEnabled ?? true },
		retainTags: ["project:repo"],
		recallTags: ["project:repo"],
		recallTagsMatch: "any",
		reloadMentalModels: async () => {
			run.reloaded++;
			return bank.reloads ?? true;
		},
		session: undefined as unknown,
	};
	const session = { getHindsightSessionState: () => state };
	state.session = session;
	const ctx = {
		settings: { getAgentDir: () => "/agent", get: () => undefined },
		sessionManager: { getCwd: () => "/repo" },
		session,
		present: (block: Component) => {
			run.panels.push(stripVTControlCharacters(block.render(120).join("\n")));
		},
		showStatus: (message: string) => run.statuses.push(message),
		showWarning: (message: string) => run.warnings.push(message),
		showError: (message: string) => run.errors.push(message),
	} as unknown as CommandControllerContext;
	await new CommandController(ctx).handleMemoryCommand(command);
	return run;
}

function shown(run: MmRun) {
	return { statuses: run.statuses, warnings: run.warnings, errors: run.errors, panels: run.panels.length };
}

describe("a mental-model verb runs only on the session's own enabled bank", () => {
	it("refuses an agent's aliased state without calling the bank", async () => {
		const run = await runMm("/memory mm list", { models: [summary("a")] }, { aliasOf: {} });
		expect(shown(run)).toEqual({
			statuses: [],
			warnings: [],
			errors: ["Hindsight backend is not active for this session."],
			panels: 0,
		});
		expect(run.calls).toEqual([]);
	});

	it("refuses while mental models are disabled", async () => {
		const run = await runMm("/memory mm list", { models: [summary("a")] }, { mentalModelsEnabled: false });
		expect(run.errors).toEqual(["Mental models are disabled (hindsight.mentalModelsEnabled = false)."]);
		expect(run.calls).toEqual([]);
	});

	it("prints the verb usage for an unknown verb", async () => {
		const run = await runMm("/memory mm prune", { models: [] });
		expect(shown(run)).toEqual({ statuses: [], warnings: [], errors: [VERB_USAGE], panels: 0 });
		expect(run.calls).toEqual([]);
	});
});

describe("list", () => {
	it("shows the bank's models sorted by id", async () => {
		const run = await runMm("/memory mm list", {
			models: [summary("zeta"), summary("alpha", { tags: ["user"], last_refreshed_at: "2026-01-02" })],
		});
		expect(run.calls).toEqual([`list ${BANK} metadata`]);
		expect(run.panels).toHaveLength(1);
		const panel = run.panels[0];
		expect(panel).toContain(`Mental Models — ${BANK}`);
		const alpha = panel.indexOf("alpha: Model alpha [user] (refreshed 2026-01-02)");
		const zeta = panel.indexOf("zeta: Model zeta (never refreshed)");
		expect(alpha).toBeGreaterThan(-1);
		expect(zeta).toBeGreaterThan(alpha);
	});

	it("reports an empty bank as a status", async () => {
		const run = await runMm("/memory mm list", { models: [] });
		expect(shown(run)).toEqual({
			statuses: [`No mental models on bank ${BANK}.`],
			warnings: [],
			errors: [],
			panels: 0,
		});
	});

	it("names the verb when the bank call fails", async () => {
		const run = await runMm("/memory mm list", { models: [], failure: new Error("bank offline") });
		expect(run.errors).toEqual(["mm list failed: bank offline"]);
	});
});

describe("show", () => {
	it("needs an id", async () => {
		const run = await runMm("/memory mm show", { models: [] });
		expect(run.errors).toEqual(["Usage: /memory mm show <id>"]);
		expect(run.calls).toEqual([]);
	});

	it("reports a model the bank does not hold", async () => {
		const run = await runMm("/memory mm show ghost", { models: [] });
		expect(run.errors).toEqual(["Mental model not found: ghost"]);
	});

	it("shows the model's name, id, source query and content", async () => {
		const run = await runMm("/memory mm show prefs", {
			models: [summary("prefs", { name: "Preferences", content: "Prefers tabs.", source_query: "what style?" })],
		});
		expect(run.calls).toEqual([`get ${BANK} prefs`]);
		expect(run.panels).toHaveLength(1);
		const panel = run.panels[0];
		for (const text of ["Preferences", "prefs", "Source query:", "what style?", "Prefers tabs."]) {
			expect(panel).toContain(text);
		}
	});

	it("names the verb when the bank call fails", async () => {
		const run = await runMm("/memory mm show prefs", { models: [], failure: new Error("bank offline") });
		expect(run.errors).toEqual(["mm show failed: bank offline"]);
	});
});

describe("history", () => {
	it("needs an id", async () => {
		const run = await runMm("/memory mm history", { models: [] });
		expect(run.errors).toEqual(["Usage: /memory mm history <id>"]);
	});

	it("reports a model with no recorded history", async () => {
		const run = await runMm("/memory mm history prefs", { models: [summary("prefs", { content: "now" })] });
		expect(run.statuses).toEqual(["No history recorded for prefs."]);
	});

	it("diffs the newest entry against the current content and each older entry against the one after it", async () => {
		const run = await runMm("/memory mm history prefs", {
			models: [summary("prefs", { name: "Preferences", content: "line-current" })],
			history: [
				{ previous_content: "line-middle", changed_at: "2026-03-02" },
				{ previous_content: "line-oldest", changed_at: "2026-03-01" },
			],
		});
		expect(run.panels).toHaveLength(1);
		const panel = run.panels[0];
		const newest = panel.indexOf("2026-03-02");
		const oldest = panel.indexOf("2026-03-01");
		expect(newest).toBeGreaterThan(-1);
		expect(oldest).toBeGreaterThan(newest);
		const newestSection = panel.slice(newest, oldest);
		const oldestSection = panel.slice(oldest);
		// The panel renders the diff as a markdown code block, which sets each marker off by a space.
		expect(newestSection).toMatch(/-\s+line-middle/);
		expect(newestSection).toMatch(/\+\s+line-current/);
		expect(oldestSection).toMatch(/-\s+line-oldest/);
		expect(oldestSection).toMatch(/\+\s+line-middle/);
	});
});

describe("seed", () => {
	const seeds = resolveSeedsForScope(
		{ bankId: BANK, retainTags: ["project:repo"], recallTags: ["project:repo"], recallTagsMatch: "any" },
		"per-project-tagged",
	);

	it("has built-in seeds for the default scoping, or the cases below prove nothing", () => {
		expect(seeds.length).toBeGreaterThan(1);
	});

	it("creates every seed the bank does not hold and counts the rest as present", async () => {
		const held = summary(seeds[0].id, { name: seeds[0].name, tags: seeds[0].tags });
		expect(seedAlreadyExists(seeds[0], [held])).toBe(true);
		const run = await runMm("/memory mm seed", { models: [held] });
		const created = seeds.slice(1).map(seed => `create ${BANK} ${seed.id}`);
		expect(run.calls).toEqual([`list ${BANK} metadata`, ...created]);
		expect(run.statuses).toEqual([`Seeded ${seeds.length - 1} new mental model(s); 1 already present.`]);
		expect(run.warnings).toEqual([]);
	});

	it("warns for a seed the bank refuses and still creates the others", async () => {
		const refused = seeds[0].id;
		const run = await runMm("/memory mm seed", { models: [], failingSeeds: [refused] });
		expect(run.calls).toEqual([`list ${BANK} metadata`, ...seeds.map(seed => `create ${BANK} ${seed.id}`)]);
		expect(run.warnings).toEqual([`Seed failed for ${refused}: bank refused the seed`]);
		expect(run.statuses).toEqual([`Seeded ${seeds.length - 1} new mental model(s); 0 already present.`]);
	});
});

describe("refresh without an id", () => {
	it("reports an empty bank", async () => {
		const run = await runMm("/memory mm refresh", { models: [] });
		expect(run.calls).toEqual([`list ${BANK} content`]);
		expect(run.statuses).toEqual([`No mental models on bank ${BANK}.`]);
		expect(run.reloaded).toBe(0);
	});

	it("touches no curated model when none opted into auto-refresh", async () => {
		const run = await runMm("/memory mm refresh", {
			models: [summary("curated-a"), summary("curated-b", { trigger: { refresh_after_consolidation: false } })],
		});
		expect(run.calls).toEqual([`list ${BANK} content`]);
		expect(run.statuses).toEqual([
			"No mental models opted into auto-refresh; 2 curated model(s) left untouched. Pass an explicit id to refresh one of them.",
		]);
	});
});

describe("delete and reload", () => {
	it("needs an id to delete", async () => {
		const run = await runMm("/memory mm delete", { models: [] });
		expect(run.errors).toEqual(["Usage: /memory mm delete <id>"]);
	});

	it("deletes the model and reloads the session's cache", async () => {
		const run = await runMm("/memory mm remove prefs", { models: [summary("prefs")] });
		expect(run.calls).toEqual([`delete ${BANK} prefs`]);
		expect(run.reloaded).toBe(1);
		expect(run.statuses).toEqual([`Deleted mental model prefs from bank ${BANK}.`]);
	});

	it("reports a model the bank does not hold and reloads nothing", async () => {
		const run = await runMm("/memory mm delete ghost", { models: [] });
		expect(run.errors).toEqual(["Mental model not found: ghost"]);
		expect(run.reloaded).toBe(0);
	});

	it("reports a reloaded cache", async () => {
		const run = await runMm("/memory mm reload", { models: [] });
		expect(run.statuses).toEqual(["Mental-model cache reloaded."]);
		expect(run.reloaded).toBe(1);
	});

	it("reports a cache that did not reload", async () => {
		const run = await runMm("/memory mm reload", { models: [], reloads: false });
		expect(run.errors).toEqual(["Reload failed (Hindsight backend not active or mental models disabled)."]);
	});
});
