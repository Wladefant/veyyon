import { describe, expect, it } from "bun:test";
import {
	BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	externalizeTextSync,
} from "@veyyon/kernel/session/blob-store";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: a transcript repeats one externalized payload at every turn that resends it, and a load read
 * and decoded it once per reference. A real 5,660-reference session held 267 distinct blobs: its open
 * read 403.9 MiB from the blob store for 16.7 MiB of distinct payload, and a store missing them
 * logged one warning per reference (11,006 lines for 133 hashes over two opens).
 *
 * The class this closes: within one load, each distinct reference is read once per decoding, every
 * site holding it receives the decoded payload, and a reference the store cannot answer still counts
 * once per site. The site kinds are swept, so a reference at any slot the load restores shares its
 * read. One blob referenced as base64 image data and as a provider data URL decodes twice, so a
 * shared read never hands one slot the other's decoding.
 *
 * What it does NOT catch: the wall-time and byte counts themselves, which .internal/bench-blob-open.ts
 * measures; reuse across loads, which is not a contract (each load reads the store afresh); and the
 * per-line cold restore (`restoreEntryPayloadsSync`), which reads one entry's references.
 */

/** Counts reads at the store. Each read yields once before it settles, so the pool's workers overlap. */
function countReads(store: BlobStore): { reads: string[] } {
	const observed = { reads: [] as string[] };
	const get = store.get.bind(store);
	Object.defineProperty(store, "get", {
		value: async (hash: string) => {
			observed.reads.push(hash);
			await Promise.resolve();
			return get(hash);
		},
	});
	return observed;
}

async function withStore<T>(run: (store: BlobStore) => Promise<T>): Promise<T> {
	const dir = TempDir.createSync("@pi-blob-once-");
	try {
		return await run(new BlobStore(dir.path()));
	} finally {
		await dir.remove();
	}
}

function messageEntry(id: string, message: Record<string, unknown>): FileEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", timestamp: 0, ...message },
	} as unknown as FileEntry;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** Each slot a load restores: how a message holds a reference there, and how to read the slot back. */
const SITE_KINDS: {
	kind: string;
	reference: (store: BlobStore) => string;
	expected: string;
	message: (reference: string) => Record<string, unknown>;
	read: (message: Record<string, unknown>) => unknown;
}[] = [
	{
		kind: "an image block's data",
		reference: store => externalizeImageDataSync(store, PNG.toString("base64"), "image/png"),
		expected: PNG.toString("base64"),
		message: reference => ({ content: [{ type: "image", data: reference, mimeType: "image/png" }] }),
		read: message => (message.content as [{ data: string }])[0].data,
	},
	{
		kind: "an attached image's data",
		reference: store => externalizeImageDataSync(store, PNG.toString("base64"), "image/png"),
		expected: PNG.toString("base64"),
		message: reference => ({ content: [], images: [{ data: reference, mimeType: "image/png" }] }),
		read: message => (message.images as [{ data: string }])[0].data,
	},
	{
		kind: "a provider image url",
		reference: store => externalizeImageDataUrlSync(store, `data:image/png;base64,${PNG.toString("base64")}`),
		expected: `data:image/png;base64,${PNG.toString("base64")}`,
		message: reference => ({ content: [], providerPayload: { image_url: reference } }),
		read: message => (message.providerPayload as { image_url: string }).image_url,
	},
	{
		kind: "a text at a key",
		reference: store => externalizeTextSync(store, "a repeated tool output"),
		expected: "a repeated tool output",
		message: reference => ({ content: [{ type: "text", text: reference }] }),
		read: message => (message.content as [{ text: string }])[0].text,
	},
	{
		kind: "a text array item",
		reference: store => externalizeTextSync(store, "a repeated array item"),
		expected: "a repeated array item",
		message: reference => ({ content: [reference] }),
		read: message => (message.content as [string])[0],
	},
];

describe("a session load", () => {
	for (const site of SITE_KINDS) {
		it(`reads ${site.kind} repeated across entries once and restores every copy`, async () => {
			await withStore(async store => {
				const reference = site.reference(store);
				const entries = Array.from({ length: 12 }, (_, index) =>
					messageEntry(`e${index}`, site.message(reference)),
				);
				const observed = countReads(store);

				const lost = await resolveBlobRefsInEntries(entries, store);

				expect(lost).toBe(0);
				expect(observed.reads).toHaveLength(1);
				expect(
					entries.map(entry => site.read((entry as unknown as { message: Record<string, unknown> }).message)),
				).toEqual(Array.from({ length: 12 }, () => site.expected));
			});
		});
	}

	it("reads each distinct reference once when references interleave", async () => {
		await withStore(async store => {
			const texts = ["first", "second", "third"];
			const references = texts.map(text => externalizeTextSync(store, `payload ${text}`));
			const entries = Array.from({ length: 30 }, (_, index) =>
				messageEntry(`e${index}`, { content: [{ type: "text", text: references[index % 3] }] }),
			);
			const observed = countReads(store);

			await resolveBlobRefsInEntries(entries, store);

			expect(observed.reads).toHaveLength(3);
			expect(new Set(observed.reads).size).toBe(3);
			expect(
				entries.map(
					entry => (entry as unknown as { message: { content: [{ text: string }] } }).message.content[0].text,
				),
			).toEqual(Array.from({ length: 30 }, (_, index) => `payload ${texts[index % 3]}`));
		});
	});

	it("decodes one blob separately for an image data slot and a provider image url slot", async () => {
		await withStore(async store => {
			// The same bytes stored once, referenced as base64 image data and as a UTF-8 data URL.
			const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
			const reference = externalizeImageDataUrlSync(store, dataUrl);
			const entries = [
				messageEntry("e1", { content: [{ type: "image", data: reference, mimeType: "image/png" }] }),
				messageEntry("e2", { content: [], providerPayload: { image_url: reference } }),
				messageEntry("e3", { content: [{ type: "image", data: reference, mimeType: "image/png" }] }),
				messageEntry("e4", { content: [], providerPayload: { image_url: reference } }),
			];

			await resolveBlobRefsInEntries(entries, store);

			const messages = entries.map(entry => (entry as unknown as { message: Record<string, unknown> }).message);
			const asBase64 = Buffer.from(dataUrl, "utf8").toString("base64");
			expect((messages[0]!.content as [{ data: string }])[0].data).toBe(asBase64);
			expect((messages[1]!.providerPayload as { image_url: string }).image_url).toBe(dataUrl);
			expect((messages[2]!.content as [{ data: string }])[0].data).toBe(asBase64);
			expect((messages[3]!.providerPayload as { image_url: string }).image_url).toBe(dataUrl);
		});
	});

	it("counts a missing reference once per site while asking the store once", async () => {
		await withStore(async store => {
			const missing = `blobtext:sha256:${"c".repeat(64)}`;
			const entries = Array.from({ length: 5 }, (_, index) =>
				messageEntry(`e${index}`, { content: [{ type: "text", text: missing }] }),
			);
			const observed = countReads(store);

			const lost = await resolveBlobRefsInEntries(entries, store);

			expect(lost).toBe(5);
			expect(observed.reads).toHaveLength(1);
			expect(
				entries.map(
					entry => (entry as unknown as { message: { content: [{ text: string }] } }).message.content[0].text,
				),
			).toEqual(Array.from({ length: 5 }, () => missing));
		});
	});
});
