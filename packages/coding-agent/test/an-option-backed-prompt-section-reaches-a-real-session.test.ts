/**
 * Every option-backed prompt section reaches the system prompt of a session built by
 * `createAgentSession` once its setting or state is on, and stays out while it is off.
 *
 * WHY. A settings-gated section reaches the model through four links: setting, a
 * `BuildSystemPromptOptions` field, the value the session factory resolves, and the assembled
 * prompt. The builder tests pass the option in directly, so they never exercise the factory link: a
 * section whose option was declared and threaded through, yet never set at the real call site,
 * compiled and rendered nothing. This suite drives the factory, and its scenario table is pinned to
 * the registry, so a new option-backed section fails here until it has a scenario.
 *
 * WHAT IT DOES NOT CATCH. The content of each section beyond the value that proves it was wired;
 * system-prompt-wiring.test.ts proves each section renders exactly what its option carries.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { OPTION_BACKED_RUNTIME_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";
import { DICT_FILENAME, parseDict } from "argot";
import { useIsolatedConfigRoot } from "./helpers/isolated-agent-dir";

const getConfigRoot = useIsolatedConfigRoot();
const MODEL = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
const DICT = `
version = 1

[handles]
dbconn = "postgres://prod-primary.internal:5432/orders"
`;

/** Settings that open the shorthand encode gate for {@link MODEL}, with no startup walk. */
const ARGOT_ON = { "argot.enabled": true, "argot.autoload": false, "argot.encode.models": [MODEL.id] };

interface Scenario {
	/** Builds the session with the section switched on. */
	on(project: string, agentDir: string): Promise<AgentSession>;
	/** Text that appears only when the section carries the session's real value. */
	value: string;
}

let root: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let originalProjectDir: string;
const sessions: AgentSession[] = [];

async function build(project: string, agentDir: string, settings: Settings): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		sessionManager: SessionManager.inMemory(project),
		settings,
		modelRegistry,
		model: MODEL,
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

const SCENARIOS: Record<string, Scenario> = {
	"available-secrets": {
		async on(project, agentDir) {
			const vault = new SecretVault({
				globalConfigRoot: getConfigRoot(),
				profileDir: agentDir,
				projectDir: path.join(project, ".veyyon"),
			});
			await vault.add({ name: "WIRED_TOKEN", value: "wired-token-value-0001", scope: "project" });
			return build(project, agentDir, Settings.isolated({ "secrets.enabled": true }));
		},
		value: "WIRED_TOKEN",
	},
	shorthand: {
		on: (project, agentDir) => build(project, agentDir, Settings.isolated(ARGOT_ON)),
		value: "argot_load",
	},
	"shorthand-handles": {
		async on(project, agentDir) {
			const session = await build(project, agentDir, Settings.isolated(ARGOT_ON));
			const argot = session.getArgotSession();
			if (!argot) throw new Error("Expected the session to build an argot codec");
			argot.loadVocab(parseDict(DICT, path.join(project, DICT_FILENAME)));
			await session.refreshBaseSystemPrompt("argot vocabulary loaded");
			return session;
		},
		value: "postgres://prod-primary.internal:5432/orders",
	},
};

/** The text of `section` in the session's prompt, from its banner to the next blank-line banner. */
function sectionText(session: AgentSession, name: string): string | undefined {
	const joined = session.systemPrompt.join("\n");
	const start = joined.indexOf(renderBanner(name));
	return start < 0 ? undefined : joined.slice(start);
}

describe("an option-backed prompt section reaches a real session", () => {
	beforeAll(async () => {
		originalProjectDir = getProjectDir();
		root = TempDir.createSync("@option-backed-section-");
		authStorage = await AuthStorage.create(root.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	afterAll(() => {
		setProjectDir(originalProjectDir);
		authStorage.close();
		root.removeSync();
	});

	it("has a scenario for every option-backed section the registry declares", () => {
		expect(Object.keys(SCENARIOS).sort()).toEqual(OPTION_BACKED_RUNTIME_SECTIONS.map(section => section.id).sort());
	});

	it.each(OPTION_BACKED_RUNTIME_SECTIONS.map(section => [section.id, section] as const))(
		"renders %s from the session's own state",
		async (id, section) => {
			const scenario = SCENARIOS[id];
			if (!scenario) throw new Error(`No scenario for ${id}`);
			const project = root.join(`on-${id}`);
			const agentDir = root.join(`agent-${id}`);
			await fs.mkdir(project, { recursive: true });

			const session = await scenario.on(project, agentDir);

			expect(sectionText(session, section.name)).toContain(scenario.value);
		},
	);

	it.each([
		["every one switched off", "off", {}],
		[
			"shorthand on but the model off its allowlist",
			"gate",
			{ ...ARGOT_ON, "argot.encode.models": ["another-model"] },
		],
	] as const)("renders none of them in a session with %s", async (_label, slug, overrides) => {
		const project = root.join(slug);
		const agentDir = root.join(`agent-${slug}`);
		await fs.mkdir(project, { recursive: true });

		const session = await build(project, agentDir, Settings.isolated(overrides));

		expect(OPTION_BACKED_RUNTIME_SECTIONS.filter(section => sectionText(session, section.name))).toEqual([]);
	});
});
