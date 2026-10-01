import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";

interface BedrockPayload {
	system?: Array<{ text: string } | { cachePoint: unknown }>;
}

function bedrockModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "haiku",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function devinModel(): Model<"devin-agent"> {
	return buildModel({
		id: "devin",
		name: "Devin",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://api.devin.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

// Capture the request payload the provider would send, without a network call:
// an already-aborted signal short-circuits after `onPayload` fires.
async function captureBedrockPayload(systemPrompt: Context["systemPrompt"]): Promise<BedrockPayload> {
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
	const { promise, resolve } = Promise.withResolvers<BedrockPayload | undefined>();
	const stream = streamBedrock(bedrockModel(), context, {
		bearerToken: "test-token",
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as BedrockPayload);
		},
	});
	// Drain the stream so the request-building path (and thus onPayload) runs.
	void (async () => {
		try {
			for await (const _ of stream) {
				// ignore events; we only care about the captured payload
			}
		} finally {
			resolve(undefined);
		}
	})();
	const payload = await promise;
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

async function captureDevinPayload(systemPrompt: Context["systemPrompt"]): Promise<Record<string, unknown>> {
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
	const authResponse = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "test-jwt" }));
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("GetUserJwt")) {
			return new Response(authResponse);
		}
		return new Response(new Uint8Array(0));
	}) as typeof fetch;

	const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | undefined>();
	const stream = streamDevin(devinModel(), context, {
		apiKey: "test-key",
		fetch: fetchImpl,
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as Record<string, unknown>);
		},
	});
	void (async () => {
		try {
			for await (const _ of stream) {
				// ignore events
			}
		} finally {
			resolve(undefined);
		}
	})();
	const payload = await promise;
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

describe("Bedrock system prompt normalization", () => {
	// Regression for #7037: legacy pi extensions remapped onto the fork pass
	// Context.systemPrompt as a bare string, which crashed buildSystemPrompt's
	// unguarded `.map()`. It must normalize to a single-element system block.
	test("accepts a bare-string systemPrompt", async () => {
		const payload = await captureBedrockPayload("You are a test." as unknown as string[]);
		const texts = (payload.system ?? [])
			.filter((block): block is { text: string } => "text" in block)
			.map(block => block.text);
		expect(texts).toEqual(["You are a test."]);
	});

	test("string and single-element array produce identical system blocks", async () => {
		const fromString = await captureBedrockPayload("You are a test." as unknown as string[]);
		const fromArray = await captureBedrockPayload(["You are a test."]);
		const textsFromString = (fromString.system ?? [])
			.filter((block): block is { text: string } => "text" in block)
			.map(block => block.text);
		const textsFromArray = (fromArray.system ?? [])
			.filter((block): block is { text: string } => "text" in block)
			.map(block => block.text);
		expect(textsFromString).toEqual(textsFromArray);
	});
});

describe("Devin system prompt normalization", () => {
	test("accepts a bare-string systemPrompt", async () => {
		const payload = await captureDevinPayload("You are a test." as unknown as string[]);
		expect(payload.prompt).toBe("You are a test.");
	});
});
