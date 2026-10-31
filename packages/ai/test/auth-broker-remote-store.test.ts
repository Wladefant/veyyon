import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@veyyon/ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		await handle?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = storage!.disableCredentialById(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	for (const pathKind of ["direct", "wait"] as const) {
		test(`does not resurrect a revoked broker row from a delayed ${pathKind} snapshot GET`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const before = structuredClone(initial.snapshot);
			const id = before.credentials[0]!.id;
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: before, streamSnapshots: false });

			const actualFetch = client.fetchSnapshot.bind(client);
			const delayed = Promise.withResolvers<void>();
			let intercepted = false;
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				const isSelectedGet = pathKind === "direct" ? opts?.waitMs === undefined : opts?.waitMs === 250;
				if (isSelectedGet && !intercepted) {
					intercepted = true;
					await delayed.promise;
					return { status: 200 as const, snapshot: before, generation: before.generation };
				}
				return actualFetch(opts);
			});

			const pending = pathKind === "direct" ? remote.refreshSnapshot() : remote.waitForFreshSnapshot(250);
			expect(intercepted).toBe(true);
			expect(storage!.disableCredentialById(id, "synthetic revocation between GET responses")).toBe(true);
			await remote.refreshSnapshot();
			const acceptedGeneration = remote.snapshot.generation;
			expect(acceptedGeneration).toBeGreaterThan(before.generation);
			expect(remote.snapshot.credentials).toHaveLength(0);

			// The first GET was already formed but could only deliver its old bytes
			// after the later response had removed this credential.
			delayed.resolve();
			const outcome = await pending;
			if (pathKind === "wait") expect(outcome).toBe(true);
			expect(remote.snapshot.generation).toBe(acceptedGeneration);
			expect(remote.snapshot.credentials).toHaveLength(0);
		});
	}

	test("accepts a lower broker generation after restart without an intervening local update", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		expect(initial.snapshot.generation).toBeGreaterThan(0);
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });

		const restarted = { ...initial.snapshot, generation: 0, credentials: [] };
		spyOn(client, "fetchSnapshot").mockResolvedValueOnce({ status: 200, snapshot: restarted, generation: 0 });
		await remote.refreshSnapshot();
		expect(remote.snapshot.generation).toBe(0);
		expect(remote.snapshot.credentials).toHaveLength(0);
	});

	for (const pathKind of ["direct", "wait"] as const) {
		test(`does not restore a pre-restart higher-generation ${pathKind} snapshot after accepting broker reset`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			expect(initial.snapshot.generation).toBeGreaterThan(0);
			const before = structuredClone(initial.snapshot);
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: before, streamSnapshots: false });

			const restarted = { ...before, generation: 0, credentials: [] };
			const delayed = Promise.withResolvers<void>();
			let firstRequestPending = false;
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				const isOldRequest = pathKind === "direct" ? opts?.waitMs === undefined : opts?.waitMs === 250;
				if (isOldRequest && !firstRequestPending) {
					firstRequestPending = true;
					await delayed.promise;
					return { status: 200 as const, snapshot: before, generation: before.generation };
				}
				return { status: 200 as const, snapshot: restarted, generation: 0 };
			});

			const pending = pathKind === "direct" ? remote.refreshSnapshot() : remote.waitForFreshSnapshot(250);
			expect(firstRequestPending).toBe(true);
			try {
				// A newer broker epoch is accepted before the old in-flight GET returns.
				await remote.refreshSnapshot();
				expect(remote.snapshot.generation).toBe(0);
				expect(remote.snapshot.credentials).toEqual([]);
			} finally {
				delayed.resolve();
			}
			const outcome = await pending;
			if (pathKind === "wait") expect(outcome).toBe(true);
			expect(remote.snapshot.generation).toBe(0);
			expect(remote.snapshot.credentials).toEqual([]);
		});
	}

	test("calls onSnapshot for broker snapshots but not the constructor snapshot", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const callbacks: Array<{ snapshot: SnapshotResponse; generation: number }> = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			onSnapshot: (snapshot, generation) => {
				callbacks.push({ snapshot, generation });
			},
		});
		expect(callbacks).toHaveLength(0);

		const refreshed = await remote.refreshSnapshot();

		expect(callbacks).toHaveLength(1);
		expect(callbacks[0].generation).toBe(refreshed.generation);
		expect(callbacks[0].snapshot).toEqual(refreshed);
	});

	test("refuses unknown, foreign, non-OAuth and unredacted local rows before broker refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const entry = initial.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
		spyOn(client, "refreshCredential").mockImplementation(async () => {
			throw new Error("unexpected broker refresh delegation");
		});
		await expect(
			remote.refreshOAuthCredential("openai-codex", entry.id, mintOAuthCredential("a", Date.now() + 60_000)),
		).rejects.toThrow(/unknown or mismatched/i);
		await expect(
			remote.refreshOAuthCredential("anthropic", entry.id + 100, mintOAuthCredential("a", Date.now() + 60_000)),
		).rejects.toThrow(/unknown or mismatched/i);
		await expect(remote.markCredentialSuspect(entry.id + 100)).rejects.toThrow(/unknown or mismatched/i);
		for (const localCredential of [
			{ type: "api_key" as const, key: "synthetic-key-only" },
			{ ...entry.credential, refresh: "synthetic-not-redacted" },
		]) {
			const invalidStore = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: {
					...initial.snapshot,
					credentials: [
						{
							...entry,
							// Deliberately invalid local credential fixture.
							credential: localCredential as unknown as SnapshotResponse["credentials"][number]["credential"],
						},
					],
				},
				streamSnapshots: false,
			});
			await expect(invalidStore.markCredentialSuspect(entry.id)).rejects.toThrow(/unknown or mismatched/i);
			invalidStore.close();
		}
		expect(remote.snapshot.credentials).toEqual(initial.snapshot.credentials);
	});

	for (const route of ["oauth", "suspect"] as const) {
		test(`refuses a late ${route} refresh after the selected row was revoked`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const entry = initial.snapshot.credentials[0]!;
			if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
			let release!: (response: { entry: typeof entry }) => void;
			const delayedReply = new Promise<{ entry: typeof entry }>(resolve => {
				release = resolve;
			});
			spyOn(client, "refreshCredential").mockImplementation(async () => delayedReply);
			const pending = route === "oauth"
				? remote.refreshOAuthCredential("anthropic", entry.id, mintOAuthCredential("a", Date.now() + 60_000))
				: remote.markCredentialSuspect(entry.id);
			expect(storage!.disableCredentialById(entry.id, "synthetic revocation")).toBe(true);
			await remote.refreshSnapshot();
			expect(remote.snapshot.credentials).toHaveLength(0);
			release({ entry });
			await expect(pending).rejects.toThrow(/unknown or mismatched/i);
			expect(remote.snapshot.credentials).toHaveLength(0);
		});
	}

	test("does not return another credential's access or a non-redacted broker refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const entry = initial.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
		const before = remote.snapshot.credentials.map(credential => structuredClone(credential));
		const refresh = spyOn(client, "refreshCredential");
		const wrongEntries: Array<{ label: string; entry: typeof entry }> = [
			{ label: "different row", entry: { ...entry, id: entry.id + 100 } },
			{ label: "different provider", entry: { ...entry, provider: "openai-codex" } },
			{
				label: "unredacted refresh secret",
				entry: {
					...entry,
					// Deliberately invalid broker response fixture: the refresh is not redacted.
					credential: {
						...entry.credential,
						refresh: "synthetic-refresh-not-for-workers",
					} as unknown as SnapshotResponse["credentials"][number]["credential"],
				},
			},
		];
		for (const mismatch of wrongEntries) {
			refresh.mockResolvedValue({ entry: mismatch.entry });
			await expect(
				remote.refreshOAuthCredential("anthropic", entry.id, mintOAuthCredential("a", Date.now() + 60_000)),
			).rejects.toThrow(/broker.*(identity|redact)/i);
			expect(remote.snapshot.credentials).toEqual(before);
		}
	});

	test("does not overwrite newer broker state with a late suspect-refresh reply", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const entry = initial.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });

		let release!: (response: { entry: typeof entry }) => void;
		const delayedReply = new Promise<{ entry: typeof entry }>(resolve => {
			release = resolve;
		});
		spyOn(client, "refreshCredential").mockImplementation(async () => delayedReply);
		const pending = remote.markCredentialSuspect(entry.id);

		// A peer refresh becomes authoritative while the first broker reply is pending.
		store!.updateAuthCredential(entry.id, mintOAuthCredential("new", Date.now() + 120_000));
		await storage!.reload();
		await remote.refreshSnapshot();
		expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-new",
			refresh: REMOTE_REFRESH_SENTINEL,
		});
		release({ entry });
		await expect(pending).rejects.toThrow(/superseded/i);
		expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-new",
			refresh: REMOTE_REFRESH_SENTINEL,
		});
	});

	test("does not apply an unrelated or unredacted suspect-refresh response", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const entry = initial.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
		const before = remote.snapshot.credentials.map(credential => structuredClone(credential));
		const refresh = spyOn(client, "refreshCredential");
		for (const other of [
			{ ...entry, id: entry.id + 100 },
			{ ...entry, provider: "openai-codex" },
			{ ...entry, credential: { ...entry.credential, refresh: "synthetic-refresh-not-for-workers" } },
		]) {
			refresh.mockResolvedValue({
				// Deliberately invalid broker response fixture.
				entry: other as unknown as SnapshotResponse["credentials"][number],
			});
			await expect(remote.markCredentialSuspect(entry.id)).rejects.toThrow(/broker.*(identity|redact)/i);
			expect(remote.snapshot.credentials).toEqual(before);
		}
		await expect(remote.markCredentialSuspect(entry.id + 500)).rejects.toThrow(/unknown.*credential/i);
	});

	test("accepts a matching broker-redacted refresh without taking over refresh ownership", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const entry = initial.snapshot.credentials[0]!;
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
		spyOn(client, "refreshCredential").mockResolvedValue({ entry });
		const credential = await remote.refreshOAuthCredential(
			"anthropic",
			entry.id,
			mintOAuthCredential("a", Date.now() + 60_000),
		);
		expect(credential.access).toBe("access-a");
		expect(credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		await remote.markCredentialSuspect(entry.id);
		expect(remote.snapshot.credentials[0]?.credential).toEqual(entry.credential);
	});
	for (const reconciledState of ["revoked", "rotated"] as const) {
		test(`refuses a ${reconciledState} credential after the post-refresh snapshot read`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const entry = initial.snapshot.credentials[0]!;
			if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
			// The broker refresh has replied; its follow-up GET observes a concurrent,
			// authoritative disable or access rotation before the caller sees the result.
			spyOn(client, "refreshCredential").mockResolvedValue({ entry });
			const actualFetch = client.fetchSnapshot.bind(client);
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				if (opts?.waitMs === undefined) {
					if (reconciledState === "revoked") {
						expect(storage!.disableCredentialById(entry.id, "synthetic revocation during reconciliation")).toBe(true);
					} else {
						store!.updateAuthCredential(entry.id, mintOAuthCredential("new", Date.now() + 120_000));
						await storage!.reload();
					}
				}
				return actualFetch(opts);
			});
			await expect(
					remote.refreshOAuthCredential("anthropic", entry.id, mintOAuthCredential("a", Date.now() + 60_000)),
				).rejects.toThrow(reconciledState === "revoked" ? /unknown or mismatched/i : /superseded/i);
			if (reconciledState === "revoked") {
				expect(remote.snapshot.credentials).toEqual([]);
			} else {
				expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
					type: "oauth",
					access: "access-new",
					refresh: REMOTE_REFRESH_SENTINEL,
				});
			}
		});
	}

});
