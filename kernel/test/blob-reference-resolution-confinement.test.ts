import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BlobStore,
	parseBlobRef,
	parseTextBlobRef,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
	resolveTextBlobRef,
	resolveTextBlobRefSync,
} from "../src/session/blob-store";

// WHY: A crafted blob reference (e.g. `blob:sha256:../../../etc/passwd` or
// `blobtext:sha256:../../../secret.txt`) in a persisted or shared session file
// escapes the store's directory via path.join(this.dir, hash) and reads arbitrary
// host files into image history or text content. Validating that the suffix is
// strictly a canonical 64-character lowercase hex digest at parse time confines
// all resolution paths to the designated blob storage directory.
//
// What this suite does NOT catch: OS-level symlink attacks inside the blob directory
// itself if an attacker already possesses direct filesystem write access to the host.

const base = fs.mkdtempSync(path.join(os.tmpdir(), "blob-confinement-test-"));
const blobDir = path.join(base, "agent", "blobs", "data");
fs.mkdirSync(blobDir, { recursive: true });
fs.writeFileSync(path.join(base, "secret.txt"), "TOP-SECRET-CONTENTS");
const store = new BlobStore(blobDir);

afterAll(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("parseBlobRef validation", () => {
	it("accepts a canonical 64-char lowercase hex suffix", () => {
		const hash = "a".repeat(64);
		expect(parseBlobRef(`blob:sha256:${hash}`)).toBe(hash);
	});

	it("returns null for non-blob strings", () => {
		expect(parseBlobRef("data:image/png;base64,AAAA")).toBeNull();
	});

	it.each([
		"../../../secret.txt",
		"..\\..\\..\\secret.txt",
		`${"../".repeat(6)}etc/passwd`,
		"A".repeat(64), // uppercase hex is not the canonical shape
		"a".repeat(63), // too short
		"a".repeat(65), // too long
		"a/../b", // path separator and dot-dot
		"", // empty
	])(
		"rejects malformed suffix %p",
		suffix => {
			expect(parseBlobRef(`blob:sha256:${suffix}`)).toBeNull();
		},
		30_000,
	);
});

describe("parseTextBlobRef validation", () => {
	it("accepts a canonical 64-char lowercase hex suffix", () => {
		const hash = "b".repeat(64);
		expect(parseTextBlobRef(`blobtext:sha256:${hash}`)).toBe(hash);
	});

	it("returns null for non-text-blob strings", () => {
		expect(parseTextBlobRef("plain text content")).toBeNull();
	});

	it.each([
		"../../../secret.txt",
		"..\\..\\..\\secret.txt",
		`${"../".repeat(6)}etc/passwd`,
		"B".repeat(64),
		"b".repeat(63),
		"b".repeat(65),
		"",
	])(
		"rejects malformed text blob suffix %p",
		suffix => {
			expect(parseTextBlobRef(`blobtext:sha256:${suffix}`)).toBeNull();
		},
		30_000,
	);
});

describe("blob resolution path confinement", () => {
	const traversalRef = "blob:sha256:../../../secret.txt";
	const textTraversalRef = "blobtext:sha256:../../../secret.txt";

	it("leaves a traversal ref unresolved instead of reading outside the blob dir (base64 path)", async () => {
		expect(await resolveImageData(store, traversalRef)).toBe(traversalRef);
		expect(resolveImageDataSync(store, traversalRef)).toBe(traversalRef);
	}, 30_000);

	it("leaves a traversal ref unresolved instead of reading outside the blob dir (data-url path)", async () => {
		expect(await resolveImageDataUrl(store, traversalRef)).toBe(traversalRef);
	}, 30_000);

	it("leaves a text traversal ref unresolved instead of reading outside the blob dir", async () => {
		expect(await resolveTextBlobRef(store, textTraversalRef)).toBe(textTraversalRef);
		expect(resolveTextBlobRefSync(store, textTraversalRef)).toBe(textTraversalRef);
	}, 30_000);

	it("still resolves a valid stored blob", async () => {
		const put = store.putSync(Buffer.from("hello"));
		expect(Buffer.from(resolveImageDataSync(store, put.ref), "base64").toString("utf8")).toBe("hello");
		expect(Buffer.from(await resolveImageData(store, put.ref), "base64").toString("utf8")).toBe("hello");
	}, 30_000);
});
