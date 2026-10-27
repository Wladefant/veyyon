/**
 * Every row on the Resources tab reaches the session's live budget: at
 * registration, and the moment it changes mid-session.
 *
 * WHY THIS SUITE EXISTS. The session registered its limiter with the CPU cores
 * and the kill flag only, and its settings listener pushed those two alone.
 * `session.memoryLimitGb`, `session.maxProcesses`, `session.writeBudgetGb` and
 * `session.writeBudgetKill` reached the limiter only when a bash, launch, write
 * or edit gate next passed them in. An eval kernel or an MCP server started
 * before that, or after a mid-session change, joined a group carrying the old
 * caps: the settings screen showed the new value and nothing enforced it.
 *
 * THE CLASS. The rows are swept from `SETTINGS_SCHEMA` at run time, so a row
 * added to the tab without a recorded way to observe it in the live limiter
 * turns this suite red. Each row is checked at registration and as a live
 * change, against the limiter's own status line rather than the settings
 * store, because the status line is what `/cpu-limit status` reports.
 *
 * WHAT IT DOES NOT CATCH. The limiter runs on a fake cgroup host, so whether
 * the kernel holds a limit is out of scope here; `session-resource-limits.test.ts`
 * covers the control files. A gate that later overwrites a limit with a stale
 * value is not covered either: each gate reads the same settings this suite
 * changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getUi, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	initSessionCpuLimit,
	resetSessionCpuLimitsForTests,
	sessionCpuLimit,
} from "@veyyon/coding-agent/session/cpu-limit";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

/**
 * A non-default value for each Resources row and the status-line text that
 * shows the limiter holds it. The kill rows need their budget on to mean
 * anything, which {@link BASE} provides.
 */
const SHOWN_AS: Record<string, { value: number | boolean; shows: string }> = {
	"session.cpuLimitCores": { value: 2, shows: "2 core(s)" },
	"session.cpuLimitKill": { value: true, shows: "kill on sustained saturation" },
	"session.memoryLimitGb": { value: 3, shows: "memory limit 3 GB" },
	"session.writeBudgetGb": { value: 5, shows: "write budget 5 GB" },
	"session.writeBudgetKill": { value: true, shows: "kill when exceeded" },
	"session.maxProcesses": { value: 7, shows: "process cap 7" },
};

/** One core and one gigabyte, so the two kill flags have a budget to act on. */
const BASE = { "session.cpuLimitCores": 1, "session.writeBudgetGb": 1 } as const;

function resourceRows(): string[] {
	return Object.keys(SETTINGS_SCHEMA)
		.filter(key => getUi(key as SettingPath)?.tab === "resources")
		.sort();
}

let tempDir = "";
let authStorage: AuthStorage | undefined;
let session: AgentSession | undefined;

beforeEach(() => {
	resetSessionCpuLimitsForTests();
	tempDir = path.join(os.tmpdir(), `veyyon-resources-live-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
	if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
});

/**
 * A real AgentSession whose limiter runs on a fake delegated cgroup host.
 *
 * The limiter is registered under the session's id before the session is
 * built, so the session's own registration finds it and applies its settings
 * to it: that keeps the probe off this machine's real cgroup tree and makes
 * the backend the same on every CI runner.
 */
async function createSession(settings: Settings): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const agent = new Agent({
		getApiKey: () => "not-used: nothing in this suite reaches a provider",
		initialState: { model, systemPrompt: ["test"], tools: [] },
	});
	const sessionManager = SessionManager.create(tempDir, tempDir);
	const root = await makeCgroupRoot();
	await makeDelegatedParent(root);
	await initSessionCpuLimit({
		sessionId: sessionManager.getSessionId(),
		cores: 0,
		kill: false,
		env: makeFakeHost(root).env,
		onNotice: () => {},
	});
	authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	const built = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
	});
	built.subscribe(() => {});
	await settled();
	return built;
}

/** The session hands work to the limiter without awaiting it; a timer turn runs after every queued microtask. */
async function settled(): Promise<void> {
	await delay(0);
}

async function liveStatus(current: AgentSession): Promise<string> {
	const limiter = sessionCpuLimit(current.sessionManager.getSessionId());
	if (!limiter) throw new Error("the session registered no budget");
	return limiter.statusLine();
}

describe("the Resources rows", () => {
	it("each have a recorded way to observe them in the live limiter", () => {
		expect(Object.keys(SHOWN_AS).sort()).toEqual(resourceRows());
	});
});

describe("a session's budget at registration", () => {
	/**
	 * The eval kernel and MCP server case: nothing but the session's own
	 * registration has run, and the limiter already holds every configured
	 * limit rather than CPU alone.
	 */
	it("holds every configured Resources limit before any gate runs", async () => {
		const configured = Object.fromEntries(resourceRows().map(row => [row, SHOWN_AS[row]?.value]));
		session = await createSession(Settings.isolated(configured));

		const status = await liveStatus(session);
		for (const row of resourceRows()) expect(status).toContain(SHOWN_AS[row]?.shows ?? row);
	});
});

describe("a mid-session change to a Resources row", () => {
	const rows = resourceRows();

	it.each(rows)("reaches the live limiter without a gate running: %s", async row => {
		const settings = Settings.isolated(BASE);
		session = await createSession(settings);
		const change = SHOWN_AS[row];
		if (!change) throw new Error(`no recorded change for ${row}`);
		expect(await liveStatus(session)).not.toContain(change.shows);

		settings.override(row as SettingPath, change.value);
		await settled();

		expect(await liveStatus(session)).toContain(change.shows);
	});
});

describe("a disposed session", () => {
	/**
	 * The id-change listener was never released, so a session that had been
	 * disposed registered a fresh budget the next time its manager minted an
	 * id, under a session nothing would ever dispose again.
	 */
	it("registers no budget when its manager later mints a new id", async () => {
		session = await createSession(Settings.isolated(BASE));
		const manager = session.sessionManager;
		await session.dispose();
		session = undefined;
		expect(sessionCpuLimit(manager.getSessionId())).toBeUndefined();

		await manager.newSession();
		await settled();

		expect(sessionCpuLimit(manager.getSessionId())).toBeUndefined();
	});
});
