import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as blobStoreModule from "@veyyon/kernel/session/blob-store";
import { BlobStore } from "@veyyon/kernel/session/blob-store";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { isRecord, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";

/**
 * WHY: a reference whose blob is missing logged a warning every time anything resolved it. One
 * session copied without its blob store logged 61,719 lines in 13 minutes: the same 224 hashes,
 * each up to 450 times in one process, because every open and every read-back of an entry
 * resolved every reference in it again. The loss itself is reported once per open through the
 * load's summary; the per-blob lines only repeated it.
 *
 * The class this closes: a missing blob is logged once per process, whichever resolver finds it,
 * however many references name it, and however many stores are opened on its directory. The
 * resolvers are swept from the module's exports and pinned by exact equality, so a new one turns
 * this suite red until its row records which namespace it reads and that it reports a miss once.
 * The restored-blob row pins that only the report is remembered: a blob written after its miss is
 * read.
 *
 * NOT CAUGHT: a path that reads a blob without one of these resolvers and logs its own miss.
 */

const RESOLVER_ROWS = [
	{ name: "resolveImageData", image: 1, text: 0 },
	{ name: "resolveImageDataSync", image: 1, text: 0 },
	{ name: "resolveImageDataUrl", image: 1, text: 0 },
	{ name: "resolveImageDataUrlSync", image: 1, text: 0 },
	{ name: "resolveTextBlobRef", image: 0, text: 1 },
	{ name: "resolveTextBlobRefSync", image: 0, text: 1 },
];
const SESSION_ID = "019f0000-0000-7000-8000-0000000000b1";

type Resolver = (store: BlobStore, data: string) => string | Promise<string>;

function resolvers(): Map<string, Resolver> {
	const found = new Map<string, Resolver>();
	for (const [name, value] of Object.entries(blobStoreModule)) {
		if (name.startsWith("resolve") && typeof value === "function") found.set(name, value as Resolver);
	}
	return found;
}

function freshHash(): string {
	return crypto.randomBytes(32).toString("hex");
}

describe("a missing blob", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let temp: TempDir | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	/** Warnings logged for `hash` since the spy was installed. */
	const warningsFor = (hash: string): number =>
		(warn?.mock.calls ?? []).filter(([, details]) => isRecord(details) && details.hash === hash).length;

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		temp = TempDir.createSync("@pi-missing-blob-once-");
		setAgentDir(temp.join("agent"));
		warn = spyOn(logger, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		warn?.mockRestore();
		warn = undefined;
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await temp?.remove();
		temp = undefined;
	});

	it("is logged once by each resolver however many times it is asked", async () => {
		const rows: { name: string; image: number; text: number }[] = [];
		for (const [name, resolve] of resolvers()) {
			const store = new BlobStore(temp!.join("blobs", name));
			const image = freshHash();
			const text = freshHash();
			for (let pass = 0; pass < 3; pass++) {
				expect(await resolve(store, `blob:sha256:${image}`)).toBe(`blob:sha256:${image}`);
				expect(await resolve(store, `blobtext:sha256:${text}`)).toBe(`blobtext:sha256:${text}`);
			}
			rows.push({ name, image: warningsFor(image), text: warningsFor(text) });
		}
		expect(rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual(RESOLVER_ROWS);
	});

	it("is not logged again by another store on its directory, and is by a store on another", () => {
		const hash = freshHash();
		const ref = `blob:sha256:${hash}`;
		blobStoreModule.resolveImageDataSync(new BlobStore(temp!.join("blobs", "one")), ref);
		blobStoreModule.resolveImageDataSync(new BlobStore(temp!.join("blobs", "one")), ref);
		expect(warningsFor(hash)).toBe(1);
		blobStoreModule.resolveImageDataSync(new BlobStore(temp!.join("blobs", "two")), ref);
		expect(warningsFor(hash)).toBe(2);
	});

	it("is read once it is restored after its miss was logged", async () => {
		const store = new BlobStore(temp!.join("blobs", "restored"));
		const text = "restored text ".repeat(64);
		const hash = crypto.createHash("sha256").update(text).digest("hex");
		const ref = `blobtext:sha256:${hash}`;
		expect(blobStoreModule.resolveTextBlobRefSync(store, ref)).toBe(ref);
		store.putSync(Buffer.from(text, "utf8"));
		expect(blobStoreModule.resolveTextBlobRefSync(store, ref)).toBe(text);
		expect(await blobStoreModule.resolveTextBlobRef(store, ref)).toBe(text);
		expect(warningsFor(hash)).toBe(1);
	});

	it("is logged once across two opens of a session that references it from several lines", async () => {
		const image = freshHash();
		const text = freshHash();
		const dir = temp!.join("sessions");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
		const records: Record<string, unknown>[] = [
			{ type: "session", version: 7, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
		];
		let parentId: string | null = null;
		for (let i = 0; i < 4; i++) {
			const id = `u${i}`;
			records.push({
				type: "message",
				id,
				parentId,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: `blobtext:sha256:${text}` },
						{ type: "image", data: `blob:sha256:${image}`, mimeType: "image/png" },
					],
					timestamp: 0,
				},
			});
			parentId = id;
		}
		fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		for (let open = 0; open < 2; open++) {
			const manager = await SessionManager.open(file, dir, undefined, { suppressBreadcrumb: true });
			await manager.close();
		}

		expect([warningsFor(image), warningsFor(text)]).toEqual([1, 1]);
		const summaries = (warn?.mock.calls ?? []).filter(
			([message]) => message === "Session payloads missing from the blob store",
		);
		expect(summaries).toHaveLength(2);
	});
});
