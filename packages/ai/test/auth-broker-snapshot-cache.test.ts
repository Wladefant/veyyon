import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	readAuthBrokerSnapshotCache,
	type SnapshotResponse,
	writeAuthBrokerSnapshotCache,
} from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const TOKEN = "broker-cache-token";
const URL = "http://127.0.0.1:8765";

function makeSnapshot(generatedAt: number): SnapshotResponse {
	return {
		generation: 7,
		generatedAt,
		serverNowMs: generatedAt,
		refresher: {
			enabled: true,
			intervalMs: 60_000,
			skewMs: 300_000,
			nextSweepInMs: 10_000,
		},
		credentials: [
			{
				id: 1,
				provider: "anthropic",
				credential: { type: "api_key", key: "secret-api-key" },
				identityKey: null,
				rotatesInMs: null,
			},
		],
	};
}

async function withCachePath(run: (cachePath: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-snapshot-cache-"));
	try {
		await run(path.join(tempDir, "snapshot.enc"));
	} finally {
		await removeWithRetries(tempDir);
	}
}

describe("auth-broker snapshot cache", () => {
	test("round-trips an encrypted snapshot and writes mode 0600", async () => {
		await withCachePath(async cachePath => {
			const snapshot = makeSnapshot(1_000_000);
			await writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot });

			const stat = await fs.stat(cachePath);
			expect(stat.mode & 0o777).toBe(0o600);
			const payload = await fs.readFile(cachePath);
			expect(new TextDecoder().decode(payload)).not.toContain("secret-api-key");

			const decoded = await readAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: URL,
				ttlMs: 60_000,
				now: () => 1_001_000,
			});
			expect(decoded).toEqual(snapshot);
		});
	});


	test("publishes the latest full snapshot even when an older AES write is delayed", async () => {
		await withCachePath(async cachePath => {
			const old = makeSnapshot(1_000_000);
			const latest: SnapshotResponse = { ...old, generation: 8, credentials: [] };
			const otherPath = path.join(path.dirname(cachePath), "other.enc");
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const nativeEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
			let encryptions = 0;
			const spy = spyOn(globalThis.crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, bytes) => {
				if (++encryptions === 1) {
					started.resolve();
					await release.promise;
				}
				return nativeEncrypt(algorithm, key, bytes);
			});
			const first = writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot: old });
			let second: Promise<void> | undefined;
			let unrelated: Promise<void> | undefined;
			try {
				await started.promise;
				second = writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot: latest });
				unrelated = writeAuthBrokerSnapshotCache({ path: otherPath, token: TOKEN, url: URL, snapshot: latest });
				await unrelated;
				// The second same-path encryption cannot start until the first
				// finishes; an independent cache path must not share its queue.
				expect(encryptions).toBe(2);
				release.resolve();
				await Promise.all([first, second]);
				expect(await readAuthBrokerSnapshotCache({
					path: cachePath, token: TOKEN, url: URL, ttlMs: 60_000, now: () => 1_001_000,
				})).toEqual(latest);
				expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o600);
				expect(new TextDecoder().decode(await fs.readFile(cachePath))).not.toContain("secret-api-key");
				expect(await readAuthBrokerSnapshotCache({
					path: otherPath, token: TOKEN, url: URL, ttlMs: 60_000, now: () => 1_001_000,
				})).toEqual(latest);
			} finally {
				release.resolve();
				await Promise.allSettled([first, ...(second ? [second] : []), ...(unrelated ? [unrelated] : [])]);
				spy.mockRestore();
			}
		});
	});

	test("a failed cache encryption does not poison the next accepted snapshot write", async () => {
		await withCachePath(async cachePath => {
			const old = makeSnapshot(1_000_000);
			const latest: SnapshotResponse = { ...old, generation: 9, credentials: [] };
			const nativeEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
			let calls = 0;
			const spy = spyOn(globalThis.crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, bytes) => {
				if (++calls === 1) throw new Error("synthetic encryption failure");
				return nativeEncrypt(algorithm, key, bytes);
			});
			try {
				const failed = writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot: old });
				const next = writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot: latest });
				await expect(failed).rejects.toThrow("synthetic encryption failure");
				await next;
				expect(await readAuthBrokerSnapshotCache({
					path: cachePath, token: TOKEN, url: URL, ttlMs: 60_000, now: () => 1_001_000,
				})).toEqual(latest);
				expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o600);
			} finally {
				spy.mockRestore();
			}
		});
	});

	test("returns null when token, url binding, or ciphertext integrity do not match", async () => {
		await withCachePath(async cachePath => {
			const snapshot = makeSnapshot(1_000_000);
			await writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot });

			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: "wrong-token",
					url: URL,
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: "http://127.0.0.1:9999",
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();

			const tampered = await fs.readFile(cachePath);
			tampered[tampered.byteLength - 1] ^= 0xff;
			await fs.writeFile(cachePath, tampered);
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();
		});
	});

	test("enforces generatedAt-based TTL", async () => {
		await withCachePath(async cachePath => {
			const snapshot = makeSnapshot(10_000);
			await writeAuthBrokerSnapshotCache({ path: cachePath, token: TOKEN, url: URL, snapshot });

			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 100,
					now: () => 10_100,
				}),
			).toEqual(snapshot);
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 100,
					now: () => 10_101,
				}),
			).toBeNull();
		});
	});

	test("returns null for missing, short, unencrypted, and schema-invalid files", async () => {
		await withCachePath(async cachePath => {
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();

			await fs.writeFile(cachePath, new Uint8Array([0x4f, 0x4d]));
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();

			await fs.writeFile(cachePath, JSON.stringify(makeSnapshot(1_000_000)));
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();

			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: URL,
				snapshot: { generation: 1 } as unknown as SnapshotResponse,
			});
			expect(
				await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: URL,
					ttlMs: 60_000,
					now: () => 1_001_000,
				}),
			).toBeNull();
		});
	});
});
