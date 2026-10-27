/**
 * WHY: a side request (a summarization, a handoff, a title, a `/btw` turn) builds its own stream
 * options, and `AgentSession.prepareSimpleStreamOptions` is where the session's provider settings,
 * hooks and metadata reach them. Most of that merge was unpinned: dropping the OpenRouter variant,
 * the Antigravity endpoint, the in-flight cap, the loop guard, the metadata stamp, the redaction
 * hook or either hook chain left every suite green, and so did the response interceptor no longer
 * feeding the usage ledger.
 *
 * The class this closes: a session setting, hook or metadata value that a side request omits, and a
 * caller's own option that the session overwrites. Every option the merge writes is asserted both
 * ways, the session's value when the caller sets none and the caller's when it does, through a real
 * session whose settings, agent metadata, secret runtime and usage ledger are the inputs.
 *
 * Not caught: whether each side-request site calls `prepareSimpleStreamOptions` at all (the handoff,
 * ephemeral-turn and compaction suites own that), and what a provider does with the options.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model, ProviderResponseMetadata, RawSseEvent, SimpleStreamOptions } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionConfig, SecretRuntimeLease } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries } from "@veyyon/utils";

const RESPONSE: ProviderResponseMetadata = { status: 200, headers: {}, requestId: "req_fake_0001" };
const FRAME: RawSseEvent = { event: "message_start", data: "{}", raw: ["event: message_start", "data: {}"] };

function bundledModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("missing bundled model anthropic/claude-sonnet-4-5");
	return model as Model;
}

let dir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "side-request-options-"));
	authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0).reverse()) await session.dispose();
});

afterAll(() => {
	authStorage.close();
	removeSyncWithRetries(dir);
});

/** A session whose agent resolves request metadata per provider, so the provider a request names is visible. */
function sessionWith(
	settings: Partial<Record<SettingPath, unknown>> = {},
	config: Partial<AgentSessionConfig> = {},
): AgentSession {
	const agent = new Agent({
		initialState: { model: bundledModel(), systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
		modelRegistry,
		...config,
	});
	sessions.push(session);
	agent.setMetadataResolver(provider => ({ provider }));
	return session;
}

/** A secret runtime that holds redactions and marks every payload it protects. */
function redactingLease(): SecretRuntimeLease {
	return {
		revision: 1,
		cwd: dir,
		expansionObfuscator: undefined,
		redactionObfuscator: undefined,
		hasRedactions: true,
		obfuscateText: text => text,
		obfuscateMessages: messages => messages,
		obfuscateContext: context => context,
		obfuscatePayload: payload => ({ redacted: payload }),
		isFreshForExpansion: () => true,
		ensureFreshForExpansion: async () => undefined,
		assertFreshForExpansion: () => undefined,
	};
}

describe("a side request carries the session's provider settings", () => {
	it("routes an OpenRouter request under the configured variant unless the caller names one", async () => {
		const session = sessionWith({ "providers.openrouterVariant": "nitro" });

		expect((await session.prepareSimpleStreamOptions({}, "openrouter")).openrouterVariant).toBe("nitro");
		expect(
			(await session.prepareSimpleStreamOptions({ openrouterVariant: "floor" }, "openrouter")).openrouterVariant,
		).toBe("floor");
		expect((await session.prepareSimpleStreamOptions({}, "anthropic")).openrouterVariant).toBeUndefined();
	});

	it("adds no OpenRouter variant while the setting is the default", async () => {
		const session = sessionWith();
		expect((await session.prepareSimpleStreamOptions({}, "openrouter")).openrouterVariant).toBeUndefined();
	});

	it("sends a google-antigravity request to the configured endpoint and no other provider", async () => {
		const session = sessionWith({ "providers.antigravityEndpoint": "sandbox" });

		expect((await session.prepareSimpleStreamOptions({}, "google-antigravity")).antigravityEndpointMode).toBe(
			"sandbox",
		);
		expect((await session.prepareSimpleStreamOptions({}, "anthropic")).antigravityEndpointMode).toBeUndefined();
	});

	it("caps in-flight requests at the configured limit unless the caller sets its own", async () => {
		const session = sessionWith({ "providers.maxInFlightRequests": { anthropic: 2 } });

		expect((await session.prepareSimpleStreamOptions({})).maxInFlightRequests).toEqual({ anthropic: 2 });
		expect(
			(await session.prepareSimpleStreamOptions({ maxInFlightRequests: { anthropic: 5 } })).maxInFlightRequests,
		).toEqual({ anthropic: 5 });
	});

	it("applies each loop guard setting to its own field, and a caller's override over both", async () => {
		const guardOnly = sessionWith({
			"model.loopGuard.enabled": true,
			"model.loopGuard.checkAssistantContent": false,
		});
		expect((await guardOnly.prepareSimpleStreamOptions({})).loopGuard).toEqual({
			enabled: true,
			checkAssistantContent: false,
		});

		const proseOnly = sessionWith({
			"model.loopGuard.enabled": false,
			"model.loopGuard.checkAssistantContent": true,
		});
		expect((await proseOnly.prepareSimpleStreamOptions({})).loopGuard).toEqual({
			enabled: false,
			checkAssistantContent: true,
		});
		expect((await proseOnly.prepareSimpleStreamOptions({ loopGuard: { enabled: true } })).loopGuard).toEqual({
			enabled: true,
			checkAssistantContent: true,
		});
	});
});

describe("a side request carries the session's metadata", () => {
	it("stamps the metadata the agent resolves for the request's provider, Anthropic when none is named", async () => {
		const session = sessionWith();

		expect((await session.prepareSimpleStreamOptions({})).metadata).toEqual({ provider: "anthropic" });
		expect((await session.prepareSimpleStreamOptions({}, "openai")).metadata).toEqual({ provider: "openai" });
	});

	it("keeps metadata the caller set", async () => {
		const session = sessionWith();
		const metadata = { user_id: "caller" };
		expect((await session.prepareSimpleStreamOptions({ metadata })).metadata).toBe(metadata);
	});
});

describe("a side request's payload hook", () => {
	it("protects the payload whenever the secret runtime holds redactions, with no hook configured", async () => {
		const session = sessionWith({}, { secretRuntime: redactingLease() });
		const options = await session.prepareSimpleStreamOptions({});

		expect(await options.onPayload?.({ kind: "request" }, bundledModel())).toEqual({
			redacted: { kind: "request" },
		});
	});

	it("installs none when nothing would change the payload", async () => {
		const session = sessionWith();
		expect((await session.prepareSimpleStreamOptions({})).onPayload).toBeUndefined();
	});
});

describe("a side request's response and SSE hooks", () => {
	it("records the response into the session's capture and usage ledger when the caller has no hook", async () => {
		const ingest = spyOn(authStorage, "ingestUsageHeaders");
		const session = sessionWith();
		const options = await session.prepareSimpleStreamOptions({});

		await options.onResponse?.(RESPONSE, bundledModel());

		expect(session.rawSseDebugBuffer?.snapshot().records.map(record => record.kind)).toEqual(["response"]);
		expect(ingest).toHaveBeenCalledTimes(1);
		expect(ingest.mock.calls[0]?.[0]).toBe("anthropic");
	});

	it("runs the session's interceptor and then the caller's hook", async () => {
		const order: string[] = [];
		const ingest = spyOn(authStorage, "ingestUsageHeaders").mockImplementation(() => {
			order.push("ledger");
			return false;
		});
		const session = sessionWith();
		const options = await session.prepareSimpleStreamOptions({
			onResponse: () => {
				order.push("caller");
			},
		});

		await options.onResponse?.(RESPONSE, bundledModel());

		expect(order).toEqual(["ledger", "caller"]);
		expect(ingest).toHaveBeenCalledTimes(1);
		expect(session.rawSseDebugBuffer?.snapshot().records.map(record => record.kind)).toEqual(["response"]);
	});

	it("records and feeds the ledger ahead of a session-level response hook", async () => {
		const order: string[] = [];
		spyOn(authStorage, "ingestUsageHeaders").mockImplementation(() => {
			order.push("ledger");
			return false;
		});
		const session = sessionWith(
			{},
			{
				onResponse: () => {
					order.push("session hook");
				},
			},
		);
		const options = await session.prepareSimpleStreamOptions({});

		await options.onResponse?.(RESPONSE, bundledModel());

		expect(order).toEqual(["ledger", "session hook"]);
		expect(session.rawSseDebugBuffer?.snapshot().records.map(record => record.kind)).toEqual(["response"]);
	});

	it("records a raw SSE frame and still delivers it to the caller's hook", async () => {
		const frames: RawSseEvent[] = [];
		const session = sessionWith();
		const options = await session.prepareSimpleStreamOptions({
			onSseEvent: event => {
				frames.push(event);
			},
		});

		options.onSseEvent?.(FRAME, bundledModel());

		expect(frames).toEqual([FRAME]);
		expect(session.rawSseDebugBuffer?.snapshot().records.map(record => record.kind)).toEqual(["event"]);
	});

	it("hands a caller without hooks the session's own interceptors", async () => {
		const session = sessionWith();
		const options: SimpleStreamOptions = await session.prepareSimpleStreamOptions({});

		options.onSseEvent?.(FRAME, bundledModel());
		await options.onResponse?.(RESPONSE, bundledModel());

		expect(session.rawSseDebugBuffer?.snapshot().records.map(record => record.kind)).toEqual(["event", "response"]);
	});
});
