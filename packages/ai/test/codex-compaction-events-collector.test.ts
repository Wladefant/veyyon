import { describe, expect, test } from "bun:test";
import {
	collectCodexCompactionV2Events,
	collectCodexCompactionV2Stream,
	iterateWithAbort,
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
	// The ai program has no DOM lib, so name the listener types through AbortSignal itself.
	type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];
	type AbortAddOptions = Parameters<AbortSignal["addEventListener"]>[2];
	type AbortRemoveOptions = Parameters<AbortSignal["removeEventListener"]>[2];
	function createTrackedSignal(): {
		signal: AbortSignal;
		abort: (reason?: unknown) => void;
		activeCount: () => number;
		addCalls: () => number;
		removeCalls: () => number;
	} {
		const controller = new AbortController();
		let addCalls = 0;
		let removeCalls = 0;
		const active = new Set<AbortListener>();
		const origAdd = controller.signal.addEventListener.bind(controller.signal);
		const origRemove = controller.signal.removeEventListener.bind(controller.signal);

		controller.signal.addEventListener = (type: string, listener: AbortListener, options?: AbortAddOptions) => {
			if (type === "abort") {
				addCalls++;
				active.add(listener);
			}
			return origAdd(type, listener, options);
		};

		controller.signal.removeEventListener = (type: string, listener: AbortListener, options?: AbortRemoveOptions) => {
			if (type === "abort") {
				removeCalls++;
				active.delete(listener);
			}
			return origRemove(type, listener, options);
		};

		return {
			signal: controller.signal,
			abort: (reason?: unknown) => controller.abort(reason),
			activeCount: () => active.size,
			addCalls: () => addCalls,
			removeCalls: () => removeCalls,
		};
	}

	test("observable repeated ignored events: detaches abort listener after each successful read and after EOF", async () => {
		const tracked = createTrackedSignal();
		const ignoredCount = 20;

		async function* generateEvents() {
			for (let i = 0; i < ignoredCount; i++) {
				yield { type: "response.content_part.added", part: { type: "text", text: `ignored_${i}` } };
			}
			yield {
				type: "response.output_item.done",
				item: { type: "compaction", encrypted_content: "enc_blob" },
			};
			yield {
				type: "response.completed",
				response: { usage: { input_tokens: 10, output_tokens: 20 } },
			};
		}

		const iterator = iterateWithAbort(generateEvents(), tracked.signal)[Symbol.asyncIterator]();
		expect(tracked.activeCount()).toBe(0);

		const totalEvents = ignoredCount + 2;
		for (let i = 0; i < totalEvents; i++) {
			const nextResult = await iterator.next();
			expect(nextResult.done).toBe(false);
			// After each successful read, the abort listener must be detached
			expect(tracked.activeCount()).toBe(0);
			expect(tracked.addCalls()).toBe(i + 1);
			expect(tracked.removeCalls()).toBe(i + 1);
		}

		const eofResult = await iterator.next();
		expect(eofResult.done).toBe(true);
		expect(tracked.activeCount()).toBe(0);
		expect(tracked.addCalls()).toBe(totalEvents + 1);
		expect(tracked.removeCalls()).toBe(totalEvents + 1);
	});

	test("collector detaches abort listener after each read during ignored events and at completion", async () => {
		const tracked = createTrackedSignal();
		const activeDuringEventProcessing: number[] = [];

		async function* generateEvents() {
			for (let i = 0; i < 15; i++) {
				yield {
					get type() {
						activeDuringEventProcessing.push(tracked.activeCount());
						return "response.content_part.added";
					},
				};
			}
			yield {
				get type() {
					activeDuringEventProcessing.push(tracked.activeCount());
					return "response.output_item.done";
				},
				item: { type: "compaction", encrypted_content: "enc_blob" },
			};
			yield {
				get type() {
					activeDuringEventProcessing.push(tracked.activeCount());
					return "response.completed";
				},
				response: { usage: { input_tokens: 10, output_tokens: 20 } },
			};
		}

		const result = await collectCodexCompactionV2Events(generateEvents(), tracked.signal, sanitize);
		expect(result.compactionItem.encrypted_content).toBe("enc_blob");
		expect(activeDuringEventProcessing.length).toBeGreaterThanOrEqual(17);
		for (const count of activeDuringEventProcessing) {
			expect(count).toBe(0);
		}
		expect(tracked.activeCount()).toBe(0);
		expect(tracked.addCalls()).toBe(tracked.removeCalls());
	});

	test("detaches abort listener after stream error and provider failures", async () => {
		// Stream closed before response.completed
		{
			const tracked = createTrackedSignal();
			async function* incompleteStream() {
				for (let i = 0; i < 5; i++) {
					yield { type: "response.content_part.added" };
				}
			}
			await expect(collectCodexCompactionV2Events(incompleteStream(), tracked.signal, sanitize)).rejects.toThrow();
			expect(tracked.activeCount()).toBe(0);
			expect(tracked.addCalls()).toBe(tracked.removeCalls());
		}

		// Provider failure event (response.failed)
		{
			const tracked = createTrackedSignal();
			async function* failedStream() {
				yield { type: "response.content_part.added" };
				yield {
					type: "response.failed",
					response: { error: { message: "backend fault" } },
				};
			}
			await expect(collectCodexCompactionV2Events(failedStream(), tracked.signal, sanitize)).rejects.toThrow();
			expect(tracked.activeCount()).toBe(0);
			expect(tracked.addCalls()).toBe(tracked.removeCalls());
		}

		// Source iterator throws error
		{
			const tracked = createTrackedSignal();
			async function* throwingStream() {
				yield { type: "response.content_part.added" };
				throw new Error("transport failure");
			}
			await expect(collectCodexCompactionV2Events(throwingStream(), tracked.signal, sanitize)).rejects.toThrow();
			expect(tracked.activeCount()).toBe(0);
			expect(tracked.addCalls()).toBe(tracked.removeCalls());
		}
	});

	test("detaches abort listener after pending-read abort", async () => {
		const tracked = createTrackedSignal();
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

		const collectPromise = collectCodexCompactionV2Events(blockedIterable, tracked.signal, sanitize);
		await nextEntered.promise;

		// While read is blocked, exactly one listener is active
		expect(tracked.activeCount()).toBe(1);

		tracked.abort();
		expect(returnCalled).toBe(true);
		await expect(collectPromise).rejects.toThrow();

		// After abort settlement, listener is detached
		expect(tracked.activeCount()).toBe(0);
		expect(tracked.addCalls()).toBe(tracked.removeCalls());

		nextBlocked.resolve({ done: true, value: undefined });
	});

	test("forced-GC regression: bounded retained heap growth across 150k ignored events with AbortSignal", async () => {
		const controller = new AbortController();
		let heapAt50k = 0;
		let heapAt150k = 0;

		async function* generateEvents() {
			for (let i = 0; i < 150_000; i++) {
				if (i === 50_000) {
					Bun.gc(true);
					Bun.gc(true);
					heapAt50k = process.memoryUsage().heapUsed;
				}
				yield { type: "response.created" };
			}
			Bun.gc(true);
			Bun.gc(true);
			heapAt150k = process.memoryUsage().heapUsed;
			yield {
				type: "response.output_item.done",
				item: { type: "compaction", encrypted_content: "enc_blob" },
			};
			yield {
				type: "response.completed",
				response: { usage: { input_tokens: 10, output_tokens: 20 } },
			};
		}

		const result = await collectCodexCompactionV2Events(generateEvents(), controller.signal, sanitize);
		expect(result.compactionItem.encrypted_content).toBe("enc_blob");
		expect(heapAt50k).toBeGreaterThan(0);
		expect(heapAt150k).toBeGreaterThan(0);

		const heapGrowth = heapAt150k - heapAt50k;
		const maxAllowanceBytes = 4 * 1024 * 1024; // <4 MiB allowance
		expect(heapGrowth).toBeLessThan(maxAllowanceBytes);
	});
});
