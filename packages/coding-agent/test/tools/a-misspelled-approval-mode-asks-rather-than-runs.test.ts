/**
 * A `tools.approvalMode` value in a config file that is not one of its members reads as `ask`, the
 * strictest rung, and the session reports the file to edit.
 *
 * WHY. The settings store answered an out-of-set enum value with the declared default, and the
 * default of `tools.approvalMode` is `auto`. A hand-edited `approvalMode: askk`, written to make
 * every call prompt, therefore granted `auto`: an exec-tier call ran without a prompt. The startup
 * check read the already-substituted `auto`, found it valid, and reported nothing, so the loosened
 * rung was also silent. The store now reads an out-of-set value as the declaration's `invalid`
 * member (`ask` here, the default when a declaration names none), and the session reports every
 * configured value that does not match its declared type in `configWarnings`.
 *
 * THE CLASS. Every misspelling of every accepted mode, derived from `APPROVAL_MODE_VALUES` at run
 * time, plus the non-string shapes a YAML file produces, observed at the tool wrapper as a prompt
 * that happened rather than as a returned string. Every enum setting in the loaded schema is swept
 * for the report; the read of each, and the set that declares an `invalid` member, are pinned by
 * `an-enum-value-outside-its-set-reads-as-its-declared-fallback.test.ts`.
 *
 * WHAT IT DOES NOT CATCH. A new safety enum whose default is not its strictest member and that
 * declares no `invalid` member reads a typo as its default; nothing here can tell that a member is
 * stricter than another. A value set through the CLI or a runtime override does not pass the file
 * loader and is not in `configWarnings`; `normalizeApprovalMode` fails it closed separately.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { APPROVAL_MODE_VALUES } from "@veyyon/coding-agent/tools/core/approval-modes";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { SettingPath } from "@veyyon/kernel/settings/schema";
import { type } from "arktype";
import * as YAML from "yaml";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeDir = useTrackedTempDirs("veyyon-misspelled-approval-mode-");

/** Every declaration, read structurally: a table's literal entries carry readonly defaults. */
const DECLARATIONS = Object.entries(SETTINGS_SCHEMA as Record<string, { type: string; default?: unknown }>);

/** A nested config tree holding `value` at the dotted `settingPath`. */
function treeAt(settingPath: string, value: unknown): Record<string, unknown> {
	const segments = settingPath.split(".");
	const tree: Record<string, unknown> = {};
	let node = tree;
	for (const segment of segments.slice(0, -1)) {
		node[segment] = {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments.at(-1) as string] = value;
	return tree;
}

/** A value no enum in the schema accepts. */
const NOT_A_MEMBER = "not-a-member";

/**
 * Misspellings derived from the accepted set, so a new mode gets its own: a trailing letter, a
 * dropped letter, a shouted form and a padded form. A YAML file is where the remaining shapes come
 * from: a number, a boolean, a key written with no value, a map and a list.
 */
const MISSPELLED: unknown[] = [
	...APPROVAL_MODE_VALUES.flatMap(mode => [`${mode}x`, mode.slice(0, -1), mode.toUpperCase(), ` ${mode}`]),
	42,
	true,
	null,
	{ mode: "ask" },
	["ask"],
].filter(value => !(APPROVAL_MODE_VALUES as readonly unknown[]).includes(value));

/** Load a real settings file, the way a hand-edit arrives. */
async function settingsFromFile(tree: Record<string, unknown>): Promise<{ settings: Settings; file: string }> {
	const agentDir = makeDir();
	const file = path.join(agentDir, "config.yml");
	fs.writeFileSync(file, YAML.stringify(tree));
	return { settings: await Settings.loadIsolated({ agentDir, cwd: agentDir }), file };
}

/** The prompt cards the real wrapper raised for one exec-tier call, and whether the call ran. */
async function execCall(settings: Settings): Promise<{ cards: string[]; ran: boolean }> {
	const sentinel = path.join(makeDir(), "ran");
	const tool = {
		name: "lookup",
		label: "lookup",
		summary: "writes a sentinel file when it runs",
		description: "writes a sentinel file when it runs",
		parameters: type({}),
		approval: () => "exec",
		execute: async () => {
			fs.writeFileSync(sentinel, "ran");
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	// A hand-built stub: the wrapper reads only the members spelled above.
	const asTool = tool as unknown as AgentTool;
	const cards: string[] = [];
	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({
			select: async (body: string) => {
				cards.push(body);
				return "Approve";
			},
		}),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	};
	const context = {
		settings,
		sessionManager: { getCwd: () => path.dirname(sentinel), getSessionId: () => "session-under-test" },
	};
	const wrapped = new ExtensionToolWrapper(asTool, runner as unknown as ExtensionRunner);
	await wrapped.execute("call-1", {}, undefined, undefined, context as unknown as AgentToolContext);
	return { cards, ran: fs.existsSync(sentinel) };
}

describe("a misspelled approval mode reads as ask", () => {
	it.each(MISSPELLED.map(value => [JSON.stringify(value), value]))("reads %s as ask", async (_label, value) => {
		const { settings } = await settingsFromFile({ tools: { approvalMode: value } });

		expect(settings.get("tools.approvalMode")).toBe("ask");
	});

	it("prompts before an exec-tier call that the default rung would run unasked", async () => {
		const typo = await execCall((await settingsFromFile({ tools: { approvalMode: "askk" } })).settings);
		const unset = await execCall((await settingsFromFile({})).settings);

		expect(typo.cards).toHaveLength(1);
		expect(unset.cards).toEqual([]);
		expect(unset.ran).toBe(true);
	});

	it("keeps every accepted mode as written", async () => {
		for (const mode of APPROVAL_MODE_VALUES) {
			const { settings } = await settingsFromFile({ tools: { approvalMode: mode } });
			expect(settings.get("tools.approvalMode")).toBe(mode);
		}
	});
});

describe("the session reports a configured value that does not match its declaration", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(path.join(makeDir(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose();
		authStorage.close();
	});

	function sessionFor(settings: Settings): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected a bundled model for the session fixture");
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (m, context, options) => {
				mock.push({ content: ["ok"] });
				return mock.stream(m, context, options);
			},
		});
		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		return session;
	}

	it("states the value found, the file to edit and the rung in force", async () => {
		const { settings, file } = await settingsFromFile({ tools: { approvalMode: "askk" } });

		const session = sessionFor(settings);

		const reports = session.configWarnings.filter(w => w.startsWith("tools.approvalMode"));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain('"askk"');
		expect(reports[0]).toContain(path.basename(path.dirname(file)));
		expect(reports[0]).toEndWith('; it reads as "ask"');
		expect(session.effectiveApprovalMode()).toBe("ask");
	});

	it("reports nothing for an accepted mode", async () => {
		const { settings } = await settingsFromFile({ tools: { approvalMode: "yolo" } });

		const session = sessionFor(settings);

		expect(session.configWarnings.filter(w => w.includes("tools.approvalMode"))).toEqual([]);
		expect(session.effectiveApprovalMode()).toBe("yolo");
	});

	/** A value of the wrong kind reads as its default, and its report states the file and that default. */
	it("reports a boolean written as a word with the file to edit and the default it reads as", async () => {
		const declaration = DECLARATIONS.find(([, def]) => def.type === "boolean");
		if (declaration === undefined) throw new Error("Expected the schema to declare a boolean setting");
		const [booleanPath, { default: booleanDefault }] = declaration;
		const { settings } = await settingsFromFile(treeAt(booleanPath, "yes"));

		const session = sessionFor(settings);

		const reports = session.configWarnings.filter(w => w.startsWith(`${booleanPath}: `));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain('("yes")');
		expect(reports[0]).toEndWith(`config.yml; it reads as ${JSON.stringify(booleanDefault)}`);
	});

	/** An entry of the wrong kind inside a model chain is served with the rest, so its report claims no reading. */
	it("reports a model chain entry of the wrong kind with the file to edit and no substituted value", async () => {
		const chainPath = DECLARATIONS.find(([, def]) => def.type === "modelChain")?.[0];
		if (chainPath === undefined) throw new Error("Expected the schema to declare a model chain setting");
		const written = ["probe/model", 42];
		const { settings } = await settingsFromFile(treeAt(chainPath, written));

		const session = sessionFor(settings);

		expect(settings.get(chainPath as SettingPath)).toEqual(written);
		const reports = session.configWarnings.filter(w => w.startsWith(`${chainPath}: `));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("at index 1");
		expect(reports[0]).toEndWith("config.yml");
	});

	/**
	 * Every enum in the loaded schema, set to a value none of them accepts, in one file. The paths a
	 * load migration rewrites before the value is judged are pinned by exact equality:
	 * `compaction.strategy` maps an unknown strategy name to `summary`.
	 */
	it("reports every enum setting written outside its members once, with the value it reads as", async () => {
		const enums = DECLARATIONS.filter(([, def]) => def.type === "enum");
		const tree: Record<string, unknown> = {};
		for (const [settingPath] of enums) {
			const segments = settingPath.split(".");
			let node = tree;
			for (const segment of segments.slice(0, -1)) {
				const next = node[segment];
				node[segment] = typeof next === "object" && next !== null ? next : {};
				node = node[segment] as Record<string, unknown>;
			}
			node[segments.at(-1) as string] = NOT_A_MEMBER;
		}
		const { settings } = await settingsFromFile(tree);

		const session = sessionFor(settings);

		const unreported: string[] = [];
		for (const [settingPath] of enums) {
			const readsAs = settings.get(settingPath as "tools.approvalMode");
			const reports = session.configWarnings.filter(w => w.startsWith(`${settingPath}: `));
			if (reports.length === 0) {
				unreported.push(settingPath);
				continue;
			}
			expect([settingPath, reports.length]).toEqual([settingPath, 1]);
			expect(reports[0]).toContain(`found "${NOT_A_MEMBER}"`);
			expect(reports[0]).toEndWith(`; it reads as ${JSON.stringify(readsAs)}`);
		}
		expect(unreported).toEqual(["compaction.strategy"]);
	});
});
