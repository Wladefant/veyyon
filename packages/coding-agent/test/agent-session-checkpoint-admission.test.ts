import { afterEach, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { persistNativeHandoffIdentity } from "../src/checkpoints/native-recovery";
import { readSessionOwnershipMarker } from "../src/checkpoints/session-ownership-marker";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

const environmentKeys = [
	"VEYYON_CHECKPOINT_NODE",
	"VEYYON_CHECKPOINT_URL",
	"VEYYON_CHECKPOINT_TOKEN",
	"VEYYON_CHECKPOINT_KEY",
	"VEYYON_CHECKPOINT_SESSION",
] as const;
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
	globalThis.fetch = originalFetch;
	for (const key of environmentKeys) {
		const value = previousEnvironment.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function createCheckpointHarness(
	streamResponder: (streamCount: number, model: Model<Api>) => AssistantMessage,
	transferred = true,
) {
	tempDir = TempDir.createSync("@checkpoint-admission-");
	authStorage = await AuthStorage.create(join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated({
		"checkpoints.enabled": true,
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	settings.setDefaultModel(`${model.provider}/${model.id}`);
	const sessionManager = SessionManager.create(tempDir.path(), join(tempDir.path(), "sessions"));
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("SessionManager did not create the checkpoint session file");
	const sessionId = sessionManager.getSessionId();
	const identity = { version: 1 as const, targetNode: "laptop-b", transferId: "handoff-1", transferEpoch: 7 };
	if (transferred) {
		await sessionManager.ensureOnDisk();
		await persistNativeHandoffIdentity(sessionFile, identity);
	}
	const sessionsDirectory = dirname(sessionFile);
	await mkdir(sessionsDirectory, { recursive: true });
	if (transferred) {
		await writeFile(
			join(sessionsDirectory, "checkpoint-ownership.json"),
			JSON.stringify({
				sessionId,
				...identity,
				claimToken: "a-long-enough-single-use-claim",
				epoch: 7,
			}),
			{ mode: 0o600 },
		);
		await writeFile(join(sessionsDirectory, "..", "recovery.json"), JSON.stringify({ sessionId, checkpointTransfer: true }));
	}
	process.env.VEYYON_CHECKPOINT_NODE = "laptop-b";
	process.env.VEYYON_CHECKPOINT_URL = "https://checkpoint.test";
	process.env.VEYYON_CHECKPOINT_TOKEN = "test-token";
	process.env.VEYYON_CHECKPOINT_KEY = Buffer.alloc(32, 9).toString("base64");
	let renewals = 0;
	const requests: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof globalThis.fetch>[0], init: Parameters<typeof globalThis.fetch>[1]) => {
			const action = new URL(String(input)).pathname.split("/").pop() ?? "";
			requests.push(action);
			const parsed: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
			const ownerNode =
				parsed && typeof parsed === "object" && "ownerNode" in parsed && typeof parsed.ownerNode === "string"
					? parsed.ownerNode
					: "";
			if (action === "claim")
				return Response.json({
					ownerNode,
					epoch: 8,
					expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0,
					manifestHash: "",
					resumeToken: "a-rotated-resume-capability",
				});
			if (action === "finalize") return Response.json({ ok: true });
			if (action === "lease")
				return Response.json({ ownerNode, epoch: 8, expiresAt: "2099-01-01T00:00:00Z", headSequence: 0, manifestHash: "" });
			if (action === "renew" && ++renewals > 1) return Response.json({ error: "lease lost" }, { status: 409 });
			if (action === "renew")
				return Response.json({
					ownerNode,
					epoch: 8,
					expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0,
					manifestHash: "",
				});
			return Response.json({ error: "unexpected checkpoint operation" }, { status: 404 });
		},
		{ preconnect: originalFetch.preconnect },
	);
	let executions = 0;
	const tool: AgentTool = {
		name: "probe",
		label: "Probe",
		description: "Counts whether a fenced tool is admitted",
		parameters: type({}),
		execute: async () => {
			executions++;
			return { content: [{ type: "text" as const, text: "unexpected execution" }] };
		},
	};
	let streamCount = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
		convertToLlm,
		streamFn: () => {
			streamCount++;
			const message = streamResponder(streamCount, model);
			const events = new AssistantMessageEventStream();
			queueMicrotask(() => {
				events.push({ type: "start", partial: message });
				events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return events;
		},
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([[tool.name, tool]]),
	});
	return {
		session,
		sessionManager,
		sessionFile,
		sessionId,
		getExecutions: () => executions,
		getRenewals: () => renewals,
		getStreamCount: () => streamCount,
		getRequests: () => requests,
	};
}

test("fenced tool never executes after lease loss", async () => {
	const { session, getExecutions, getRenewals } = await createCheckpointHarness((streamCount, model) => {
		if (streamCount === 1) {
			return {
				role: "assistant",
				content: [{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
		}
		return {
			role: "assistant",
			content: [{ type: "text", text: "fenced admission ended" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	});

	await session.prompt("exercise fenced admission");
	await session.waitForIdle();
	expect(getExecutions()).toBe(0);
	expect(getRenewals()).toBeGreaterThanOrEqual(2);
});

// WHY: a lease-loss throw from beforeToolCall used to reach the model as an ordinary tool error, so the model was
// re-sampled and kept calling tools against a fence it could not lift. The run now ends after the batch results.
// Class: every `beforeToolCall` admission failure of a synchronized session. Gap: a plain (non-fatal) hook throw is
// still a recoverable tool error and is covered by agent-loop tests, not here.
// SAFETY: cap the mock at 25 calls before returning plaintext stop to prevent runaway loops.
test("production prompt and tool admission both stop when the cloud lease is lost", async () => {
	const { session, getExecutions, getRenewals, getStreamCount } = await createCheckpointHarness(
		(streamCount, model) => {
			if (streamCount <= 25) {
				return {
					role: "assistant",
					content: [{ type: "toolCall", id: `probe-call-${streamCount}`, name: "probe", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: "safety capped" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			};
		},
	);

		await session.prompt("exercise fenced admission");
		await session.waitForIdle();
		expect(getStreamCount()).toBe(1);
		expect(getRenewals()).toBeGreaterThanOrEqual(2);
		expect(getExecutions()).toBe(0);
	},
	5000,
);
test("a genuinely lazy session acquires ordinary ownership before its first prompt", async () => {
	const { session, sessionFile, getRequests, getStreamCount } = await createCheckpointHarness(
		(_streamCount, model) => ({
			role: "assistant",
			content: [{ type: "text", text: "ordinary prompt completed" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		}),
		false,
	);
	process.env.VEYYON_CHECKPOINT_SESSION = session.sessionManager.getSessionId();
	await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(readSessionOwnershipMarker(sessionFile, session.sessionManager.getSessionId())).resolves.toBeNull();
	await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
	await session.prompt("ordinary lazy prompt");
	await session.waitForIdle();
	expect(session.state.messages.at(-1)).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "ordinary prompt completed" }],
	});
	expect(getRequests()).toContain("lease");
	expect(getRequests()).not.toContain("claim");
	expect(getStreamCount()).toBe(1);
});

test("a non-ENOENT lazy session ownership error blocks prompt admission", async () => {
	const { session, sessionFile, getRequests, getStreamCount } = await createCheckpointHarness(
		(_streamCount, model) => ({
			role: "assistant",
			content: [{ type: "text", text: "must not stream" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		}),
		false,
	);
	process.env.VEYYON_CHECKPOINT_SESSION = session.sessionManager.getSessionId();
	await mkdir(sessionFile);
	await expect(session.prompt("blocked lazy prompt")).rejects.toMatchObject({ code: "EISDIR" });
	expect(getStreamCount()).toBe(0);
	expect(getRequests()).toEqual([]);
});
