import { afterEach, expect, test } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { persistNativeHandoffIdentity } from "../src/checkpoints/native-recovery";

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

test("production prompt and tool admission both stop when the cloud lease is lost", async () => {
	tempDir = TempDir.createSync("@checkpoint-admission-");
	authStorage = await AuthStorage.create(join(tempDir.path(), "auth.db"));
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated({ "checkpoints.enabled": true, "compaction.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const sessionManager = SessionManager.create(tempDir.path(), join(tempDir.path(), "sessions"));
	const sessionFile = sessionManager.getSessionFile();
	const sessionId = sessionManager.getSessionId();
	const identity = { version: 1 as const, targetNode: "laptop-b", transferId: "handoff-1", transferEpoch: 7 };
	await persistNativeHandoffIdentity(sessionFile, identity);
	const sessionsDirectory = dirname(sessionFile);
	await mkdir(sessionsDirectory, { recursive: true });
	await writeFile(
		join(sessionsDirectory, "checkpoint-ownership.json"),
		JSON.stringify({
			version: 1,
			sessionId,
			...identity,
			claimToken: "a-long-enough-single-use-claim",
			epoch: 7,
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		join(sessionsDirectory, "..", "recovery.json"),
		JSON.stringify({ sessionId, checkpointTransfer: true }),
	);
	process.env.VEYYON_CHECKPOINT_NODE = "laptop-b";
	process.env.VEYYON_CHECKPOINT_URL = "https://checkpoint.test";
	process.env.VEYYON_CHECKPOINT_TOKEN = "test-token";
	process.env.VEYYON_CHECKPOINT_KEY = Buffer.alloc(32, 9).toString("base64");
	let renewals = 0;
	globalThis.fetch = async (input, init) => {
		const action = new URL(String(input)).pathname.split("/").pop();
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
		if (action === "renew" && ++renewals > 1) return Response.json({ error: "lease lost" }, { status: 409 });
		if (action === "renew")
			return Response.json({ ownerNode, epoch: 8, expiresAt: "2099-01-01T00:00:00Z", headSequence: 0, manifestHash: "" });
		return Response.json({ error: "unexpected checkpoint operation" }, { status: 404 });
	};
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
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const events = new AssistantMessageEventStream();
			queueMicrotask(() => {
				events.push({ type: "start", partial: message });
				events.push({ type: "done", reason: "toolUse", message });
			});
			return events;
		},
	});
	session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry: new Map([[tool.name, tool]]) });
	await session.prompt("exercise fenced admission");
	await session.waitForIdle();
	expect(streamCount).toBe(1);
	expect(renewals).toBeGreaterThanOrEqual(2);
	expect(executions).toBe(0);
});
