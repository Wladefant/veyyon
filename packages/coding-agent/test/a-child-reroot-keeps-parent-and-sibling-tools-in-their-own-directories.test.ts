/**
 * WHY: A spawned child shares the process with its parent and siblings. Its `set_cwd` must move
 * only that child's `SessionManager`. The session scope never calls `process.chdir` for root or
 * spawned sessions, so a move that leaked into a sibling, the parent, or the process would silently
 * re-point relative reads and shell commands. This suite builds a real parent and two spawned
 * children through `createAgentSession`, then executes the REGISTERED `set_cwd` and `read` tools
 * directly, so the path under test is the one a model reaches. Those tools run without approval
 * prompts or boundary checks: approval and boundary enforcement are excluded from this suite's
 * coverage. It closes the class "a child re-root leaks into a sibling, the parent or the process",
 * for any direction and ordering. It does NOT catch provider or capability global drift, and it
 * sends no prompt, so no model call.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/session/factory-options";
import type { SetCwdToolDetails } from "@veyyon/coding-agent/tools/fs/set-cwd";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { isolatedAuthStorage } from "./helpers/isolated-auth-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const SENTINEL = "sentinel.txt";
const PARENT = "SENTINEL-PARENT";
const PARENT_MOVED = "SENTINEL-PARENT-MOVED";
const CHILD_A = "SENTINEL-CHILD-A";
const CHILD_B = "SENTINEL-CHILD-B";
const OUTSIDE = "SENTINEL-OUTSIDE";

function tool(session: AgentSession, name: string) {
	const found = session.getToolByName(name);
	if (!found) throw new Error(`Expected ${name} in the session tool registry`);
	return found;
}

/** Relative read through the registered `read` tool: resolves against THIS session's cwd. */
async function readSentinel(session: AgentSession): Promise<string> {
	const result = await tool(session, "read").execute("read", { path: SENTINEL });
	return (result.content ?? []).flatMap(b => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
}

/** Move through the registered `set_cwd` tool, the entry point a model uses. */
async function moveCwd(session: AgentSession, target: string): Promise<SetCwdToolDetails> {
	const result = await tool(session, "set_cwd").execute("set-cwd", { path: target });
	return result.details as SetCwdToolDetails;
}

function writeSentinel(dir: string, token: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, SENTINEL), `${token}\n`);
}

describe("a spawned child's set_cwd re-roots that child and nothing else", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	let authStorage: AuthStorage | undefined;
	let globals: SettingsTestState | undefined;

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		restoreSettingsTestState(globals);
		globals = undefined;
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	/**
	 * Parent at `root/parent`, two spawned children created in the parent's CURRENT cwd (read from
	 * `parent.sessionManager.getCwd()`, so inheritance flows from the live parent). Every session
	 * starts on the same sentinel layout. Settings and auth are explicit and isolated, so no home
	 * config is read or written.
	 */
	async function startFamily() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-child-reroot-${Snowflake.next()}-`));
		tempDirs.push(root);
		const dirs = {
			parent: path.join(root, "parent"),
			parentMoved: path.join(root, "parent-moved"),
			movedA: path.join(root, "parent", "moved-a"),
			movedB: path.join(root, "parent", "moved-b"),
			outside: path.join(root, "outside"),
		};
		writeSentinel(dirs.parent, PARENT);
		writeSentinel(dirs.parentMoved, PARENT_MOVED);
		writeSentinel(dirs.movedA, CHILD_A);
		writeSentinel(dirs.movedB, CHILD_B);
		writeSentinel(dirs.outside, OUTSIDE);

		globals = beginSettingsTest();
		authStorage = await isolatedAuthStorage(root);
		const base = (cwd: string): CreateAgentSessionOptions => ({
			cwd,
			agentDir: root,
			authStorage,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			agentRegistry: new AgentRegistry(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "set_cwd"],
		});

		const { session: parent } = await createAgentSession(base(dirs.parent));
		sessions.push(parent);
		const spawn = async (agentId: string) => {
			const { session } = await createAgentSession({
				...base(parent.sessionManager.getCwd()),
				hasUI: false,
				taskDepth: 1,
				parentTaskPrefix: "parent-task",
				agentId,
			});
			sessions.push(session);
			return session;
		};
		return { parent, childA: await spawn("child-a"), childB: await spawn("child-b"), dirs };
	}

	it("moves one child alone, then the other, and never touches the parent or the process", async () => {
		const { parent, childA, childB, dirs } = await startFamily();
		const processCwd = process.cwd();
		const projectDir = getProjectDir();

		// Negative control: the before-move read proves the baseline is PARENT. After a move, the read
		// of a different sentinel (CHILD_A) fails if set_cwd is a no-op or the read stays on the old cwd.
		expect(await readSentinel(childA)).toContain(PARENT);
		expect(await readSentinel(childB)).toContain(PARENT);

		const moveA = await moveCwd(childA, dirs.movedA);
		expect(moveA.previous).toBe(path.resolve(dirs.parent));
		expect(moveA.cwd).toBe(path.resolve(dirs.movedA));
		expect(await readSentinel(childA)).toContain(CHILD_A);
		// Child B has not moved: it keeps the original directory.
		expect(childB.sessionManager.getCwd()).toBe(path.resolve(dirs.parent));
		expect(await readSentinel(childB)).toContain(PARENT);
		expect(await readSentinel(parent)).toContain(PARENT);

		const moveB = await moveCwd(childB, dirs.movedB);
		expect(moveB.previous).toBe(path.resolve(dirs.parent));
		expect(await readSentinel(childB)).toContain(CHILD_B);
		// Child A keeps its own move.
		expect(childA.sessionManager.getCwd()).toBe(path.resolve(dirs.movedA));
		expect(await readSentinel(childA)).toContain(CHILD_A);
		expect(await readSentinel(parent)).toContain(PARENT);

		expect(process.cwd()).toBe(processCwd);
		expect(getProjectDir()).toBe(projectDir);
	}, 120_000);

	it("keeps repeated re-roots correct in both directions while a sibling re-roots concurrently", async () => {
		const { parent, childA, childB, dirs } = await startFamily();
		const processCwd = process.cwd();
		const projectDir = getProjectDir();

		// A relative target resolves against the child's own cwd at that step.
		type Step = { target: string; expected: string; token: string };
		const stepsA: Step[] = [
			{ target: "moved-a", expected: dirs.movedA, token: CHILD_A },
			{ target: "..", expected: dirs.parent, token: PARENT },
			{ target: dirs.outside, expected: dirs.outside, token: OUTSIDE },
			{ target: "../parent/moved-a", expected: dirs.movedA, token: CHILD_A },
			{ target: ".", expected: dirs.movedA, token: CHILD_A },
		];
		const stepsB: Step[] = [
			{ target: "moved-b", expected: dirs.movedB, token: CHILD_B },
			{ target: "../../outside", expected: dirs.outside, token: OUTSIDE },
			{ target: dirs.movedB, expected: dirs.movedB, token: CHILD_B },
		];

		const run = async (session: AgentSession, steps: Step[]) => {
			for (const step of steps) {
				const before = session.sessionManager.getCwd();
				const move = await moveCwd(session, step.target);
				expect(move.previous).toBe(before);
				expect(move.cwd).toBe(path.resolve(step.expected));
				expect(session.sessionManager.getCwd()).toBe(path.resolve(step.expected));
				expect(await readSentinel(session)).toContain(step.token);
			}
		};
		const parentReads = async () => {
			for (let i = 0; i < 3; i++) {
				expect(await readSentinel(parent)).toContain(PARENT);
				expect(parent.sessionManager.getCwd()).toBe(path.resolve(dirs.parent));
			}
		};

		await Promise.all([run(childA, stepsA), run(childB, stepsB), parentReads()]);

		expect(process.cwd()).toBe(processCwd);
		expect(getProjectDir()).toBe(projectDir);
	}, 120_000);

	it("keeps spawned children in their directories when the top-level parent moves", async () => {
		const { parent, childA, childB, dirs } = await startFamily();
		await moveCwd(childA, dirs.movedA);
		await moveCwd(childB, dirs.movedB);
		const processCwd = process.cwd();
		const projectDir = getProjectDir();

		// The root move refreshes provider globals but does not chdir, so process and project stay put.
		const parentMove = await moveCwd(parent, dirs.parentMoved);
		expect(parentMove.cwd).toBe(path.resolve(dirs.parentMoved));
		expect(await readSentinel(parent)).toContain(PARENT_MOVED);
		expect(parent.sessionManager.getCwd()).toBe(path.resolve(dirs.parentMoved));
		expect(process.cwd()).toBe(processCwd);
		expect(getProjectDir()).toBe(projectDir);

		// Neither child follows the parent.
		expect(childA.sessionManager.getCwd()).toBe(path.resolve(dirs.movedA));
		expect(await readSentinel(childA)).toContain(CHILD_A);
		expect(childB.sessionManager.getCwd()).toBe(path.resolve(dirs.movedB));
		expect(await readSentinel(childB)).toContain(CHILD_B);

		// From moved-b, ".." lands on the original parent directory, not parent-moved.
		const up = await moveCwd(childB, "..");
		expect(up.cwd).toBe(path.resolve(dirs.parent));
		expect(await readSentinel(childB)).toContain(PARENT);
		expect(await readSentinel(childB)).not.toContain(PARENT_MOVED);
	}, 120_000);
});
