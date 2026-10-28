// WHY: ConverseStream failures arrive inside HTTP 200 frames, so their shape is the only service-status evidence. Hardcoding 400 loses retryable statuses. This class-level sweep covers both frame forms; it does not cover changes to AWS's service model.
import { describe, expect, test } from "bun:test";
import { retriable } from "@veyyon/ai/error";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { crc32 } from "@veyyon/ai/providers/aws-eventstream";
import type { AssistantMessage, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const model: Model<"bedrock-converse-stream"> = buildModel({
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

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const bytes = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(bytes.buffer);
	let offset = 0;
	view.setUint8(offset++, nameBytes.length);
	bytes.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset++, 7);
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	bytes.set(valueBytes, offset);
	return bytes;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let offset = 0;
	for (const chunk of headerChunks) {
		headerBytes.set(chunk, offset);
		offset += chunk.length;
	}
	const totalLength = 4 + 4 + 4 + headerLength + payload.length + 4;
	const bytes = new Uint8Array(totalLength);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
	bytes.set(headerBytes, 12);
	bytes.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(bytes.subarray(0, totalLength - 4)), false);
	return bytes;
}

function exceptionFrame(code: string): Uint8Array {
	return encodeFrame(
		{ ":message-type": "exception", ":exception-type": code, ":content-type": "application/json" },
		new TextEncoder().encode(JSON.stringify({ message: "service failure" })),
	);
}

function errorFrame(code: string | undefined): Uint8Array {
	const headers: Record<string, string> = {
		":message-type": "error",
		":error-message": "service failure",
	};
	if (code !== undefined) headers[":error-code"] = code;
	return encodeFrame(headers, new Uint8Array(0));
}

async function failWithFrame(frame: Uint8Array): Promise<AssistantMessage> {
	const fetchImpl: FetchImpl = Object.assign(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(frame);
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
			),
		{ preconnect: fetch.preconnect },
	);
	for await (const event of streamBedrock(model, context, { bearerToken: "test-token", fetch: fetchImpl })) {
		if (event.type === "error") return event.error;
	}
	throw new Error("stream ended without an error event");
}

const cases = [
	["accessDeniedException", 403],
	["conflictException", 400],
	["internalServerException", 500],
	["modelErrorException", 424],
	["modelNotReadyException", 429],
	["modelStreamErrorException", 424],
	["modelTimeoutException", 408],
	["resourceNotFoundException", 404],
	["serviceQuotaExceededException", 400],
	["serviceUnavailableException", 503],
	["throttlingException", 429],
	["validationException", 400],
] as const;

const retriableStatuses = new Set([500, 503, 429, 408]);

describe("Bedrock stream failure service statuses", () => {
	for (const [code, status] of cases) {
		test(`${code} exception frame keeps status ${status}`, async () => {
			const failed = await failWithFrame(exceptionFrame(code));
			expect(failed.stopReason).toBe("error");
			expect(failed.errorStatus).toBe(status);
			if (retriableStatuses.has(status)) {
				expect(failed.errorId !== undefined && retriable(failed.errorId)).toBe(true);
			} else if (code === "validationException") {
				expect(failed.errorId === undefined || !retriable(failed.errorId)).toBe(true);
			}
		}, 10_000);

		test(`${code} PascalCase error frame keeps status ${status}`, async () => {
			const pascalCase = code[0].toUpperCase() + code.slice(1);
			const failed = await failWithFrame(errorFrame(pascalCase));
			expect(failed.stopReason).toBe("error");
			expect(failed.errorStatus).toBe(status);
			if (retriableStatuses.has(status)) {
				expect(failed.errorId !== undefined && retriable(failed.errorId)).toBe(true);
			} else if (code === "validationException") {
				expect(failed.errorId === undefined || !retriable(failed.errorId)).toBe(true);
			}
		}, 10_000);
	}

	for (const code of ["unknownException", "constructor", "toString", "__proto__"] as const) {
		test(`${code} unknown exception shape defaults to terminal 400`, async () => {
			const failed = await failWithFrame(exceptionFrame(code));
			expect(failed.stopReason).toBe("error");
			expect(failed.errorStatus).toBe(400);
			expect(failed.errorId === undefined || !retriable(failed.errorId)).toBe(true);
		}, 10_000);
	}

	test("normalizes whitespace around a PascalCase error code", async () => {
		const failed = await failWithFrame(errorFrame("  InternalServerException  "));
		expect(failed.stopReason).toBe("error");
		expect(failed.errorStatus).toBe(500);
	}, 10_000);

	test("missing error-code shape defaults to terminal 400", async () => {
		const failed = await failWithFrame(errorFrame(undefined));
		expect(failed.stopReason).toBe("error");
		expect(failed.errorStatus).toBe(400);
		expect(failed.errorId === undefined || !retriable(failed.errorId)).toBe(true);
	}, 10_000);
});
