/**
 * A tool the session requires reaches a host that cannot force it as a request that asks for the
 * call, and the call the model makes runs the tool.
 *
 * WHY THIS SUITE EXISTS. A host whose compat declares `supportsToolChoice: false` receives no
 * `tool_choice`. The session's forced sites, the forced-choice queue behind `/force` and a prompt
 * that carries a tool choice (the executor's final `yield` reminder), sent such a host a request
 * that only offered the tool. And `buildNamedToolChoice`, which every forced site reads, returned
 * nothing for the OpenRouter, Cursor, Devin and GitLab APIs, so on those the sites required
 * nothing at all and `/force` failed.
 *
 * THE CLASS THIS CLOSES. A forced site whose requirement the host never reads: each site is driven
 * through a real `AgentSession` and the real stream function against a host that cannot force and
 * one that can, and the request on the wire is read. Every API a built-in provider implements is
 * swept for a tool choice that requires the tool; the APIs that require any tool rather than the
 * named one are pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH. Whether a live model complies with the request text; the off and on arms
 * measured against a live host are the evidence for that.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { streamSimple } from "@veyyon/ai/stream";
import type { Api, FetchImpl, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { buildNamedToolChoice } from "@veyyon/coding-agent/utils/tool-choice";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const PROVIDER = "tool-choice-host";
const REQUIRED_TOOL = "write";
const INSTRUCTION = "This turn must call the `write` tool.";

function hostModel(forces: boolean): Model<"openai-completions"> {
	const model = buildModel({
		id: "tool-choice-host-model",
		name: "Tool choice host model",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: "https://tool-choice-host.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as ModelSpec<"openai-completions">) as Model<"openai-completions">;
	return { ...model, compat: { ...model.compat, supportsToolChoice: forces } };
}

function sse(events: readonly unknown[]): Response {
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function chunk(delta: unknown, finish: string | null): unknown {
	return {
		id: "chatcmpl-host",
		object: "chat.completion.chunk",
		created: 0,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

/** A host that answers the first request with a call to the required tool and every later one with text. */
class FakeHost {
	readonly bodies: Record<string, unknown>[] = [];

	readonly fetch: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			this.bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
			if (this.bodies.length > 1) return sse([chunk({ content: "done" }, null), chunk({}, "stop"), "[DONE]"]);
			const call = {
				index: 0,
				id: "call_write",
				type: "function",
				function: { name: REQUIRED_TOOL, arguments: "{}" },
			};
			return sse([chunk({ tool_calls: [call] }, null), chunk({}, "tool_calls"), "[DONE]"]);
		},
		{ preconnect: fetch.preconnect },
	);
}

function asksInText(body: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(body?.messages ?? []).includes(INSTRUCTION);
}

/** The forced sites, each entered the way production enters it. */
const FORCED_SITES: readonly { label: string; run: (session: AgentSession) => Promise<void> }[] = [
	{
		label: "the forced-choice queue behind /force",
		run: async session => {
			session.setForcedToolChoice(REQUIRED_TOOL);
			await session.prompt("go");
		},
	},
	{
		label: "a prompt that carries a tool choice, as the executor's final yield reminder does",
		run: async session => {
			await session.prompt("go", { toolChoice: buildNamedToolChoice(REQUIRED_TOOL, session.model) });
		},
	},
];

describe("a tool the session requires", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-required-tool-host-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(PROVIDER, "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	async function drive(
		forces: boolean,
		site: (session: AgentSession) => Promise<void>,
	): Promise<{ host: FakeHost; ran: number }> {
		const host = new FakeHost();
		let ran = 0;
		const writeTool: AgentTool = {
			name: REQUIRED_TOOL,
			label: "Write",
			description: "Write a file",
			parameters: type("object"),
			execute: async () => {
				ran++;
				return { content: [{ type: "text" as const, text: "written" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: hostModel(forces), systemPrompt: ["Test"], tools: [writeTool], messages: [] },
			convertToLlm,
			streamFn: (model, context, options) => streamSimple(model, context, { ...options, fetch: host.fetch }),
			// The session's forced-choice queue reaches the loop the way `sdk.ts` connects it.
			getToolChoice: () => session?.nextToolChoiceDirective(),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map([[writeTool.name, writeTool]]),
		});
		await site(session);
		await session.waitForIdle();
		return { host, ran };
	}

	for (const { label, run } of FORCED_SITES) {
		it(`${label}: is asked for in the request on a host that cannot force it, and runs`, async () => {
			const { host, ran } = await drive(false, run);
			expect(host.bodies[0]?.tool_choice).toBeUndefined();
			expect(asksInText(host.bodies[0])).toBe(true);
			expect(ran).toBe(1);
		});

		it(`${label}: is forced on a host that can force it, and is not asked for in text`, async () => {
			const { host, ran } = await drive(true, run);
			expect(host.bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: REQUIRED_TOOL } });
			expect(asksInText(host.bodies[0])).toBe(false);
			expect(ran).toBe(1);
		});
	}

	it("is required on every API a built-in provider implements", () => {
		const choices = BUILTIN_API_IDS.map(api => ({
			api,
			choice: buildNamedToolChoice(REQUIRED_TOOL, { ...hostModel(true), api } as Model<Api>),
		}));
		expect(choices.filter(({ choice }) => choice === undefined).map(({ api }) => api)).toEqual([]);
		expect(choices.filter(({ choice }) => choice === "required").map(({ api }) => api)).toEqual([
			"google-generative-ai",
			"google-gemini-cli",
			"google-vertex",
		]);
		for (const { api, choice } of choices) {
			if (choice === "required") continue;
			expect({ api, choice }).toMatchObject({ api, choice: { name: REQUIRED_TOOL } });
		}
	});

	it("is not required on an API no built-in provider implements", () => {
		expect(
			buildNamedToolChoice(REQUIRED_TOOL, { ...hostModel(true), api: "custom-api" } as Model<Api>),
		).toBeUndefined();
	});
});
