import { describe, expect, test } from "bun:test";
import {
	collectCodexCompactionV2Events,
	collectCodexCompactionV2Stream,
} from "../src/providers/openai-codex/compaction-v2";

describe("collectCodexCompactionV2Events", () => {
	const sanitize = (text: string) => text;

	async function* createEventStream(events: unknown[]): AsyncGenerator<unknown> {
		for (const event of events) {
			yield event;
		}
	}

	test("collects valid compaction item and usage from decoded native events", async () => {
		const events = [
			{ type: "response.created" },
			{
				type: "response.output_item.done",
				item: {
					type: "compaction",
					encrypted_content: "enc_blob_12345",
				},
			},
			{
				type: "response.completed",
				response: {
					usage: {
						input_tokens: 120,
						output_tokens: 45,
					},
				},
			},
		];

		const result = await collectCodexCompactionV2Events(createEventStream(events), undefined, sanitize);
		expect(result.compactionItem).toEqual({
			type: "compaction",
			encrypted_content: "enc_blob_12345",
		});
		expect(result.usage).toEqual({
			inputTokens: 120,
			outputTokens: 45,
		});
	});

	test("negative control: fails when stream carries no compaction item", async () => {
		const events = [
			{ type: "response.created" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
				},
			},
			{
				type: "response.completed",
				response: { usage: { input_tokens: 10, output_tokens: 5 } },
			},
		];

		await expect(collectCodexCompactionV2Events(createEventStream(events), undefined, sanitize)).rejects.toThrow(
			/expected exactly one/,
		);
	});

	test("negative control: fails when compaction item has malformed encrypted_content", async () => {
		const events = [
			{
				type: "response.output_item.done",
				item: {
					type: "compaction",
					encrypted_content: 12345, // invalid: must be string
				},
			},
			{
				type: "response.completed",
				response: {},
			},
		];

		await expect(collectCodexCompactionV2Events(createEventStream(events), undefined, sanitize)).rejects.toThrow(
			/with no encrypted_content/,
		);
	});

	test("negative control: fails when stream ends without response.completed", async () => {
		const events = [
			{
				type: "response.output_item.done",
				item: {
					type: "compaction",
					encrypted_content: "blob",
				},
			},
		];

		await expect(collectCodexCompactionV2Events(createEventStream(events), undefined, sanitize)).rejects.toThrow(
			/closed before response\.completed/,
		);
	});

	test("aborts before response.completed when signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const events = [
			{
				type: "response.output_item.done",
				item: { type: "compaction", encrypted_content: "blob" },
			},
		];

		await expect(
			collectCodexCompactionV2Events(createEventStream(events), controller.signal, sanitize),
		).rejects.toThrow(/aborted before response\.completed/);
	});

	test("reproduction: rejects pre-aborted signal even when stream carries completed compaction", async () => {
		const controller = new AbortController();
		controller.abort();

		const events = [
			{
				type: "response.output_item.done",
				item: { type: "compaction", encrypted_content: "blob" },
			},
			{
				type: "response.completed",
				response: { usage: { input_tokens: 10, output_tokens: 20 } },
			},
		];

		await expect(
			collectCodexCompactionV2Events(createEventStream(events), controller.signal, sanitize),
		).rejects.toThrow();
	});

	test("reproduction: interrupts pending next() and cleans up iterator when signal aborts during blocked read", async () => {
		const controller = new AbortController();
		let returnCalled = false;
		const nextEntered = Promise.withResolvers<void>();
		const nextBlocked = Promise.withResolvers<IteratorResult<unknown>>();

		const blockedIterable: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						nextEntered.resolve();
						return nextBlocked.promise;
					},
					async return() {
						returnCalled = true;
						return { done: true, value: undefined };
					},
				};
			},
		};

		const collectPromise = collectCodexCompactionV2Events(blockedIterable, controller.signal, sanitize);

		// Wait until next() has definitely been entered by the collector
		await nextEntered.promise;

		// Now abort while next() is still blocked
		controller.abort();

		try {
			expect(returnCalled).toBe(true);
			await expect(collectPromise).rejects.toThrow();
		} finally {
			nextBlocked.resolve({ done: true, value: undefined });
		}
	});

	test("pre-aborted completed input does not pull events from source", async () => {
		const controller = new AbortController();
		controller.abort();
		let nextCalled = false;
		const iterable: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						nextCalled = true;
						return {
							done: false,
							value: {
								type: "response.completed",
								response: { usage: { input_tokens: 10, output_tokens: 20 } },
							},
						};
					},
					async return() {
						return { done: true, value: undefined };
					},
				};
			},
		};

		await expect(collectCodexCompactionV2Events(iterable, controller.signal, sanitize)).rejects.toThrow();
		expect(nextCalled).toBe(false);
	});

	test("async generator provider-failure cleanup: cleans up source on response.failed", async () => {
		let cleanupRan = false;
		async function* failingStream(): AsyncGenerator<unknown> {
			try {
				yield {
					type: "response.failed",
					response: {
						error: { message: "model overloaded", code: "rate_limit" },
					},
				};
			} finally {
				cleanupRan = true;
			}
		}

		await expect(collectCodexCompactionV2Events(failingStream(), undefined, sanitize)).rejects.toThrow(
			/model overloaded/,
		);
		expect(cleanupRan).toBe(true);
	});

	test("async generator provider-failure cleanup: cleans up source on response.incomplete and error", async () => {
		let incompleteCleaned = false;
		async function* incompleteStream(): AsyncGenerator<unknown> {
			try {
				yield {
					type: "response.incomplete",
					response: { error: { message: "token cutoff" } },
				};
			} finally {
				incompleteCleaned = true;
			}
		}

		await expect(collectCodexCompactionV2Events(incompleteStream(), undefined, sanitize)).rejects.toThrow(
			/token cutoff/,
		);
		expect(incompleteCleaned).toBe(true);

		let errorCleaned = false;
		async function* errorStream(): AsyncGenerator<unknown> {
			try {
				yield {
					type: "error",
					error: { message: "socket reset" },
				};
			} finally {
				errorCleaned = true;
			}
		}

		await expect(collectCodexCompactionV2Events(errorStream(), undefined, sanitize)).rejects.toThrow(/socket reset/);
		expect(errorCleaned).toBe(true);
	});

	function createFailingSseStream(eventPayload: string, onCancel?: () => void): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${eventPayload}\n\n`));
			},
			cancel() {
				onCancel?.();
			},
		});
	}

	test("SSE stream cancels and unlocks reader on response.failed", async () => {
		let cancelCalled = false;
		const stream = createFailingSseStream(
			JSON.stringify({
				type: "response.failed",
				response: { error: { message: "backend failure" } },
			}),
			() => {
				cancelCalled = true;
			},
		);

		await expect(collectCodexCompactionV2Stream(stream, undefined, sanitize)).rejects.toThrow(/backend failure/);
		expect(stream.locked).toBe(false);
		expect(cancelCalled).toBe(true);
	});

	test("SSE stream cancels and unlocks reader on response.incomplete", async () => {
		let cancelCalled = false;
		const stream = createFailingSseStream(
			JSON.stringify({
				type: "response.incomplete",
				response: { error: { message: "truncated response" } },
			}),
			() => {
				cancelCalled = true;
			},
		);

		await expect(collectCodexCompactionV2Stream(stream, undefined, sanitize)).rejects.toThrow(/truncated response/);
		expect(stream.locked).toBe(false);
		expect(cancelCalled).toBe(true);
	});

	test("SSE stream cancels and unlocks reader on error event", async () => {
		let cancelCalled = false;
		const stream = createFailingSseStream(
			JSON.stringify({
				type: "error",
				error: { message: "stream broke" },
			}),
			() => {
				cancelCalled = true;
			},
		);

		await expect(collectCodexCompactionV2Stream(stream, undefined, sanitize)).rejects.toThrow(/stream broke/);
		expect(stream.locked).toBe(false);
		expect(cancelCalled).toBe(true);
	});

	test("preserves primary provider failure error when iterator return() rejects", async () => {
		let returnCalled = false;
		const iterable: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						return {
							done: false,
							value: {
								type: "response.failed",
								response: { error: { message: "primary backend failure" } },
							},
						};
					},
					async return() {
						returnCalled = true;
						throw new Error("secondary cleanup failure");
					},
				};
			},
		};

		await expect(collectCodexCompactionV2Events(iterable, undefined, sanitize)).rejects.toThrow(
			/primary backend failure/,
		);
		expect(returnCalled).toBe(true);
	});
	test("preserves primary transport error when iterator return() rejects", async () => {
		let returnCalled = false;
		const iterable: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						throw new Error("primary transport network fault");
					},
					async return() {
						returnCalled = true;
						throw new Error("secondary cleanup failure");
					},
				};
			},
		};

		await expect(collectCodexCompactionV2Events(iterable, undefined, sanitize)).rejects.toThrow(
			/primary transport network fault/,
		);
		expect(returnCalled).toBe(true);
	});
});
