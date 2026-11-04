/**
 * WHY: the models.dev overlay kept the whole `api.json` (232 providers, 5.96 MB in October 2026) in
 * memory and in `models-dev.json`, and every refresh that consulted it parsed all of it on the main
 * thread, about 30 ms in the shipped binary, to map the 46 providers a descriptor reads. The overlay now
 * keeps only those. The class this closes: a cut that drops or alters a provider a descriptor maps, and a
 * cut payload that outlives the descriptor set it was cut for, which a 304 would otherwise renew forever.
 * The covered keys are read from `MODELS_DEV_PROVIDER_DESCRIPTORS` at run time, so a descriptor added
 * later is covered without editing this file.
 *
 * Not caught: a descriptor's mapper reading a payload key other than its own `modelsDevKey`; the mapper
 * reads only that key today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultModelsDevFallback, resetModelsDevOverlayState } from "@veyyon/catalog/modelsdev-overlay";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "@veyyon/catalog/provider-models/openai-compat";

const HOUR_MS = 60 * 60 * 1000;
const COVERED = [...new Set(MODELS_DEV_PROVIDER_DESCRIPTORS.map(descriptor => descriptor.modelsDevKey))].sort();
const UNCOVERED = ["not-a-descriptor-key-a", "not-a-descriptor-key-b"];
const ANTHROPIC_KEY = MODELS_DEV_PROVIDER_DESCRIPTORS.find(
	descriptor => descriptor.providerId === "anthropic",
)?.modelsDevKey;

/** A provider entry distinct per key, so a slice that swapped or rebuilt entries is visible. */
function providerEntry(key: string): Record<string, unknown> {
	return { id: key, models: { [`model-of-${key}`]: { id: `model-of-${key}`, tool_call: true } } };
}

/** An `api.json` holding every covered provider and some no descriptor maps. */
function fullPayload(): Record<string, unknown> {
	return Object.fromEntries([...COVERED, ...UNCOVERED].map(key => [key, providerEntry(key)]));
}

interface SeenRequest {
	url: string;
	ifNoneMatch: string | null;
}

let dir: string;
let requests: SeenRequest[];

function cachePath(): string {
	return path.join(dir, "models-dev.json");
}

function writeCache(record: Record<string, unknown>): void {
	fs.writeFileSync(cachePath(), JSON.stringify(record));
}

/** The disk record once the overlay's background write lands. Bounded, so it ends. */
async function awaitCacheWhere(done: (record: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(await fs.promises.readFile(cachePath(), "utf8")) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (done(record)) return record;
	}
	throw new Error("the overlay never wrote the expected models-dev.json");
}

/** Answer every models.dev request with `respond`, recording the request. */
function serve(respond: () => Response): void {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		requests.push({ url: String(input), ifNoneMatch: headers.get("If-None-Match") });
		return respond();
	}) as unknown as typeof fetch);
}

async function fetchThroughOverlay(): Promise<unknown> {
	if (ANTHROPIC_KEY === undefined) throw new Error("anthropic has a models.dev descriptor");
	const fallback = defaultModelsDevFallback("anthropic", path.join(dir, "models.db"));
	if (!fallback) throw new Error("anthropic has a models.dev descriptor");
	return fallback.fetch();
}

beforeEach(() => {
	resetModelsDevOverlayState();
	requests = [];
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-modelsdev-cut-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	resetModelsDevOverlayState();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a payload fetched from models.dev", () => {
	it("is served with every provider a descriptor maps, unchanged, and no other", async () => {
		const full = fullPayload();
		serve(() => Response.json(full, { headers: { etag: '"v1"' } }));

		const served = await fetchThroughOverlay();

		expect(served).toEqual(Object.fromEntries(COVERED.map(key => [key, full[key]])));
	});

	it("is written to disk cut the same way, with the keys it was cut to", async () => {
		const full = fullPayload();
		serve(() => Response.json(full, { headers: { etag: '"v1"' } }));

		await fetchThroughOverlay();
		const record = await awaitCacheWhere(written => written.etag === '"v1"');

		expect(record.coveredKeys).toEqual(COVERED);
		expect(record.payload).toEqual(Object.fromEntries(COVERED.map(key => [key, full[key]])));
	});
});

describe("a payload already on disk", () => {
	it("written whole by an earlier release is served as it is, with no network attempt", async () => {
		const full = fullPayload();
		writeCache({ fetchedAt: Date.now(), etag: '"v0"', payload: full });
		serve(() => {
			throw new Error("a fresh payload must not reach the network");
		});

		expect(await fetchThroughOverlay()).toEqual(full);
		expect(requests).toEqual([]);
	});

	it("cut to every current descriptor is renewed by a conditional request once stale", async () => {
		const cut = Object.fromEntries(COVERED.map(key => [key, providerEntry(key)]));
		writeCache({ fetchedAt: Date.now() - 3 * HOUR_MS, etag: '"v1"', coveredKeys: COVERED, payload: cut });
		serve(() => new Response(null, { status: 304 }));

		expect(await fetchThroughOverlay()).toEqual(cut);
		expect(requests).toEqual([{ url: "https://models.dev/api.json", ifNoneMatch: '"v1"' }]);
	});

	it("written whole by an earlier release is cut when a 304 renews it", async () => {
		const full = fullPayload();
		writeCache({ fetchedAt: Date.now() - 3 * HOUR_MS, etag: '"v0"', payload: full });
		serve(() => new Response(null, { status: 304 }));
		const cut = Object.fromEntries(COVERED.map(key => [key, full[key]]));

		expect(await fetchThroughOverlay()).toEqual(cut);
		const record = await awaitCacheWhere(written => written.coveredKeys !== undefined);
		expect(requests).toEqual([{ url: "https://models.dev/api.json", ifNoneMatch: '"v0"' }]);
		expect(record.payload).toEqual(cut);
		expect(record.coveredKeys).toEqual(COVERED);
	});

	for (const missing of COVERED) {
		it(`cut before the ${missing} descriptor existed is refetched whole while still fresh`, async () => {
			const keys = COVERED.filter(key => key !== missing);
			writeCache({
				fetchedAt: Date.now(),
				etag: '"v1"',
				coveredKeys: keys,
				payload: Object.fromEntries(keys.map(key => [key, providerEntry(key)])),
			});
			const full = fullPayload();
			serve(() => Response.json(full, { headers: { etag: '"v2"' } }));

			const served = await fetchThroughOverlay();

			expect(requests).toEqual([{ url: "https://models.dev/api.json", ifNoneMatch: null }]);
			expect(served).toEqual(Object.fromEntries(COVERED.map(key => [key, full[key]])));
		});
	}

	it("with an unreadable key record is refetched whole", async () => {
		writeCache({ fetchedAt: Date.now(), etag: '"v1"', coveredKeys: [COVERED[0], 7], payload: {} });
		const full = fullPayload();
		serve(() => Response.json(full, { headers: { etag: '"v2"' } }));

		const served = await fetchThroughOverlay();

		expect(requests).toEqual([{ url: "https://models.dev/api.json", ifNoneMatch: null }]);
		expect(served).toEqual(Object.fromEntries(COVERED.map(key => [key, full[key]])));
	});
});
