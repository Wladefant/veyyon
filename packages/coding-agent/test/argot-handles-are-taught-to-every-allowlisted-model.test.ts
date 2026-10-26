/**
 * An allowlisted model is taught the Argot handle table on every API family, and a model off the
 * allowlist is neither taught one nor reported as a broken arm.
 *
 * WHY. A session on `anthropic/claude-opus-*` logged `argot: launch project armed with 37 handles`
 * and then `argot: system prompt refreshed but the handle table is ABSENT`. Three defects met there:
 *   1. `argot.encode.models` takes the `provider/id:level` spelling every other model setting takes,
 *      but the gate compared each entry to the bare `provider/id`, so an entry such as
 *      `anthropic/claude-fable-5-1:medium` matched nothing and its model was never taught.
 *   2. The launch arm's probe treated every prompt without the table as a failed arm, so a model the
 *      allowlist leaves out on purpose logged an error and an `ABSENT` record.
 *   3. A model switch rebuilt the prompt only when the prompt cohort moved. Two models in one cohort,
 *      one on the allowlist and one off it, kept the previous model's handle table, or its absence.
 *
 * THE CLASS. Every bundled API family is swept from the catalog at run time, so a new family is
 * covered the day it lands, and a family whose session cannot be built fails the sweep rather than
 * dropping out of it. Each family is driven through `createAgentSession` and the session's own
 * prompt refresh, never through a hand-assembled prompt.
 *
 * WHAT IT DOES NOT CATCH. The context-size cutoff: crossing it needs a real turn's usage, so it stays
 * with `argot-gate.test.ts`, which pins the predicate. A prompt section that renders the table under
 * a different banner is caught by `argot-handles-reach-the-model.test.ts`, not here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledChatModels, getBundledModel, getBundledProviders } from "@veyyon/catalog/models";
import * as argotCache from "@veyyon/coding-agent/argot-cache";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { ARGOT_HANDLES_BANNER } from "@veyyon/coding-agent/system-prompt-builder/section-registry";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, logger, setProjectDir, TempDir } from "@veyyon/utils";
import { DICT_FILENAME, parseDict } from "argot";
import { useIsolatedConfigRoot } from "./helpers/isolated-agent-dir";

useIsolatedConfigRoot();

const EXPANSION = "postgres://prod-primary.internal:5432/orders";
const DICT = `
version = 1

[handles]
dbconn = "${EXPANSION}"
`;

/** The first bundled chat model of every API family, by sorted provider then id, so the sweep is stable. */
function oneModelPerApi(): Model<Api>[] {
	const byApi = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders().sort()) {
		const models = getBundledChatModels(provider).sort((a, b) => a.id.localeCompare(b.id));
		for (const model of models) if (!byApi.has(model.api)) byApi.set(model.api, model);
	}
	return [...byApi.values()].sort((a, b) => a.api.localeCompare(b.api));
}

const SWEEP = oneModelPerApi();
const LISTED = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
const UNLISTED = getBundledModel("anthropic", "claude-haiku-4-5") as Model;

let root: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let originalProjectDir: string;
let slug = 0;
const sessions: AgentSession[] = [];

async function build(model: Model, settings: Record<string, unknown>): Promise<AgentSession> {
	slug += 1;
	const project = root.join(`project-${slug}`);
	await fs.mkdir(project, { recursive: true });
	const { session } = await createAgentSession({
		cwd: project,
		agentDir: root.join(`agent-${slug}`),
		sessionManager: SessionManager.inMemory(project),
		settings: Settings.isolated(settings as never),
		authStorage,
		modelRegistry,
		model,
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	sessions.push(session);
	return session;
}

/** Load the fixture dictionary into the session's own codec and refresh its prompt the way an arm does. */
async function armed(session: AgentSession): Promise<string> {
	const argot = session.getArgotSession();
	if (!argot) throw new Error("Expected the session to build an argot codec");
	argot.loadVocab(parseDict(DICT, path.join(session.sessionManager.getCwd(), DICT_FILENAME)));
	return (await session.refreshBaseSystemPrompt("argot vocabulary loaded")).join("\n\n");
}

function argotOn(models: string[]): Record<string, unknown> {
	return { "argot.enabled": true, "argot.autoload": false, "argot.encode.models": models };
}

const promptOf = (session: AgentSession): string => session.systemPrompt.join("\n\n");

beforeAll(async () => {
	originalProjectDir = getProjectDir();
	root = TempDir.createSync("@argot-taught-every-model-");
	authStorage = await AuthStorage.create(root.join("auth.db"));
	for (const model of [...SWEEP, LISTED, UNLISTED]) authStorage.setRuntimeApiKey(model.provider, "test-key");
	modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
});

afterAll(() => {
	setProjectDir(originalProjectDir);
	authStorage.close();
	root.removeSync();
});

describe("every API family teaches the handle table to an allowlisted model", () => {
	it("sweeps more than one API family from the catalog", () => {
		// Guards the sweep itself: an empty or single-family catalog read would leave every case below
		// vacuous while the suite stayed green.
		expect(new Set(SWEEP.map(model => model.api)).size).toBeGreaterThan(1);
	});

	it("builds a session for every swept family", async () => {
		const unconstructable: string[] = [];
		for (const model of SWEEP) {
			try {
				await build(model, argotOn([`${model.provider}/${model.id}`]));
			} catch (error) {
				unconstructable.push(`${model.api} (${model.provider}/${model.id}): ${String(error)}`);
			}
		}
		expect(unconstructable).toEqual([]);
	});

	it.each(SWEEP.map(model => [model.api, model] as const))(
		"%s: an entry spelled with a thinking selector teaches the table",
		async (_api, model) => {
			const session = await build(model, argotOn([`${model.provider}/${model.id}:high`]));
			const prompt = await armed(session);
			expect(prompt).toContain(ARGOT_HANDLES_BANNER);
			expect(prompt).toContain(EXPANSION);
		},
	);

	it.each(SWEEP.map(model => [model.api, model] as const))(
		"%s: a model off the allowlist is taught no table",
		async (_api, model) => {
			const session = await build(model, argotOn(["unlisted-provider/never-a-model:high"]));
			const prompt = await armed(session);
			expect(prompt).not.toContain(ARGOT_HANDLES_BANNER);
			expect(prompt).not.toContain(EXPANSION);
		},
	);

	it("teaches no table while the feature is off, whatever the allowlist names", async () => {
		const session = await build(LISTED, {
			"argot.enabled": false,
			"argot.encode.models": [`${LISTED.provider}/${LISTED.id}`],
		});
		const argot = session.getArgotSession();
		if (argot) argot.loadVocab(parseDict(DICT, DICT_FILENAME));
		const prompt = (await session.refreshBaseSystemPrompt("argot vocabulary loaded")).join("\n\n");
		expect(prompt).not.toContain(ARGOT_HANDLES_BANNER);
	});
});

describe("a model switch inside one prompt cohort follows the allowlist", () => {
	it("drops the table for an unlisted model and restores it for the listed one", async () => {
		// `includeModelInPrompt: false` puts both Claude models in one hidden-policy cohort, which is the
		// case where the cohort key alone saw no change and kept the stale prompt.
		const session = await build(LISTED, {
			...argotOn([`${LISTED.provider}/${LISTED.id}`]),
			includeModelInPrompt: false,
		});
		expect(await armed(session)).toContain(ARGOT_HANDLES_BANNER);

		await session.setModel(UNLISTED);
		expect(promptOf(session)).not.toContain(ARGOT_HANDLES_BANNER);

		await session.setModel(LISTED);
		expect(promptOf(session)).toContain(ARGOT_HANDLES_BANNER);
		expect(promptOf(session)).toContain(EXPANSION);
	});
});

describe("the launch arm reports a deliberately untaught model as decode-only, not as a failure", () => {
	/**
	 * Builds a session whose startup arm loads the fixture dictionary instead of walking a repository,
	 * then waits for the arm's own `argot_taught` record.
	 */
	async function launchArm(model: Model, models: string[]) {
		const done = Promise.withResolvers<void>();
		vi.spyOn(argotCache, "armArgotAfterStartup").mockImplementation(async opts => {
			opts.argot.loadVocab(parseDict(DICT, path.join(opts.cwd, DICT_FILENAME)));
			await opts.onArmed();
			done.resolve();
		});
		const error = vi.spyOn(logger, "error");
		const session = await build(model, { ...argotOn(models), "argot.autoload": true });
		await done.promise;
		const taught = session.sessionManager
			.getEntries()
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === "argot_taught",
			);
		const unarmedErrors = error.mock.calls.filter(([message]) => String(message).includes("UNARMED"));
		return { taught, unarmedErrors };
	}

	it("records the table as taught for a listed model, spelled with a thinking selector", async () => {
		const { taught, unarmedErrors } = await launchArm(LISTED, [`${LISTED.provider}/${LISTED.id}:medium`]);
		const details = taught.map(entry => entry.details);
		expect(details).toEqual([expect.objectContaining({ inPrompt: true, encodes: true })]);
		expect(unarmedErrors).toEqual([]);
	});

	it("records an unlisted model as decode-only and logs no unarmed error", async () => {
		const { taught, unarmedErrors } = await launchArm(UNLISTED, [`${LISTED.provider}/${LISTED.id}`]);
		const details = taught.map(entry => entry.details);
		expect(details).toEqual([expect.objectContaining({ inPrompt: false, encodes: false })]);
		expect(String(taught[0]?.content)).not.toContain("ABSENT");
		expect(unarmedErrors).toEqual([]);
	});
});
