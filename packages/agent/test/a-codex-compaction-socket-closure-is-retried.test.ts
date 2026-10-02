/**
 * WHY: When streaming Codex remote compaction hits a transient socket closure,
 * compactWithProvider must retry up to 2 times before falling back to local compaction.
 * Class closed: dropping remote Codex compaction on transient socket drops.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	CODEX_COMPACTION_MAX_SOCKET_RETRIES,
	compactWithProvider,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getRemoteCompactionPreserveData,
	isUnexpectedSocketCloseError,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import { resetServerCompactionRouteCache } from "@veyyon/ai/providers/openai-compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import type { FetchImpl } from "@veyyon/utils";

const codexModel = getBundledModel("openai-codex", "gpt-5.1-codex")!;
const openAiModel = getBundledModel("openai", "gpt-5.1")!;

const sseChunk = new TextEncoder().encode(
	'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","encrypted_content":"enc_test_blob"}}\n\n' +
		'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":45}}}\n\n',
);

const mockSse = (err?: Error) =>
	new Response(
		new ReadableStream({
			start(c) {
				if (err) return c.error(err);
				c.enqueue(sseChunk);
				c.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);

const prep = () => ({
	firstKeptEntryId: "k",
	messagesToSummarize: [{ role: "user" as const, content: "h", timestamp: 1 }],
	turnPrefixMessages: [],
	recentMessages: [{ role: "user" as const, content: "r", timestamp: 2 }],
	isSplitTurn: false,
	tokensBefore: 100,
	fileOps: createFileOps(),
	settings: { ...DEFAULT_COMPACTION_SETTINGS },
});

const runCompact = (fetch: FetchImpl, signal?: AbortSignal, model = codexModel) =>
	compactWithProvider(prep(), model, "k", undefined, signal, { fetch, sessionId: "session-test" });

afterEach(() => {
	resetServerCompactionRouteCache();
});

describe("remote Codex compaction retries unexpected socket closures", () => {
	test.each(["The socket connection was closed unexpectedly", "socket connection closed unexpectedly"] as const)(
		"retries a transient socket closure during fetch: %s",
		async msg => {
			let attempts = 0;
			const res = await runCompact(async () => (++attempts === 1 ? Promise.reject(new Error(msg)) : mockSse()));
			expect(attempts).toBe(2);
			const data = getRemoteCompactionPreserveData(res.preserveData)!;
			expect(data.window.some(i => i.type === "compaction" && i.encrypted_content === "enc_test_blob")).toBe(true);
			expect(data.inputTokens).toBe(120);
			expect(data.outputTokens).toBe(45);
		},
	);

	test("retries a transient socket closure during stream read", async () => {
		let attempts = 0;
		const res = await runCompact(async () =>
			++attempts === 1 ? mockSse(new Error("socket connection closed unexpectedly")) : mockSse(),
		);
		expect(attempts).toBe(2);
		const data = getRemoteCompactionPreserveData(res.preserveData)!;
		expect(data.window.some(i => i.type === "compaction" && i.encrypted_content === "enc_test_blob")).toBe(true);
	});

	test("stops retrying when repeated failures exceed max socket retries bound", async () => {
		let attempts = 0;
		await expect(
			runCompact(() => {
				attempts++;
				return Promise.reject(new Error("socket connection closed unexpectedly"));
			}),
		).rejects.toThrow("socket connection closed unexpectedly");
		expect(attempts).toBe(CODEX_COMPACTION_MAX_SOCKET_RETRIES + 1);
	});

	test("does not retry when caller's signal is aborted", async () => {
		const controller = new AbortController();
		let attempts = 0;
		await expect(
			runCompact(() => {
				attempts++;
				controller.abort(new DOMException("Aborted", "AbortError"));
				throw new Error("socket connection closed unexpectedly");
			}, controller.signal),
		).rejects.toThrow();
		expect(attempts).toBe(1);
	});

	test("preserves 404 route-absent caching and caches route absence even after initial socket retry", async () => {
		expect(resolveServerCompactionTransport(codexModel)).toBeDefined();
		let attempts = 0;
		await expect(
			runCompact(async () => {
				return ++attempts === 1
					? Promise.reject(new Error("socket connection closed unexpectedly"))
					: new Response("Not Found", { status: 404, statusText: "Not Found" });
			}),
		).rejects.toThrow();
		expect(attempts).toBe(2);
		expect(resolveServerCompactionTransport(codexModel)).toBeUndefined();
	});

	test("mutation negative control: non-socket error does not retry", async () => {
		let attempts = 0;
		await expect(
			runCompact(() => {
				attempts++;
				return Promise.reject(new Error("Invalid request format: malformed JSON"));
			}),
		).rejects.toThrow("Invalid request format: malformed JSON");
		expect(attempts).toBe(1);
	});

	test("mutation negative control: non-Codex model does not retry transient socket error", async () => {
		let attempts = 0;
		const fail = async () =>
			++attempts === 1 ? Promise.reject(new Error("socket connection closed unexpectedly")) : mockSse();
		await expect(runCompact(fail, undefined, openAiModel)).rejects.toThrow("socket connection closed unexpectedly");
		expect(attempts).toBe(1);
	});

	test("isUnexpectedSocketCloseError classifies transient socket closures and causes", () => {
		for (const err of [
			new Error("The socket connection was closed unexpectedly"),
			new Error("socket connection closed unexpectedly"),
			"the socket connection was closed unexpectedly",
			new Error("wrap", { cause: new Error("socket connection closed unexpectedly") }),
		])
			expect(isUnexpectedSocketCloseError(err)).toBe(true);
		for (const err of [new Error("timeout"), new Error("abort"), new Error("500"), undefined])
			expect(isUnexpectedSocketCloseError(err)).toBe(false);
	});
});
