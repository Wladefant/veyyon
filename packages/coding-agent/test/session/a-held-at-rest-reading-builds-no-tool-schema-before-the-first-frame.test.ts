/**
 * WHY: a top-level session measured its at-rest reading inside `createAgentSession`, and that
 * reading estimates the tool half of the prompt by building the ArkType schema of every active
 * tool: about 20 ms of a cold launch, all of it before the session's first frame, for schemas the
 * first request needs only once the user has typed something. The interactive host now creates its
 * session with the reading held (`deferAtRestReading`) and takes it after the first frame
 * (`recordAtRestLaunch`). The status row renders in between, so the hold is only worth anything if
 * no path of the row's render measures: the gauge draws the resting reading the last launch
 * recorded, and the row's own recorder files no gauge, since a recorded value drawn back is not a
 * measurement.
 *
 * THE CLASS: every read the real status row makes while the reading is held builds no tool schema,
 * observed as reads of each active tool's `parameters` through the same objects the estimate walks.
 * The suite renders the real `StatusLineComponent` over a real session, so a new read the row grows
 * is covered by the render rather than by a list of paths. The release arm is the positive control:
 * the same instrumentation sees the reads once the hold ends, so zero reads under the hold is the
 * guard and not a blind probe. Around it: the borrowed gauge is the recorded one for the default
 * role and the unknown for any other model, a session with a message measures as before, the
 * readings compaction and `/context` take measure whether or not the row is held, and a session
 * created without the hold measures during creation.
 *
 * WHAT THIS DOES NOT CATCH: the interactive host forgetting to release the hold after its first
 * frame. That wiring is in `runInteractiveMode` in `main.ts`, which this suite does not drive; a
 * missing release leaves the row on the recorded gauge until the first message. It also does not
 * prove the release lands after the first frame flushes rather than before it, which is a timing
 * property of the launch, measured by the startup A/B rather than asserted here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { readLaunchFacts, recordLaunchFacts, resetLaunchFactsForTest } from "@veyyon/coding-agent/modes/launch-facts";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { StatusPresentationProducer } from "@veyyon/coding-agent/presentation/status-producer";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/session/factory-options";
import { computeNonMessageBreakdown } from "@veyyon/coding-agent/session/non-message-tokens";
import { recordAtRestLaunch } from "@veyyon/coding-agent/session/startup-records";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";
/** The resting gauge the previous launch filed under the model, as a percentage spent. */
const RECORDED_PERCENT = 70;

function bundledModel(id = MODEL_ID): Model {
	const model = getBundledModel(PROVIDER, id);
	if (!model) throw new Error(`missing bundled model ${PROVIDER}/${id}`);
	return model as Model;
}

const sessions: AgentSession[] = [];
const rows: StatusLineComponent[] = [];
const tempDirs: string[] = [];
let sharedDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let isolated: IsolatedConfigRoot;

async function create(extra: Partial<CreateAgentSessionOptions>): Promise<AgentSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `held-at-rest-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(tempDir, "agent"),
		sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		modelRegistry,
		model: bundledModel(),
		...extra,
	});
	sessions.push(session);
	return session;
}

/**
 * Count every read of `parameters` on the session's active tools, the objects the tool-schema
 * estimate iterates. Each tool keeps its own getter or value; the counter wraps it on the instance.
 */
function countSchemaReads(session: AgentSession): { count: number } {
	const reads = { count: 0 };
	for (const tool of session.agent.state.tools) {
		let owner: object | null = tool;
		let descriptor: PropertyDescriptor | undefined;
		while (owner !== null && descriptor === undefined) {
			descriptor = Object.getOwnPropertyDescriptor(owner, "parameters");
			owner = Object.getPrototypeOf(owner);
		}
		if (!descriptor) throw new Error(`tool ${tool.name} has no parameters`);
		const found = descriptor;
		Object.defineProperty(tool, "parameters", {
			configurable: true,
			enumerable: true,
			get(): unknown {
				reads.count++;
				return found.get ? found.get.call(tool) : found.value;
			},
		});
	}
	return reads;
}

/** The session's status row as the interactive host mounts it. */
function mountRow(session: AgentSession): { row: StatusLineComponent; producer: StatusPresentationProducer } {
	const producer = new StatusPresentationProducer(session);
	const row = new StatusLineComponent(producer);
	rows.push(row);
	return { row, producer };
}

/** The rendered footline, ANSI stripped. */
function render(row: StatusLineComponent): string {
	return stripAnsi(row.renderQuietLine(200) ?? "");
}

beforeAll(async () => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "held-at-rest-"));
	authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	authStorage.setRuntimeApiKey(PROVIDER, "anthropic-test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

beforeEach(async () => {
	isolated = enterIsolatedConfigRoot("held-at-rest", { defaultProfile: true });
	resetSettingsForTest();
	resetLaunchFactsForTest();
	await Settings.init({ cwd: isolated.root });
	settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
	// The previous launch's reading, filed under the model only: this project was never measured.
	await recordLaunchFacts({ modelContextPercent: RECORDED_PERCENT });
});

afterEach(async () => {
	for (const row of rows.splice(0)) row.dispose();
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	isolated.restore();
});

afterAll(() => {
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	authStorage.close();
	removeSyncWithRetries(sharedDir);
});

describe("a held at-rest reading builds no tool schema before the first frame", () => {
	it("renders the row without reading any tool's schema, drawing the recorded resting gauge", async () => {
		const session = await create({ deferAtRestReading: true });
		const reads = countSchemaReads(session);
		const { row } = mountRow(session);

		const line = render(row);

		expect(reads.count).toBe(0);
		expect(line).toContain(`${100 - RECORDED_PERCENT}% left`);
	});

	it("files no gauge from the row while the reading is held", async () => {
		const session = await create({ deferAtRestReading: true });
		render(mountRow(session).row);

		// A later floor for the model shows through only when the row filed nothing for this project.
		await recordLaunchFacts({ modelContextPercent: 10 });

		expect(readLaunchFacts().contextPercent).toBe(10);
	});

	it("draws the unknown for a model that is not the default role the record is filed under", async () => {
		// The record stays filed under the default role; this session runs another model, by `--model`.
		const session = await create({ deferAtRestReading: true, model: bundledModel("claude-opus-4-1") });
		const reads = countSchemaReads(session);

		const line = render(mountRow(session).row);

		expect(reads.count).toBe(0);
		expect(line).toContain("? left");
	});

	it("measures, redraws and files the reading once the host releases the hold", async () => {
		const session = await create({ deferAtRestReading: true });
		const reads = countSchemaReads(session);
		const { row, producer } = mountRow(session);
		render(row);
		expect(reads.count).toBe(0);

		recordAtRestLaunch(session, session.settings);
		const line = render(row);

		expect(reads.count).toBeGreaterThan(0);
		const gauge = producer.getSnapshot().context;
		expect(gauge.usedTokens).toBe(session.getContextUsage()?.tokens ?? -1);
		const measured = gauge.contextPercent;
		if (measured === null) throw new Error("the released row measured no gauge");
		expect(Math.round(measured)).not.toBe(RECORDED_PERCENT);
		expect(line).not.toContain(`${100 - RECORDED_PERCENT}% left`);
		expect(readLaunchFacts().contextPercent).toBe(Math.round(measured));
	});

	it("measures the row of a held session that already holds a message", async () => {
		const session = await create({ deferAtRestReading: true });
		session.agent.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const reads = countSchemaReads(session);

		const line = render(mountRow(session).row);

		expect(reads.count).toBeGreaterThan(0);
		expect(line).not.toContain(`${100 - RECORDED_PERCENT}% left`);
	});

	it("leaves the readings compaction and /context take measuring while the row is held", async () => {
		const held = await create({ deferAtRestReading: true });
		const reads = countSchemaReads(held);

		const usage = held.getContextUsage();
		const breakdown = computeNonMessageBreakdown(held);

		expect(reads.count).toBeGreaterThan(0);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
		expect(usage?.tokens ?? 0).toBeGreaterThan(breakdown.toolsTokens);
	});

	it("measures and files the reading during creation when the host does not hold it", async () => {
		await create({});

		const filed = readLaunchFacts().contextPercent;

		expect(filed).not.toBeNull();
		expect(filed).not.toBe(RECORDED_PERCENT);
	});
});
