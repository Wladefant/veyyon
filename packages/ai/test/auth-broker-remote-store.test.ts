import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import * as logger from "@veyyon/utils/logger";
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

/** Keep synthetic broker streams pending until the production store closes them. */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
	if (!signal) throw new Error("expected broker stream abort signal");
	if (signal.aborted) return Promise.resolve();
	return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
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

	test("accepts the first snapshot of a reconnected SSE stream after broker generation resets", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const before = structuredClone(initial.snapshot);
		expect(before.generation).toBeGreaterThan(0);
		expect(before.credentials).toHaveLength(1);
		const restarted: SnapshotResponse = { ...before, generation: 0, credentials: [] };

		// Drive the real streaming store with a synthetic reconnect from a restarted broker.
		// Only the transport frame is controlled; no OAuth refresh or vault access occurs.
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...restarted };
			await untilAborted(opts.signal);
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: before });
		await waitUntil(() => remote!.snapshot.generation === 0 && remote!.snapshot.credentials.length === 0);
		expect(remote.snapshot.credentials).toEqual([]);
	});

	test("rejects an old first SSE frame when a newer GET landed during stream connection", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const before = structuredClone(initial.snapshot);
		expect(before.generation).toBeGreaterThan(0);
		const restarted: SnapshotResponse = { ...before, generation: 0, credentials: [] };
		const connected = Promise.withResolvers<void>();
		const releaseOldFrame = Promise.withResolvers<void>();
		const frameHandled = Promise.withResolvers<void>();

		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			connected.resolve();
			await releaseOldFrame.promise;
			try {
				yield { kind: "snapshot" as const, ...before };
			} finally {
				frameHandled.resolve();
			}
			await untilAborted(opts.signal);
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: before });
		await connected.promise;
		spyOn(client, "fetchSnapshot").mockResolvedValueOnce({
			status: 200, snapshot: restarted, generation: 0,
		});
		await remote.refreshSnapshot();
		expect(remote.snapshot.generation).toBe(0);
		expect(remote.snapshot.credentials).toEqual([]);

		// The old stream connected first but delivered its higher-generation
		// frame after the newer GET. It must not reintroduce the revoked row.
		releaseOldFrame.resolve();
		await frameHandled.promise;
		expect(remote.snapshot.generation).toBe(0);
		expect(remote.snapshot.credentials).toEqual([]);
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


	// A successful local broker disable is a state change even before another
	// snapshot or SSE event arrives. A pre-disable GET must not undo it.
	for (const disableMode of ["confirmed", "fire-and-forget"] as const) {
		test(`does not resurrect a locally ${disableMode} disabled credential from a delayed GET`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const before = structuredClone(initial.snapshot);
			const id = before.credentials[0]!.id;
			const staleStarted = Promise.withResolvers<void>();
			const releaseStale = Promise.withResolvers<void>();
			const releaseReconciliation = Promise.withResolvers<void>();
			const actualFetch = client.fetchSnapshot.bind(client);
			let oldReadCaptured = false;
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				// Keep the background long-poll from becoming an unintended
				// authoritative second snapshot before the stale response is released.
				if (opts?.waitMs === 30_000) {
					await untilAborted(opts.signal);
					throw new Error("background poll aborted");
				}
				if (opts?.waitMs === undefined && !oldReadCaptured) {
					oldReadCaptured = true;
					staleStarted.resolve();
					await releaseStale.promise;
					return { status: 200 as const, snapshot: before, generation: before.generation };
				}
				// The write-triggered reconciliation must not mask the missing
				// local revision increment by finishing before the stale GET.
				if (opts?.waitMs === undefined) await releaseReconciliation.promise;
				return actualFetch(opts);
			});
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: before, streamSnapshots: false });
			const pendingStale = remote.refreshSnapshot();
			await staleStarted.promise;
			try {
				if (disableMode === "confirmed") {
					expect(await remote.deleteAuthCredentialRemote(id, "synthetic broker disable")).toBe(true);
				} else {
					remote.deleteAuthCredential(id, "synthetic immediate disable");
				}
				if (disableMode === "fire-and-forget") {
					// The void API must wait for the broker's real acknowledgment.
					await waitUntil(() => remote!.snapshot.credentials.length === 0);
				}
				expect(remote.snapshot.credentials).toEqual([]);
				releaseStale.resolve();
				await pendingStale;
				expect(remote.snapshot.credentials).toEqual([]);
			} finally {
				releaseStale.resolve();
				releaseReconciliation.resolve();
			}
			if (disableMode === "confirmed") {
				await remote.refreshSnapshot();
				// The real broker also confirms the deletion, independently of
				// the client's in-flight stale GET ordering.
				expect(remote.snapshot.credentials).toEqual([]);
			}
		});
	}

	test("synchronous broker delete retains the grant until explicit confirmation", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });

		const realDisable = client.disableCredential.bind(client);
		const refused = Promise.withResolvers<{ ok: boolean }>();
		let first = true;
		spyOn(client, "disableCredential").mockImplementation((target, cause, signal) => {
			if (first) {
				first = false;
				return refused.promise;
			}
			return realDisable(target, cause, signal);
		});

		remote.deleteAuthCredential(id, "synthetic refused disable");
		expect(remote.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
		refused.resolve({ ok: false });
		await scheduler.wait(0);
		expect(remote.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
		const afterRefusal = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (afterRefusal.status !== 200) throw new Error("expected authoritative broker snapshot");
		expect(afterRefusal.snapshot.credentials.map(entry => entry.id)).toEqual([id]);

		remote.deleteAuthCredential(id, "synthetic confirmed disable");
		await waitUntil(() => remote!.snapshot.credentials.length === 0);
		const afterConfirmation = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (afterConfirmation.status !== 200) throw new Error("expected broker snapshot after confirmed disable");
		expect(afterConfirmation.snapshot.credentials).toEqual([]);
	});

	test("a delayed synchronous disable reply cannot erase a newer broker snapshot", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
		const lateAcknowledgment = Promise.withResolvers<{ ok: boolean }>();
		spyOn(client, "disableCredential").mockImplementation(() => lateAcknowledgment.promise);

		remote.deleteAuthCredential(id, "synthetic delayed disable");
		expect(remote.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
		store!.updateAuthCredential(id, mintOAuthCredential("new", Date.now() + 120_000));
		await storage!.reload();
		await remote.refreshSnapshot();
		expect(remote.snapshot.credentials[0]!.credential).toMatchObject({ access: "access-new" });

		lateAcknowledgment.resolve({ ok: true });
		await scheduler.wait(0);
		expect(remote.snapshot.credentials[0]!.credential).toMatchObject({ access: "access-new" });
		const authoritative = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (authoritative.status !== 200) throw new Error("expected broker snapshot");
		expect(authoritative.snapshot.credentials[0]!.credential).toMatchObject({ access: "access-new" });
	});

	test("an awaited broker disable cannot evict a newer accepted grant with the same id", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });

		const acknowledgement = Promise.withResolvers<{ ok: boolean }>();
		const disableStarted = Promise.withResolvers<void>();
		spyOn(client, "disableCredential").mockImplementation(async target => {
			expect(target).toBe(id);
			disableStarted.resolve();
			return acknowledgement.promise;
		});

		// Prevent the write-triggered GET from masking a transient erroneous local
		// eviction: this test must inspect the production store *before* reconciliation.
		const realFetch = client.fetchSnapshot.bind(client);
		const reconciliationStarted = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		let holdReconciliation = false;
		spyOn(client, "fetchSnapshot").mockImplementation(async options => {
			if (holdReconciliation && options?.waitMs === undefined) {
				reconciliationStarted.resolve();
				await releaseReconciliation.promise;
			}
			return realFetch(options);
		});

		const pending = remote.deleteAuthCredentialRemote(id, "synthetic delayed confirmed disable");
		await disableStarted.promise;
		// Another broker mutation is accepted while the earlier disable waits.
		store!.updateAuthCredential(id, mintOAuthCredential("new", Date.now() + 120_000));
		await storage!.reload();
		await remote.refreshSnapshot();
		expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
			access: "access-new",
			refresh: REMOTE_REFRESH_SENTINEL,
		});
		holdReconciliation = true;

		try {
			acknowledgement.resolve({ ok: true });
			await expect(pending).rejects.toThrow(/disable superseded by newer state/i);
			await reconciliationStarted.promise;
			// The confirmed older disable is not a confirmation that the now-current
			// grant was disabled: it must remain readable while reconciliation waits.
			expect(remote.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
			expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
				access: "access-new",
				refresh: REMOTE_REFRESH_SENTINEL,
			});
			const authoritative = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected authoritative broker snapshot");
			expect(authoritative.snapshot.credentials[0]?.credential).toMatchObject({ access: "access-new" });
		} finally {
			acknowledgement.resolve({ ok: true });
			releaseReconciliation.resolve();
		}
	});

	test("remote synchronous compare-and-disable refuses an unverifiable grant CAS", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });

		const disabled = remote.tryDisableAuthCredentialIfMatches(id, "synthetic-old-serialized-grant", "synthetic refresh failure");
		expect(disabled).toBe(false);
		expect(remote.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
		const authoritative = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (authoritative.status !== 200) throw new Error("expected broker snapshot");
		expect(authoritative.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
	});

	// Provider-wide mutation is not a transaction: a confirmed earlier disable
	// must remain visible, but a later failed disable must abort the operation.
	for (const operation of ["logout", "replace"] as const) {
		test(`provider ${operation} surfaces a failed broker disable and preserves unrevoked grants`, async () => {
			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			expect(initial.snapshot.credentials).toHaveLength(2);
			const [first, failed] = initial.snapshot.credentials;
			remote = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: initial.snapshot,
				streamSnapshots: false,
			});

			// Keep the broker's real disable for the first grant, but inject an
			// unavailable transport for the second. This is all synthetic data.
			const realDisable = client.disableCredential.bind(client);
			spyOn(client, "disableCredential").mockImplementation((id, cause, signal) => {
				if (id === failed!.id) return Promise.reject(new Error("synthetic broker unavailable"));
				return realDisable(id, cause, signal);
			});
			const run =
				operation === "logout"
					? remote.deleteAuthCredentialsRemote("anthropic", "synthetic logout")
					: remote.replaceAuthCredentialsRemote("anthropic", [
							mintOAuthCredential("replacement", Date.now() + 120_000),
						]);
			await expect(run).rejects.toThrow(/synthetic broker unavailable/);

			const authoritative = await client.fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected broker snapshot after failed disable");
			expect(authoritative.snapshot.credentials.map(entry => entry.id)).toEqual([failed!.id]);
			expect(authoritative.snapshot.credentials.some(entry => entry.id === first!.id)).toBe(false);
			// A failed replace must not upload another credential while the old
			// grant is still valid, and a failed logout cannot claim completion.
			expect(
				authoritative.snapshot.credentials.some(
					entry => entry.credential.type === "oauth" && entry.credential.access === "access-replacement",
				),
			).toBe(false);
			await remote.refreshSnapshot();
			expect(remote.listAuthCredentials("anthropic").map(entry => entry.id)).toEqual([failed!.id]);
		});
	}

	// HTTP 200 with ok:false is a failed disable, not permission to remove a
	// cached grant or upload its replacement. Drive the real remote store while
	// the synthetic broker transport denies the mutation.
	for (const operation of ["single", "logout", "replace"] as const) {
		test(`does not treat negative broker disable acknowledgment as successful ${operation}`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const id = initial.snapshot.credentials[0]!.id;
			remote = new RemoteAuthCredentialStore({
				client, initialSnapshot: initial.snapshot, streamSnapshots: false,
			});
			spyOn(client, "disableCredential").mockResolvedValue({ ok: false });

			const attempt = operation === "single"
				? remote.deleteAuthCredentialRemote(id, "synthetic disable")
				: operation === "logout"
					? remote.deleteAuthCredentialsRemote("anthropic", "synthetic logout")
					: remote.replaceAuthCredentialsRemote("anthropic", [
							mintOAuthCredential("replacement", Date.now() + 120_000),
						]);
			await expect(attempt).rejects.toThrow(/broker refused credential disable/i);

			// Check both local and authoritative state: a replacement must not be
			// uploaded after a rejected disable, and the original grant remains.
			expect(remote.listAuthCredentials("anthropic").map(entry => entry.id)).toEqual([id]);
			const authoritative = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected broker snapshot after negative acknowledgment");
			expect(authoritative.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
			expect(authoritative.snapshot.credentials[0]!.credential).toMatchObject({ access: "access-a" });
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


	test("rejects broker upload replies for another provider or with unredacted OAuth refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const entry = initial.snapshot.credentials[0]!;
		if (entry.credential.type !== "oauth") throw new Error("expected synthetic OAuth credential");
		// Simulate another provider with a globally distinct ID in the local snapshot.
		// A response for "anthropic" must never shadow that retained provider ID.
		const otherProvider = { ...entry, id: entry.id + 100, provider: "openai-codex" };
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: { ...initial.snapshot, credentials: [entry, otherProvider] },
			streamSnapshots: false,
		});
		const original = structuredClone(remote.snapshot.credentials);
		const upload = spyOn(client, "uploadCredential");
		const malformed = [
			{ label: "foreign provider", entries: [{ ...entry, provider: "openai-codex" }] },
			{
				label: "unredacted refresh",
				entries: [{ ...entry, credential: { ...entry.credential, refresh: "synthetic-unredacted-refresh" } }],
			},
			{
				label: "valid entry followed by foreign provider",
				entries: [entry, { ...entry, id: entry.id + 1, provider: "openai-codex" }],
			},
			{
				label: "duplicate returned credential ID",
				entries: [entry, { ...entry, credential: { ...entry.credential, access: "synthetic-other-access" } }],
			},
			{
				label: "returned credential shadows retained other-provider ID",
				entries: [{ ...entry, id: otherProvider.id }],
			},
		];
		for (const candidate of malformed) {
			upload.mockResolvedValue({ entries: candidate.entries });
			await expect(
				remote.upsertAuthCredentialRemote("anthropic", mintOAuthCredential("replacement", Date.now() + 120_000)),
			).rejects.toThrow(/broker upload.*(identity|redact)/i);
			expect(remote.snapshot.credentials).toEqual(original);
		}
	});

	// A broker write may complete while its HTTP reply is delayed. A newer
	// authoritative revocation must win over the older returned provider list.
	for (const operation of ["upsert", "replace"] as const) {
		test(`does not restore a revoked grant from a delayed ${operation} upload reply`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const peer = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const actualFetch = client.fetchSnapshot.bind(client);
			// Prevent background long-poll from racing the explicitly controlled
			// authoritative read, while retaining real HTTP for all direct reads.
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				if (opts?.waitMs === 30_000) {
					await untilAborted(opts.signal);
					throw new Error("background poll aborted");
				}
				return actualFetch(opts);
			});
			remote = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: initial.snapshot,
				streamSnapshots: false,
			});
			const actualUpload = client.uploadCredential.bind(client);
			const uploadCommitted = Promise.withResolvers<void>();
			const releaseReply = Promise.withResolvers<void>();
			spyOn(client, "uploadCredential").mockImplementation(async (provider, credential, signal) => {
				const response = await actualUpload(provider, credential, signal);
				uploadCommitted.resolve();
				await releaseReply.promise;
				return response;
			});
			const replacement = mintOAuthCredential("delayed-upload", Date.now() + 120_000);
			const pending = operation === "upsert"
				? remote.upsertAuthCredentialRemote("anthropic", replacement)
				: remote.replaceAuthCredentialsRemote("anthropic", [replacement]);
			await uploadCommitted.promise;
			try {
				const afterWrite = await peer.fetchSnapshot();
				if (afterWrite.status !== 200) throw new Error("expected post-upload broker snapshot");
				const uploaded = afterWrite.snapshot.credentials.find(entry =>
					entry.credential.type === "oauth" && entry.credential.access === "access-delayed-upload",
				);
				expect(uploaded).toBeDefined();
				await peer.disableCredential(uploaded!.id, "synthetic revocation before delayed reply");
				await remote.refreshSnapshot();
				expect(remote.snapshot.credentials.some(entry => entry.id === uploaded!.id)).toBe(false);

				// Without an upload-reply fence, the delayed pre-revocation
				// provider list would reinsert this grant after the newer GET.
				releaseReply.resolve();
				const delivered = await pending;
				expect(delivered.some(entry => entry.id === uploaded!.id)).toBe(false);
				expect(remote.snapshot.credentials.some(entry => entry.id === uploaded!.id)).toBe(false);
				const brokerNow = await peer.fetchSnapshot();
				if (brokerNow.status !== 200) throw new Error("expected final broker snapshot");
				expect(brokerNow.snapshot.credentials.some(entry => entry.id === uploaded!.id)).toBe(false);
			} finally {
				releaseReply.resolve();
			}
		});
	}

	test("accepts a real broker upload with the requested provider and redacted OAuth grants", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot, streamSnapshots: false });
		const delivered = await remote.upsertAuthCredentialRemote(
			"anthropic",
			mintOAuthCredential("b", Date.now() + 120_000),
		);
		expect(delivered.map(row => row.provider)).toEqual(["anthropic", "anthropic"]);
		expect(delivered.map(row => row.credential.type === "oauth" ? row.credential.access : null).sort())
			.toEqual(["access-a", "access-b"]);
		expect(delivered.map(row => row.credential.type === "oauth" ? row.credential.refresh : null))
			.toEqual([REMOTE_REFRESH_SENTINEL, REMOTE_REFRESH_SENTINEL]);
	});


	test("keeps a credential blocked when broker block deletion fails or returns a negative acknowledgment", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const blockedUntilMs = Date.now() + 120_000;
		await client.upsertCredentialBlock(id, {
			providerKey: "anthropic", blockScope: "credential", blockedUntilMs, updatedAtMs: Date.now(),
		});
		const seeded = await client.fetchSnapshot();
		if (seeded.status !== 200) throw new Error("expected seeded broker snapshot");
		expect(seeded.snapshot.credentials[0]?.blocks).toMatchObject([{
			providerKey: "anthropic", blockScope: "credential", blockedUntilMs,
		}]);
		remote = new RemoteAuthCredentialStore({
			client, initialSnapshot: seeded.snapshot, streamSnapshots: false,
		});
		// The synchronous store method reports asynchronous broker failures by
		// warning. Wait for that actual failure-handling boundary, not elapsed
		// time: a no-op or never-settling DELETE must not pass this regression.
		const replies = [Promise.withResolvers<{ ok: boolean }>(), Promise.withResolvers<{ ok: boolean }>()];
		let requestsStarted = 0;
		let failuresHandled = 0;
		spyOn(client, "deleteCredentialBlocks").mockImplementation(() => {
			const reply = replies[requestsStarted];
			requestsStarted += 1;
			if (!reply) throw new Error("unexpected synthetic broker DELETE");
			return reply.promise;
		});
		spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "auth-broker credential blocks delete propagation failed" && context?.id === id) {
				failuresHandled += 1;
			}
		});
		for (let attempt = 0; attempt < replies.length; attempt += 1) {
			remote.deleteCredentialBlocks(id);
			await waitUntil(() => requestsStarted === attempt + 1);
			// The local block remains enforced even before a failed response arrives.
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(blockedUntilMs);
			if (attempt === 0) replies[attempt]!.reject(new Error("synthetic broker unavailable"));
			else replies[attempt]!.resolve({ ok: false });
			// This bounded wait fails if DELETE was never called, never settles,
			// or its rejection/negative acknowledgment never reaches the handler.
			await waitUntil(() => failuresHandled === attempt + 1);
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(blockedUntilMs);
		}
		const authoritative = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (authoritative.status !== 200) throw new Error("expected authoritative broker snapshot");
		expect(authoritative.snapshot.credentials[0]?.blocks).toMatchObject([{
			providerKey: "anthropic", blockScope: "credential", blockedUntilMs,
		}]);
	});

	for (const concurrentBlock of [false, true] as const) {
		test(
			concurrentBlock
				? "does not erase a newer broker block when an older DELETE acknowledgment arrives"
				: "keeps a block until the broker confirms deletion, then clears it",
			async () => {
				const client = new AuthBrokerClient({ url: handle!.url, token });
				const peer = new AuthBrokerClient({ url: handle!.url, token });
				const initial = await client.fetchSnapshot();
				if (initial.status !== 200) throw new Error("expected broker snapshot");
				const id = initial.snapshot.credentials[0]!.id;
				const blockedUntilMs = Date.now() + 120_000;
				const newerUntilMs = blockedUntilMs + 60_000;
				await client.upsertCredentialBlock(id, {
					providerKey: "anthropic", blockScope: "credential", blockedUntilMs, updatedAtMs: Date.now(),
				});
				const seeded = await client.fetchSnapshot();
				if (seeded.status !== 200) throw new Error("expected seeded broker snapshot");
				const actualFetch = client.fetchSnapshot.bind(client);
				// Keep the background long-poll from racing the held DELETE reply.
				spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
					if (opts?.waitMs !== undefined) {
						await untilAborted(opts.signal);
						throw new Error("synthetic background poll aborted");
					}
					return actualFetch(opts);
				});
				remote = new RemoteAuthCredentialStore({
					client, initialSnapshot: seeded.snapshot, streamSnapshots: false,
				});
				const actualDelete = client.deleteCredentialBlocks.bind(client);
				const brokerCommitted = Promise.withResolvers<void>();
				const releaseReply = Promise.withResolvers<void>();
				spyOn(client, "deleteCredentialBlocks").mockImplementation(async (credentialId, signal) => {
					const response = await actualDelete(credentialId, signal);
					brokerCommitted.resolve();
					await releaseReply.promise;
					return response;
				});
				remote.deleteCredentialBlocks(id);
				await brokerCommitted.promise;
				try {
					// A broker-side committed deletion is not enough until this client
					// receives confirmation: the earlier known block remains effective.
					expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(blockedUntilMs);
					const afterDelete = await peer.fetchSnapshot();
					if (afterDelete.status !== 200) throw new Error("expected broker snapshot after DELETE");
					expect(afterDelete.snapshot.credentials[0]?.blocks ?? []).toEqual([]);
					if (concurrentBlock) {
						await peer.upsertCredentialBlock(id, {
							providerKey: "anthropic", blockScope: "credential", blockedUntilMs: newerUntilMs,
							updatedAtMs: Date.now(),
						});
						await remote.refreshSnapshot();
						expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
					}
				} finally {
					releaseReply.resolve();
				}
				const expected = concurrentBlock ? newerUntilMs : undefined;
				await waitUntil(() => remote!.getCredentialBlock(id, "anthropic", "credential") === expected);
				const finalBroker = await peer.fetchSnapshot();
				if (finalBroker.status !== 200) throw new Error("expected final broker snapshot");
				expect(finalBroker.snapshot.credentials[0]?.blocks ?? []).toMatchObject(
					concurrentBlock
						? [{ providerKey: "anthropic", blockScope: "credential", blockedUntilMs: newerUntilMs }]
						: [],
				);
			},
		);
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
