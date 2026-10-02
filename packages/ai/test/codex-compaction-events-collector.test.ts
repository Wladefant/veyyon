import { describe, expect, test } from "bun:test";
import { collectCodexCompactionV2Events } from "../src/providers/openai-codex/compaction-v2";

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

		await expect(collectCodexCompactionV2Events(createEventStream(events), controller.signal, sanitize)).rejects.toThrow(
			/aborted before response\.completed/,
		);
	});
});
