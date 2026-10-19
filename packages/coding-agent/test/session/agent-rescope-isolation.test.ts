import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, TempDir } from "@veyyon/utils";

/**
 * Moving a session's working directory isolates the change to that session and leaves the process
 * and other sessions where they are.
 *
 * The session working directory updates for both primary and spawned sessions without mutating
 * the shared process.cwd() or the process project directory.
 */

describe("an agent's re-root leaves the process where it is", () => {
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-rescope-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		tempDir.removeSync();
	});

	/** A real directory, because `setCwd` validates that the destination exists. */
	function makeDir(name: string): string {
		const dir = path.join(tempDir.path(), name);
		fs.mkdirSync(dir, { recursive: true });
		return fs.realpathSync(dir);
	}

	/**
	 * Build a session at `cwd`. `isSpawned` is the one thing under test here, and it
	 * is passed exactly as `sdk.ts` passes it, from `isSubagentSession(options)`.
	 */
	async function createSession(cwd: string, isSpawned: boolean): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: undefined },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		await sessionManager.setCwd(cwd);
		const session = new AgentSession({
			agent,
			isSpawned,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		// Rebuilding the real prompt would reach settings and capabilities, which is a
		// different subject; these cases are about who owns the process.
		vi.spyOn(session, "refreshBaseSystemPrompt").mockResolvedValue([]);
		vi.spyOn(session, "refreshSshTool").mockResolvedValue();
		sessions.push(session);
		return session;
	}

	/**
	 * THE BUG, stated directly. An agent re-roots and the process stays put.
	 */
	it("does not chdir the process when an agent moves", async () => {
		const initialProjectDir = getProjectDir();
		const initialProcessCwd = fs.realpathSync(process.cwd());
		const parentDir = makeDir("parent-project");
		const agentDir = makeDir("agent-project");
		const agent = await createSession(parentDir, true);

		await agent.setCwd(agentDir);

		expect(fs.realpathSync(process.cwd())).toBe(initialProcessCwd);
		expect(getProjectDir()).toBe(initialProjectDir);
	});

	/**
	 * The agent still moved. Refusing the re-root would also keep the process
	 * still, and would be a different behaviour entirely, so this is what separates
	 * a fix from a removal.
	 */
	it("still moves the agent's own session working directory", async () => {
		const parentDir = makeDir("parent-project");
		const agentDir = makeDir("agent-project");
		const agent = await createSession(parentDir, true);

		await agent.setCwd(agentDir);

		expect(agent.sessionManager.getCwd()).toBe(agentDir);
	});

	/**
	 * The session-scoped half runs for an agent too. The base system prompt states
	 * the working directory verbatim, so an agent that skipped the rebuild would go
	 * on naming the directory it had just left, which is the one claim the model
	 * cannot check for itself.
	 */
	it("still rebuilds the agent's own system prompt", async () => {
		const parentDir = makeDir("parent-project");
		const agentDir = makeDir("agent-project");
		const agent = await createSession(parentDir, true);
		const rebuild = vi.spyOn(agent, "refreshBaseSystemPrompt").mockResolvedValue([]);

		await agent.setCwd(agentDir);

		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	/**
	 * The parent is the point of the whole thing. Its session cwd is what
	 * `resolveToCwd(path, sessionCwd)` resolves tool paths against, and it must be
	 * untouched by a sibling's move.
	 */
	it("leaves a parent session's working directory alone", async () => {
		const initialProcessCwd = fs.realpathSync(process.cwd());
		const parentDir = makeDir("parent-project");
		const agentDir = makeDir("agent-project");
		const parent = await createSession(parentDir, false);
		const agent = await createSession(parentDir, true);

		await agent.setCwd(agentDir);

		expect(parent.sessionManager.getCwd()).toBe(parentDir);
		expect(fs.realpathSync(process.cwd())).toBe(initialProcessCwd);
	});

	/**
	 * Two agents in flight at once is the real shape, and neither may move the
	 * other. Asserted with two moves rather than one, because a fix that merely made
	 * the FIRST agent's re-root a no-op would pass a single-move check.
	 */
	it("keeps two concurrent agents out of each other's directories", async () => {
		const initialProjectDir = getProjectDir();
		const initialProcessCwd = fs.realpathSync(process.cwd());
		const parentDir = makeDir("parent-project");
		const firstDir = makeDir("first-project");
		const secondDir = makeDir("second-project");
		const first = await createSession(parentDir, true);
		const second = await createSession(parentDir, true);

		await first.setCwd(firstDir);
		await second.setCwd(secondDir);

		expect(first.sessionManager.getCwd()).toBe(firstDir);
		expect(second.sessionManager.getCwd()).toBe(secondDir);
		expect(fs.realpathSync(process.cwd())).toBe(initialProcessCwd);
		expect(getProjectDir()).toBe(initialProjectDir);
	});

	/**
	 * The primary session moving its working directory leaves the process project directory and
	 * OS cwd unchanged while updating the primary session's own working directory.
	 */
	it("leaves the process where it is when the primary session moves", async () => {
		const initialProjectDir = getProjectDir();
		const initialProcessCwd = fs.realpathSync(process.cwd());
		const originDir = makeDir("origin-project");
		const destinationDir = makeDir("destination-project");
		const primary = await createSession(originDir, false);

		await primary.setCwd(destinationDir);

		expect(primary.sessionManager.getCwd()).toBe(destinationDir);
		expect(fs.realpathSync(process.cwd())).toBe(initialProcessCwd);
		expect(getProjectDir()).toBe(initialProjectDir);
	});

	/**
	 * A session built without the flag leaves the process project directory and OS cwd
	 * unchanged while updating the session's own working directory.
	 */
	it("treats a session with no isSpawned flag as session-scoped", async () => {
		const initialProjectDir = getProjectDir();
		const initialProcessCwd = fs.realpathSync(process.cwd());
		const originDir = makeDir("origin-project");
		const destinationDir = makeDir("destination-project");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: undefined },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth-default.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		await sessionManager.setCwd(originDir);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models-default.yml")),
		});
		sessions.push(session);
		vi.spyOn(session, "refreshBaseSystemPrompt").mockResolvedValue([]);
		vi.spyOn(session, "refreshSshTool").mockResolvedValue();

		await session.setCwd(destinationDir);

		expect(session.sessionManager.getCwd()).toBe(destinationDir);
		expect(fs.realpathSync(process.cwd())).toBe(initialProcessCwd);
		expect(getProjectDir()).toBe(initialProjectDir);
	});
});
