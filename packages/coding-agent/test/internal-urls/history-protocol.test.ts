/**
 * Contracts: history:// protocol handler (rework-contracts.md §6), resolved
 * through `InternalUrlRouter.instance().resolve(...)` like real callers.
 *
 * - Bare `history://` renders an index listing registered agent ids.
 * - `history://<id>` with a live ref renders the in-memory transcript.
 * - A parked ref (session null, sessionFile retained) renders read-only from
 *   the JSONL session file.
 * - An unknown id fails with an error listing the known ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls";
import { HistoryProtocolHandler } from "@veyyon/coding-agent/internal-urls/history-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeWithRetries } from "@veyyon/utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function fakeLiveSession(messages: unknown[]): AgentSession {
	return { messages } as unknown as AgentSession;
}

/** Minimal current-version session JSONL: header + a linear user/assistant chain. */
function sessionFixtureJsonl(): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "fixture-session",
		timestamp,
		cwd: "/tmp",
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "parked hello", timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "parked reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			// A real usage, not `{}`. The loader validates the shape it promises,
			// and an assistant turn whose `usage` carries no counters is the exact
			// record that used to take the whole transcript down: every reader sums
			// `usage.input` unguarded and gets NaN. The fixture wrote a shape no
			// real session file has.
			usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

describe("history:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("bare history:// renders an index listing registered agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Agents");
		expect(resource.content).toContain("| HubAgent | idle | sub |");
	});

	it("history://<id> renders a live ref's in-memory transcript", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://HubAgent");

		expect(resource.content).toContain("# HubAgent (idle)");
		expect(resource.content).toContain("## user");
		expect(resource.content).toContain("hello from live");
		expect(resource.notes).toContain("Source: live session");
	});

	it("resolves agent ids case-insensitively", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://hubagent");
		expect(resource.content).toContain("# HubAgent (idle)");
	});

	it("history://<id> renders a parked ref read-only from its session file", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "parked.jsonl");
			await Bun.write(sessionFile, sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Sleeper",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sleeper");

			expect(resource.content).toContain("# Sleeper (parked)");
			expect(resource.content).toContain("parked hello");
			expect(resource.content).toContain("parked reply");
			expect(resource.sourcePath).toBe(sessionFile);
			expect(resource.notes?.join("\n")).toContain("read-only");
		});
	});

	it("rejects an unknown id with the list of known agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Nope")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent: Nope");
		expect(error?.message).toContain("HubAgent");
	});

	it("rejects a ref with neither session nor session file", async () => {
		AgentRegistry.global().register({
			id: "Husk",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Husk")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error?.message).toContain("no transcript");
	});

	it("hides advisor transcripts from the index and direct lookup", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});

		// Index lists the agent but never the advisor.
		const index = await InternalUrlRouter.instance().resolve("history://");
		expect(index.content).toContain("HubAgent");
		expect(index.content).not.toContain("advisor");

		// Direct lookup of an advisor-kind ref is reported as unknown — the driving
		// agent must not be able to read it via history://.
		const error = await InternalUrlRouter.instance()
			.resolve("history://AdvisorProbe")
			.then(
				() => null,
				err => err as Error,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent");
	});

	it("omits advisor refs from history:// completions", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: "/tmp/x/__advisor.jsonl",
			status: "parked",
		});

		const completions = await new HistoryProtocolHandler().complete();
		const values = completions.map(c => c.value);
		expect(values).toContain("HubAgent");
		expect(values).not.toContain("AdvisorProbe");
	});

	it("history://<id> serves an unregistered agent's transcript from disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			// Only Main is registered; Sub1 exists solely on disk.
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sub1");
			expect(resource.content).toContain("# Sub1 (on disk)");
			expect(resource.content).toContain("parked hello");
			expect(resource.sourcePath).toBe(path.join(artifactsDir, "Sub1.jsonl"));
			expect(resource.notes?.join("\n")).toContain("unregistered");
		});
	});

	it("resolves an on-disk-only transcript case-insensitively", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "AuthLoader.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://authloader");
			expect(resource.content).toContain("# AuthLoader (on disk)");
		});
	});

	it("bare history:// and completions include on-disk agents but never advisor transcripts", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			await Bun.write(path.join(artifactsDir, "__advisor.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("| Sub1 | on disk |");
			expect(index.content).not.toContain("__advisor");

			const completions = await new HistoryProtocolHandler().complete();
			const values = completions.map(c => c.value);
			expect(values).toContain("Sub1");
			expect(values).not.toContain("__advisor");
		});
	});

	it("resolves a nested child transcript one level deeper on disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			const childDir = path.join(artifactsDir, "Parent");
			await fs.mkdir(childDir, { recursive: true });
			await Bun.write(path.join(childDir, "Parent.Child.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Parent.Child");
			expect(resource.content).toContain("# Parent.Child (on disk)");
		});
	});

	/**
	 * WHY: a registered live agent with no sessionFile must use its active
	 * in-memory branch for exact reads and searches, even when an older transcript
	 * with the same id remains in its artifacts directory.
	 *
	 * The real SessionManager and AgentSession drive the registered ref. The
	 * test does not cover persisted-session precedence or explicit leaf selection.
	 */
	it("uses a live branch for exact and search URLs when a stale artifact has the same id", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "session");
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "LiveAgent.jsonl"), sessionFixtureJsonl());
			registerArtifactsDir(artifactsDir);

			const manager = SessionManager.inMemory();
			let liveEntryId: string;
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: { provider: "test", id: "history-model", api: "openai-completions" } as Model,
						systemPrompt: ["test"],
						tools: [],
						messages: [{ role: "user", content: "live branch needle", timestamp: 10 }],
					},
				}),
				sessionManager: manager,
				settings: Settings.isolated({}),
				modelRegistry: {} as ModelRegistry,
			});
			liveEntryId = manager.appendMessage({ role: "user", content: "live branch needle", timestamp: 10 });
			try {
				AgentRegistry.global().register({
					id: "LiveAgent",
					displayName: "task",
					kind: "sub",
					session,
					sessionFile: null,
					status: "running",
				});
				expect(manager.getBranch().map(entry => entry.id)).toContain(liveEntryId);
				const router = InternalUrlRouter.instance();
				const exact = await router.resolve(`history://LiveAgent?entry=${liveEntryId}`);
				const exactRecord = JSON.parse(exact.content) as { status: string; fragment: string; source: string; entryId: string };
				expect(exactRecord.status).toBe("ok");
				expect(exactRecord.entryId).toBe(liveEntryId);
				expect(exactRecord.fragment).toContain("live branch needle");
				expect(exactRecord.fragment).not.toContain("parked hello");
				expect(exactRecord.source).toBe("live-session");

				const search = await router.resolve("history://LiveAgent?q=needle");
				const searchResult = JSON.parse(search.content) as { matches: Array<{ entryId: string; preview: string }>; source: string };
				expect(searchResult.source).toBe("live-session");
				expect(searchResult.matches).toHaveLength(1);
				expect(searchResult.matches[0]?.entryId).toBe(liveEntryId);
				expect(searchResult.matches[0]?.preview).toContain("live branch needle");
				expect(searchResult.matches[0]?.preview).not.toContain("parked hello");

			} finally {
				await session.dispose();
			}
		});
	});

	it("does not substitute the stored tail when a persisted live session has no branch leaf", async () => {
		await withTempDir(async dir => {
			const manager = SessionManager.create(dir, dir);
			try {
				manager.appendMessage({ role: "user", content: "persisted archived prompt", timestamp: 1 });
				const tailId = manager.appendMessage({
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "fixture",
					content: [{ type: "text", text: "archived stored tail" }],
					stopReason: "stop",
					timestamp: 2,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				await manager.flush();
				const sessionFile = manager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a persisted session fixture");
				await fs.access(sessionFile);
				manager.resetLeaf();
				expect(manager.getLeafId()).toBeNull();
				expect(manager.getBranch()).toHaveLength(0);
				AgentRegistry.global().register({
					id: "LivePersisted",
					displayName: "task",
					kind: "sub",
					session: { sessionManager: manager } as AgentSession,
					sessionFile,
					status: "running",
				});

				const router = InternalUrlRouter.instance();
				await expect(router.resolve(`history://LivePersisted?entry=${tailId}`)).rejects.toThrow(/no branch leaf/);
				await expect(router.resolve("history://LivePersisted?q=archived")).rejects.toThrow(/no branch leaf/);
				const explicit = await router.resolve(`history://LivePersisted?entry=${tailId}&leaf=${tailId}`);
				const exact = JSON.parse(explicit.content) as { status: string; entryId: string; leafId?: string; fragment?: string };
				expect(exact.status).toBe("ok");
				expect(exact.entryId).toBe(tailId);
				expect(exact.leafId).toBe(tailId);
				expect(exact.fragment).toContain("archived stored tail");
			} finally {
				await manager.close();
			}
		});
	});

	it("skips a registered artifact candidate that is a file", async () => {
		await withTempDir(async dir => {
			const candidate = path.join(dir, "not-a-directory");
			await Bun.write(candidate, "not a directory");
			registerArtifactsDir(candidate);

			await expect(new HistoryProtocolHandler().complete()).resolves.toEqual([]);
		});
	});
});
