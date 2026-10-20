// WHY: a session that inlines the tool catalog into the system prompt (`inlineToolDescriptors`, e.g. one
// started on Gemini and switched to Bedrock) prunes every tool description to "". Bedrock's
// ToolSpecification.description is optional but has minLength 1 when present, so sending `""` made AWS
// reject the whole request with HTTP 400 (oh-my-pi 8039fa8da5839366739d2ffc908301e013e30ca5).
// The suite reads the bytes handed to fetch, so it sees what AWS sees. Gap: it covers the Converse
// tool list only, not a description another provider might send empty.
import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import type { Context, Model, Tool } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

interface SentToolSpec {
	name: string;
	description?: string;
	inputSchema: { json: { type?: string; properties?: Record<string, unknown> } };
}

interface SentBody {
	toolConfig: { tools: Array<{ toolSpec: SentToolSpec }> };
}

const model: Model<"bedrock-converse-stream"> = buildModel({
	id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
	name: "haiku",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

/** The JSON body of the first request streamBedrock hands to fetch. */
async function captureSentBody(tools: Tool[]): Promise<SentBody> {
	const { promise, resolve, reject } = Promise.withResolvers<SentBody>();
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools };
	const stream = streamBedrock(model, context, {
		region: "us-east-1",
		bearerToken: "fake-bedrock-test-token",
		fetch: async (_input, init) => {
			const body = init?.body;
			const text =
				body instanceof Uint8Array
					? new TextDecoder().decode(body)
					: body instanceof ArrayBuffer
						? new TextDecoder().decode(new Uint8Array(body))
						: String(body);
			resolve(JSON.parse(text) as SentBody);
			return new Response("", { status: 400 });
		},
	});
	// The 400 ends the stream with an error; only the captured request matters here.
	void stream.result().catch(reject);
	return promise;
}

describe("Bedrock tool description serialization", () => {
	it('omits a pruned empty description instead of sending description: ""', async () => {
		const body = await captureSentBody([
			{ name: "read", description: "", parameters: { type: "object", properties: { path: { type: "string" } } } },
			{
				name: "write",
				description: "Write a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		]);

		const pruned = body.toolConfig.tools.find(tool => tool.toolSpec.name === "read")?.toolSpec;
		const described = body.toolConfig.tools.find(tool => tool.toolSpec.name === "write")?.toolSpec;
		expect(pruned).toBeDefined();
		expect(Object.hasOwn(pruned ?? {}, "description")).toBe(false);
		expect(pruned?.inputSchema.json.type).toBe("object");
		expect(pruned?.inputSchema.json.properties).toHaveProperty("path");
		// A real description still rides the wire verbatim.
		expect(described?.description).toBe("Write a file");
	});
});
