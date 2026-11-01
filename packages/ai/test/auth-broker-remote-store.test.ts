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


	// The initial provider-wide list may become stale while a disable is in flight.
	// A late acknowledgment for its old grant must not evict a refreshed same-ID
	// grant or allow an unsafe replacement upload.
	for (const operation of ["logout", "replace"] as const) {
		test(`provider ${operation} refuses a late disable acknowledgment after newer grant acceptance`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const id = initial.snapshot.credentials[0]!.id;
			remote = new RemoteAuthCredentialStore({
				client, initialSnapshot: initial.snapshot, streamSnapshots: false,
			});
			const acknowledgement = Promise.withResolvers<{ ok: boolean }>();
			const disableStarted = Promise.withResolvers<void>();
			spyOn(client, "disableCredential").mockImplementation(async target => {
				expect(target).toBe(id);
				disableStarted.resolve();
				return acknowledgement.promise;
			});
			const upload = spyOn(client, "uploadCredential").mockImplementation(async () => {
				throw new Error("unexpected replacement upload after superseded disable");
			});
			// Block the write-triggered GET so it cannot repair a local eviction before
			// we inspect the actual production store.
			const realFetch = client.fetchSnapshot.bind(client);
			const releaseReconciliation = Promise.withResolvers<void>();
			let holdReconciliation = false;
			spyOn(client, "fetchSnapshot").mockImplementation(async options => {
				if (holdReconciliation && options?.waitMs === undefined) {
					await releaseReconciliation.promise;
				}
				return realFetch(options);
			});

			const pending = operation === "logout"
				? remote.deleteAuthCredentialsRemote("anthropic", "synthetic provider logout")
				: remote.replaceAuthCredentialsRemote("anthropic", [
						mintOAuthCredential("replacement", Date.now() + 120_000),
					]);
			await disableStarted.promise;
			store!.updateAuthCredential(id, mintOAuthCredential("new", Date.now() + 120_000));
			await storage!.reload();
			await remote.refreshSnapshot();
			expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
				access: "access-new", refresh: REMOTE_REFRESH_SENTINEL,
			});
			holdReconciliation = true;
			try {
				acknowledgement.resolve({ ok: true });
				await expect(pending).rejects.toThrow(/disable superseded by newer state/i);
				expect(upload).not.toHaveBeenCalled();
				expect(remote.snapshot.credentials.map(entry => entry.id)).toEqual([id]);
				expect(remote.snapshot.credentials[0]?.credential).toMatchObject({
					access: "access-new", refresh: REMOTE_REFRESH_SENTINEL,
				});
				const authoritative = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
				if (authoritative.status !== 200) throw new Error("expected broker snapshot");
				expect(authoritative.snapshot.credentials[0]?.credential).toMatchObject({ access: "access-new" });
			} finally {
				acknowledgement.resolve({ ok: true });
				releaseReconciliation.resolve();
			}
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


	for (const failedUpsert of ["negative acknowledgment", "rejected transport"] as const) {
		test(`reconciles a speculative credential block after ${failedUpsert} even while streaming`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const peer = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected broker snapshot");
			const id = initial.snapshot.credentials[0]!.id;
			const streamReady = Promise.withResolvers<void>();
			spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
				yield { kind: "snapshot" as const, ...initial.snapshot };
				streamReady.resolve();
				await untilAborted(opts.signal);
			});
			const realFetch = client.fetchSnapshot.bind(client);
			let fullSnapshotReads = 0;
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				if (opts?.waitMs !== undefined) throw new Error("unexpected background poll in stream mode");
				fullSnapshotReads += 1;
				return realFetch(opts);
			});
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
			await streamReady.promise;
			const pendingResponse = Promise.withResolvers<{ ok: boolean }>();
			let postAttempts = 0;
			spyOn(client, "upsertCredentialBlock").mockImplementation(async () => {
				postAttempts += 1;
				return pendingResponse.promise;
			});
			const blockedUntilMs = Date.now() + 120_000;
			remote.upsertCredentialBlock({
				credentialId: id, providerKey: "anthropic", blockScope: "credential",
				blockedUntilMs, updatedAtMs: Date.now(),
			});
			await waitUntil(() => postAttempts === 1);
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(blockedUntilMs);
			try {
				if (failedUpsert === "negative acknowledgment") pendingResponse.resolve({ ok: false });
				else pendingResponse.reject(new Error("synthetic broker POST unavailable"));
				// A failed write emits no stream event; a full broker read must retire
				// the speculative block instead of keeping a phantom restriction.
				await waitUntil(() =>
					fullSnapshotReads === 1 &&
					remote!.getCredentialBlock(id, "anthropic", "credential") === undefined,
				);
				expect(remote.getCredentialBlockReconcileAfter(id, "anthropic", "credential")).toBeUndefined();
				expect(remote.listCredentialBlocks([id])).toEqual([]);
				const authoritative = await peer.fetchSnapshot();
				if (authoritative.status !== 200) throw new Error("expected final broker snapshot");
				expect(authoritative.snapshot.credentials[0]?.blocks ?? []).toEqual([]);
			} finally {
				pendingResponse.resolve({ ok: false });
			}
		});
	}




	for (const incoming of ["SSE", "GET"] as const) {
		test(`keeps a pending broker block across an older peer ${incoming} snapshot until reconciliation`, async () => {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			const peer = new AuthBrokerClient({ url: handle!.url, token });
			const initial = await peer.fetchSnapshot();
			if (initial.status !== 200) throw new Error("expected initial synthetic broker snapshot");
			const id = initial.snapshot.credentials[0]!.id;
			const streamReady = Promise.withResolvers<void>();
			const peerEntryFrame = Promise.withResolvers<SnapshotResponse>();
			spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
				yield { kind: "snapshot" as const, ...initial.snapshot };
				streamReady.resolve();
				const next = await peerEntryFrame.promise;
				const entry = next.credentials.find(candidate => candidate.id === id);
				if (!entry) throw new Error("expected updated peer credential");
				yield {
					kind: "entry" as const, generation: next.generation, serverNowMs: next.serverNowMs,
					refresher: next.refresher, entry,
				};
				await untilAborted(opts.signal);
			});
			const realFetch = client.fetchSnapshot.bind(client);
			let fullReads = 0;
			spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
				if (opts?.waitMs !== undefined) throw new Error("unexpected long-poll during synthetic SSE");
				fullReads += 1;
				return realFetch(opts);
			});
			const realUpsert = client.upsertCredentialBlock.bind(client);
			const pendingStarted = Promise.withResolvers<void>();
			const releasePending = Promise.withResolvers<void>();
			const pendingCommitted = Promise.withResolvers<void>();
			spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
				pendingStarted.resolve();
				await releasePending.promise;
				const reply = await realUpsert(credentialId, body);
				pendingCommitted.resolve();
				return reply;
			});
			remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
			await streamReady.promise;
			const olderUntilMs = Date.now() + 60_000;
			const newerUntilMs = olderUntilMs + 60_000;
			remote.upsertCredentialBlock({
				credentialId: id, providerKey: "anthropic", blockScope: "credential",
				blockedUntilMs: newerUntilMs, updatedAtMs: Date.now(),
			});
			await pendingStarted.promise;
			try {
				// A peer commits an older block while our later, longer block is
				// speculative. Both events are legitimate broker responses.
				const olderAck = await peer.upsertCredentialBlock(id, {
					providerKey: "anthropic", blockScope: "credential",
					blockedUntilMs: olderUntilMs, updatedAtMs: Date.now(),
				});
				expect(olderAck).toEqual({ ok: true });
				const olderSnapshot = await peer.fetchSnapshot();
				if (olderSnapshot.status !== 200) throw new Error("expected older broker state");
				if (incoming === "SSE") {
					peerEntryFrame.resolve(olderSnapshot.snapshot);
					await waitUntil(() => remote!.snapshot.generation === olderSnapshot.snapshot.generation);
				} else {
					await remote.refreshSnapshot();
				}
				// A broker read must not wipe a pending local safety block.
				expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
				releasePending.resolve();
				await pendingCommitted.promise;
				const finalBroker = await peer.fetchSnapshot();
				if (finalBroker.status !== 200) throw new Error("expected final broker snapshot");
				await waitUntil(() =>
					fullReads >= (incoming === "SSE" ? 1 : 2) &&
					remote!.snapshot.generation === finalBroker.snapshot.generation &&
					remote!.getCredentialBlock(id, "anthropic", "credential") === newerUntilMs,
				);
				expect(finalBroker.snapshot.credentials.find(entry => entry.id === id)?.blocks).toMatchObject([
					{ providerKey: "anthropic", blockScope: "credential", blockedUntilMs: newerUntilMs },
				]);
				expect(remote.listCredentialBlocks([id])).toMatchObject([
					{ credentialId: id, providerKey: "anthropic", blockScope: "credential", blockedUntilMs: newerUntilMs },
				]);
			} finally {
				releasePending.resolve();
				peerEntryFrame.resolve(initial.snapshot);
			}
		});
	}


	// Both source paths must combine locally pending safety with a distinct
	// broker-authoritative peer scope, rather than replacing either list.
	for (const incoming of ["SSE", "GET"] as const) {
		for (const outcome of ["accepted", "rejected"] as const) {
			test(`retains a peer block during held ${outcome} cross-scope ${incoming} upsert`, async () => {
				const client = new AuthBrokerClient({ url: handle!.url, token });
				const peer = new AuthBrokerClient({ url: handle!.url, token });
				const initial = await peer.fetchSnapshot();
				if (initial.status !== 200) throw new Error("expected initial synthetic broker snapshot");
				const id = initial.snapshot.credentials[0]!.id;
				const streamReady = Promise.withResolvers<void>();
				const peerFrame = Promise.withResolvers<SnapshotResponse>();
				spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
					yield { kind: "snapshot" as const, ...initial.snapshot };
					streamReady.resolve();
					if (incoming === "SSE") {
						const next = await peerFrame.promise;
						const entry = next.credentials.find(candidate => candidate.id === id);
						if (!entry) throw new Error("missing synthetic peer entry");
						yield {
							kind: "entry" as const, generation: next.generation, serverNowMs: next.serverNowMs,
							refresher: next.refresher, entry,
						};
					}
					await untilAborted(opts.signal);
				});
				const realFetch = client.fetchSnapshot.bind(client);
				let fullReads = 0;
				spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
					if (opts?.waitMs !== undefined) throw new Error("unexpected long-poll with active synthetic SSE");
					fullReads += 1;
					return realFetch(opts);
				});
				const realUpsert = client.upsertCredentialBlock.bind(client);
				const pendingStarted = Promise.withResolvers<void>();
				const releasePending = Promise.withResolvers<void>();
				const pendingSettled = Promise.withResolvers<void>();
				spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
					expect(body.blockScope).toBe("scope-A");
					pendingStarted.resolve();
					await releasePending.promise;
					const response = outcome === "accepted"
						? await realUpsert(credentialId, body)
						: { ok: false };
					pendingSettled.resolve();
					return response;
				});
				remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
				await streamReady.promise;
				const localUntilMs = Date.now() + 90_000;
				const peerUntilMs = localUntilMs + 60_000;
				remote.upsertCredentialBlock({
					credentialId: id, providerKey: "anthropic", blockScope: "scope-A",
					blockedUntilMs: localUntilMs, updatedAtMs: Date.now(),
				});
				await pendingStarted.promise;
				try {
					const peerAck = await peer.upsertCredentialBlock(id, {
						providerKey: "anthropic", blockScope: "scope-B",
						blockedUntilMs: peerUntilMs, updatedAtMs: Date.now(),
					});
					expect(peerAck).toEqual({ ok: true });
					const peerSnapshot = await peer.fetchSnapshot();
					if (peerSnapshot.status !== 200) throw new Error("expected committed peer block");
					if (incoming === "SSE") {
						peerFrame.resolve(peerSnapshot.snapshot);
						await waitUntil(() => remote!.snapshot.generation === peerSnapshot.snapshot.generation);
					} else {
						await remote.refreshSnapshot();
					}
					// The peer's independent restriction is broker-authoritative even
					// though our scope-A POST has not received an acknowledgment.
					expect(remote.getCredentialBlock(id, "anthropic", "scope-A")).toBe(localUntilMs);
					expect(remote.getCredentialBlock(id, "anthropic", "scope-B")).toBe(peerUntilMs);
					expect(remote.listCredentialBlocks([id])).toHaveLength(2);
					releasePending.resolve();
					await pendingSettled.promise;
					await waitUntil(() =>
						fullReads >= (incoming === "SSE" ? 1 : 2) &&
						remote!.getCredentialBlock(id, "anthropic", "scope-B") === peerUntilMs &&
						remote!.getCredentialBlock(id, "anthropic", "scope-A") ===
							(outcome === "accepted" ? localUntilMs : undefined),
					);
					const authoritative = await peer.fetchSnapshot();
					if (authoritative.status !== 200) throw new Error("expected authoritative broker state");
					const scopes = authoritative.snapshot.credentials
						.find(entry => entry.id === id)?.blocks?.map(block => block.blockScope).sort() ?? [];
					expect(scopes).toEqual(outcome === "accepted" ? ["scope-A", "scope-B"] : ["scope-B"]);
					expect(remote.listCredentialBlocks([id]).map(block => block.blockScope).sort()).toEqual(scopes);
				} finally {
					releasePending.resolve();
					peerFrame.resolve(initial.snapshot);
				}
			});
		}
	}

	test("retries failed block-upsert reconciliation when an unrelated SSE entry supersedes its GET", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const blockedUntilMs = Date.now() + 120_000;

		const streamReady = Promise.withResolvers<void>();
		const unrelatedFrame = Promise.withResolvers<SnapshotResponse>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...initial.snapshot };
			streamReady.resolve();
			const next = await unrelatedFrame.promise;
			const added = next.credentials.find(entry => entry.id !== id);
			if (!added) throw new Error("expected unrelated broker credential");
			yield {
				kind: "entry" as const,
				generation: next.generation,
				serverNowMs: next.serverNowMs,
				refresher: next.refresher,
				entry: added,
			};
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		const firstReadReady = Promise.withResolvers<void>();
		const releaseFirstRead = Promise.withResolvers<void>();
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected long-poll during synthetic SSE");
			fullReads += 1;
			if (fullReads !== 1) return realFetch(opts);
			// Materialize the earlier authoritative answer before unrelated broker
			// changes, then hold only its delivery to the remote store.
			const prior = await realFetch(opts);
			firstReadReady.resolve();
			await releaseFirstRead.promise;
			return prior;
		});
		const rejectedUpsert = Promise.withResolvers<{ ok: boolean }>();
		spyOn(client, "upsertCredentialBlock").mockImplementation(() => rejectedUpsert.promise);
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		await streamReady.promise;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs, updatedAtMs: Date.now(),
		});
		expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(blockedUntilMs);
		try {
			rejectedUpsert.resolve({ ok: false });
			await firstReadReady.promise;
			// The other credential is genuinely added to the synthetic SQLite broker
			// before we emit the corresponding SSE entry into the production consumer.
			await peer.uploadCredential("anthropic", mintOAuthCredential("peer-b", Date.now() + 120_000));
			const brokerAfterPeer = await peer.fetchSnapshot();
			if (brokerAfterPeer.status !== 200) throw new Error("expected broker snapshot after peer upload");
			const otherId = brokerAfterPeer.snapshot.credentials.find(entry => entry.id !== id)?.id;
			if (otherId === undefined) throw new Error("expected second credential");
			unrelatedFrame.resolve(brokerAfterPeer.snapshot);
			await waitUntil(() => remote!.snapshot.credentials.some(entry => entry.id === otherId));
			// The old GET is now obsolete because an unrelated SSE entry changed
			// the global revision. A fresh GET must still reconcile A's failed POST.
			releaseFirstRead.resolve();
			await waitUntil(() =>
				fullReads === 2 &&
				remote!.getCredentialBlock(id, "anthropic", "credential") === undefined,
			);
			expect(remote.snapshot.credentials.map(entry => entry.id).sort((a, b) => a - b))
				.toEqual([id, otherId].sort((a, b) => a - b));
			expect(remote.getCredentialBlockReconcileAfter(id, "anthropic", "credential")).toBeUndefined();
			const authoritative = await peer.fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected authoritative broker snapshot");
			expect(authoritative.snapshot.credentials.find(entry => entry.id === id)?.blocks ?? []).toEqual([]);
		} finally {
			rejectedUpsert.resolve({ ok: false });
			releaseFirstRead.resolve();
			unrelatedFrame.resolve(initial.snapshot);
		}
	});

	test("does not refresh away a newer pending same-ID block after an older successful POST", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected synthetic broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const realFetch = client.fetchSnapshot.bind(client);
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) {
				await untilAborted(opts.signal);
				throw new Error("background poll aborted");
			}
			fullReads += 1;
			return realFetch(opts);
		});
		const actualPost = client.upsertCredentialBlock.bind(client);
		const olderCommitted = Promise.withResolvers<void>();
		const olderRelease = Promise.withResolvers<void>();
		const newerRelease = Promise.withResolvers<void>();
		const newerCommitted = Promise.withResolvers<void>();
		let posts = 0;
		spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
			posts += 1;
			if (posts === 1) {
				const ack = await actualPost(credentialId, body);
				olderCommitted.resolve();
				await olderRelease.promise;
				return ack;
			}
			if (posts !== 2) throw new Error("unexpected third synthetic POST");
			await newerRelease.promise;
			const ack = await actualPost(credentialId, body);
			newerCommitted.resolve();
			return ack;
		});
		remote = new RemoteAuthCredentialStore({
			client, initialSnapshot: initial.snapshot, streamSnapshots: false,
		});
		const olderUntilMs = Date.now() + 90_000;
		const newerUntilMs = olderUntilMs + 60_000;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: olderUntilMs, updatedAtMs: Date.now(),
		});
		await olderCommitted.promise;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: newerUntilMs, updatedAtMs: Date.now(),
		});
		expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
		try {
			olderRelease.resolve();
			await Bun.sleep(40);
			// A stale successful POST must not start a normal non-SSE refresh
			// which would see only the older committed block at this point.
			expect(fullReads).toBe(0);
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
			newerRelease.resolve();
			await newerCommitted.promise;
			await waitUntil(() => fullReads === 1);
			const brokerNow = await peer.fetchSnapshot();
			if (brokerNow.status !== 200) throw new Error("expected final broker snapshot");
			expect(brokerNow.snapshot.credentials.find(entry => entry.id === id)?.blocks)
				.toMatchObject([{ providerKey: "anthropic", blockScope: "credential", blockedUntilMs: newerUntilMs }]);
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
		} finally {
			olderRelease.resolve();
			newerRelease.resolve();
		}
	});

	test("does not reconcile away a newer same-ID pending block after an older POST is refused", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const streamReady = Promise.withResolvers<void>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...initial.snapshot };
			streamReady.resolve();
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected background poll in SSE mode");
			fullReads += 1;
			return realFetch(opts);
		});
		const realUpsert = client.upsertCredentialBlock.bind(client);
		const olderReply = Promise.withResolvers<{ ok: boolean }>();
		const newerRelease = Promise.withResolvers<void>();
		const newerStarted = Promise.withResolvers<void>();
		const newerCommitted = Promise.withResolvers<void>();
		let postCount = 0;
		spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
			postCount += 1;
			if (postCount === 1) return olderReply.promise;
			if (postCount !== 2) throw new Error("unexpected third block POST");
			newerStarted.resolve();
			await newerRelease.promise;
			const reply = await realUpsert(credentialId, body);
			newerCommitted.resolve();
			return reply;
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		await streamReady.promise;
		const firstUntilMs = Date.now() + 90_000;
		const newerUntilMs = firstUntilMs + 60_000;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: firstUntilMs, updatedAtMs: Date.now(),
		});
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: newerUntilMs, updatedAtMs: Date.now(),
		});
		await newerStarted.promise;
		expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
		try {
			olderReply.resolve({ ok: false });
			// Allow the older failed-POST handler to progress while the later real
			// broker write is pending and the active SSE emits no more frames.
			await Bun.sleep(40);
			expect(fullReads).toBe(0);
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(newerUntilMs);
			newerRelease.resolve();
			await newerCommitted.promise;
			const brokerNow = await peer.fetchSnapshot();
			if (brokerNow.status !== 200) throw new Error("expected authoritative broker snapshot");
			expect(brokerNow.snapshot.credentials.find(entry => entry.id === id)?.blocks)
				.toMatchObject([{ providerKey: "anthropic", blockScope: "credential", blockedUntilMs: newerUntilMs }]);
			await waitUntil(() => fullReads >= 1 && remote!.getCredentialBlock(id, "anthropic", "credential") === newerUntilMs);
			expect(fullReads).toBe(1);
		} finally {
			olderReply.resolve({ ok: false });
			newerRelease.resolve();
		}
	});



	test("reconciles a failed longer same-scope block after a shorter newer block commits with stalled SSE", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected synthetic broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const streamReady = Promise.withResolvers<void>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...initial.snapshot };
			streamReady.resolve();
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected background poll with stalled SSE");
			fullReads += 1;
			return realFetch(opts);
		});
		const olderReply = Promise.withResolvers<{ ok: boolean }>();
		const releaseNewerPost = Promise.withResolvers<void>();
		const newerStarted = Promise.withResolvers<void>();
		const newerCommitted = Promise.withResolvers<void>();
		const realUpsert = client.upsertCredentialBlock.bind(client);
		let posts = 0;
		spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
			posts += 1;
			if (posts === 1) return olderReply.promise;
			if (posts !== 2) throw new Error("unexpected third synthetic broker POST");
			newerStarted.resolve();
			await releaseNewerPost.promise;
			const response = await realUpsert(credentialId, body);
			newerCommitted.resolve();
			return response;
		});
		let failedHandled = false;
		spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "auth-broker credential block propagation failed" && context?.id === id) {
				failedHandled = true;
			}
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		await streamReady.promise;
		const shorterUntilMs = Date.now() + 5 * 60_000;
		const longerUntilMs = shorterUntilMs + 55 * 60_000;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: longerUntilMs, updatedAtMs: Date.now(),
		});
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: shorterUntilMs, updatedAtMs: Date.now(),
		});
		await newerStarted.promise;
		expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(longerUntilMs);
		try {
			olderReply.resolve({ ok: false });
			await waitUntil(() => failedHandled);
			// A failed longer projection cannot shorten the still-pending B block,
			// nor can an interim broker GET erase the unacknowledged mutation.
			expect(fullReads).toBe(0);
			expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(longerUntilMs);
			releaseNewerPost.resolve();
			await newerCommitted.promise;
			const brokerNow = await peer.fetchSnapshot();
			if (brokerNow.status !== 200) throw new Error("expected authoritative broker snapshot");
			expect(brokerNow.snapshot.credentials.find(entry => entry.id === id)?.blocks).toMatchObject([
				{ providerKey: "anthropic", blockScope: "credential", blockedUntilMs: shorterUntilMs },
			]);
			// The newer confirmed 5-minute restriction, not A's rejected 60-minute
			// speculative projection, must become the exact local deadline.
			await waitUntil(() =>
				fullReads >= 1 &&
				remote!.getCredentialBlock(id, "anthropic", "credential") === shorterUntilMs,
			);
			expect(remote.listCredentialBlocks([id])).toMatchObject([
				{ credentialId: id, providerKey: "anthropic", blockScope: "credential", blockedUntilMs: shorterUntilMs },
			]);
		} finally {
			olderReply.resolve({ ok: false });
			releaseNewerPost.resolve();
		}
	});

	test("reconciles a failed cross-scope block after another scope commits on the same credential", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected synthetic broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const streamReady = Promise.withResolvers<void>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...initial.snapshot };
			streamReady.resolve();
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected background poll with stalled SSE");
			fullReads += 1;
			return realFetch(opts);
		});
		const olderReply = Promise.withResolvers<{ ok: boolean }>();
		const releaseNewerPost = Promise.withResolvers<void>();
		const newerStarted = Promise.withResolvers<void>();
		const newerCommitted = Promise.withResolvers<void>();
		const realUpsert = client.upsertCredentialBlock.bind(client);
		let posts = 0;
		spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
			posts += 1;
			if (posts === 1) {
				expect(body.blockScope).toBe("scope-A");
				return olderReply.promise;
			}
			if (posts !== 2) throw new Error("unexpected third synthetic block POST");
			expect(body.blockScope).toBe("scope-B");
			newerStarted.resolve();
			await releaseNewerPost.promise;
			const response = await realUpsert(credentialId, body);
			newerCommitted.resolve();
			return response;
		});
		let olderFailureHandled = false;
		spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "auth-broker credential block propagation failed" && context?.blockScope === "scope-A") {
				olderFailureHandled = true;
			}
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		await streamReady.promise;
		const firstUntilMs = Date.now() + 90_000;
		const secondUntilMs = firstUntilMs + 60_000;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "scope-A",
			blockedUntilMs: firstUntilMs, updatedAtMs: Date.now(),
		});
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "scope-B",
			blockedUntilMs: secondUntilMs, updatedAtMs: Date.now(),
		});
		await newerStarted.promise;
		expect(remote.getCredentialBlock(id, "anthropic", "scope-A")).toBe(firstUntilMs);
		expect(remote.getCredentialBlock(id, "anthropic", "scope-B")).toBe(secondUntilMs);
		try {
			olderReply.resolve({ ok: false });
			await waitUntil(() => olderFailureHandled);
			// A GET while scope B's POST is still pending would discard its
			// speculative protection before the broker has accepted it.
			expect(fullReads).toBe(0);
			expect(remote.getCredentialBlock(id, "anthropic", "scope-B")).toBe(secondUntilMs);
			releaseNewerPost.resolve();
			await newerCommitted.promise;
			const authoritative = await peer.fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected authoritative final broker snapshot");
			expect(authoritative.snapshot.credentials.find(entry => entry.id === id)?.blocks).toMatchObject([
				{ providerKey: "anthropic", blockScope: "scope-B", blockedUntilMs: secondUntilMs },
			]);
			// The apparently healthy but stalled SSE stream cannot strand a
			// phantom scope-A block simply because scope B committed afterward.
			await waitUntil(() =>
				fullReads >= 1 &&
				remote!.getCredentialBlock(id, "anthropic", "scope-A") === undefined &&
				remote!.getCredentialBlock(id, "anthropic", "scope-B") === secondUntilMs,
			);
			expect(remote.getCredentialBlockReconcileAfter(id, "anthropic", "scope-A")).toBeUndefined();
			expect(remote.listCredentialBlocks([id])).toMatchObject([
				{ credentialId: id, providerKey: "anthropic", blockScope: "scope-B", blockedUntilMs: secondUntilMs },
			]);
		} finally {
			olderReply.resolve({ ok: false });
			releaseNewerPost.resolve();
		}
	});



	test("does not reconcile a failed credential across another credential's pending block", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("peer", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected synthetic broker snapshot");
		const first = initial.snapshot.credentials.find(entry =>
			entry.credential.type === "oauth" && entry.credential.access === "access-a",
		);
		const second = initial.snapshot.credentials.find(entry =>
			entry.credential.type === "oauth" && entry.credential.access === "access-peer",
		);
		if (!first || !second) throw new Error("expected two independent synthetic credentials");
		const streamReady = Promise.withResolvers<void>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...initial.snapshot };
			streamReady.resolve();
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected background poll with stalled SSE");
			fullReads += 1;
			return realFetch(opts);
		});
		const releasePeerPost = Promise.withResolvers<void>();
		const peerPostStarted = Promise.withResolvers<void>();
		const peerPostCommitted = Promise.withResolvers<void>();
		const realUpsert = client.upsertCredentialBlock.bind(client);
		spyOn(client, "upsertCredentialBlock").mockImplementation(async (id, body) => {
			if (id === first.id) return { ok: false };
			if (id !== second.id) throw new Error("unexpected credential block POST");
			peerPostStarted.resolve();
			await releasePeerPost.promise;
			const response = await realUpsert(id, body);
			peerPostCommitted.resolve();
			return response;
		});
		let failureHandled = false;
		spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "auth-broker credential block propagation failed" && context?.id === first.id) {
				failureHandled = true;
			}
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		await streamReady.promise;
		const firstUntilMs = Date.now() + 90_000;
		const secondUntilMs = firstUntilMs + 60_000;
		remote.upsertCredentialBlock({
			credentialId: second.id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: secondUntilMs, updatedAtMs: Date.now(),
		});
		await peerPostStarted.promise;
		remote.upsertCredentialBlock({
			credentialId: first.id, providerKey: "anthropic", blockScope: "credential",
			blockedUntilMs: firstUntilMs, updatedAtMs: Date.now(),
		});
		try {
			await waitUntil(() => failureHandled);
			expect(fullReads).toBe(0);
			expect(remote.getCredentialBlock(second.id, "anthropic", "credential")).toBe(secondUntilMs);
			releasePeerPost.resolve();
			await peerPostCommitted.promise;
			await waitUntil(() =>
				fullReads >= 1 &&
				remote!.getCredentialBlock(first.id, "anthropic", "credential") === undefined &&
				remote!.getCredentialBlock(second.id, "anthropic", "credential") === secondUntilMs,
			);
			const authoritative = await peer.fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected final broker snapshot");
			expect(authoritative.snapshot.credentials.find(entry => entry.id === first.id)?.blocks ?? []).toEqual([]);
			expect(authoritative.snapshot.credentials.find(entry => entry.id === second.id)?.blocks).toMatchObject([
				{ providerKey: "anthropic", blockScope: "credential", blockedUntilMs: secondUntilMs },
			]);
			expect(remote.listCredentialBlocks([first.id, second.id])).toMatchObject([
				{ credentialId: second.id, providerKey: "anthropic", blockScope: "credential", blockedUntilMs: secondUntilMs },
			]);
		} finally {
			releasePeerPost.resolve();
		}
	});

	test("keeps a pending scope blocked across an overlapping confirmed delete-all", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected synthetic broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const streamReady = Promise.withResolvers<void>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...initial.snapshot };
			streamReady.resolve();
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		let fullReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected long-poll with stalled SSE");
			fullReads += 1;
			return realFetch(opts);
		});
		const realUpsert = client.upsertCredentialBlock.bind(client);
		const releaseUpsert = Promise.withResolvers<void>();
		const upsertStarted = Promise.withResolvers<void>();
		const upsertCommitted = Promise.withResolvers<void>();
		spyOn(client, "upsertCredentialBlock").mockImplementation(async (credentialId, body) => {
			upsertStarted.resolve();
			await releaseUpsert.promise;
			const response = await realUpsert(credentialId, body);
			upsertCommitted.resolve();
			return response;
		});
		const realDelete = client.deleteCredentialBlocks.bind(client);
		const deleteCommitted = Promise.withResolvers<void>();
		spyOn(client, "deleteCredentialBlocks").mockImplementation(async (credentialId, signal) => {
			const response = await realDelete(credentialId, signal);
			expect(response).toEqual({ ok: true });
			deleteCommitted.resolve();
			return response;
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		await streamReady.promise;
		const blockedUntilMs = Date.now() + 120_000;
		remote.upsertCredentialBlock({
			credentialId: id, providerKey: "anthropic", blockScope: "scope-pending",
			blockedUntilMs, updatedAtMs: Date.now(),
		});
		await upsertStarted.promise;
		expect(remote.getCredentialBlock(id, "anthropic", "scope-pending")).toBe(blockedUntilMs);
		try {
			// The broker sees an empty block set during DELETE; the earlier POST
			// is still held and will commit only after its deletion acknowledgment.
			remote.deleteCredentialBlocks(id);
			await deleteCommitted.promise;
			await scheduler.wait(0);
			expect(fullReads).toBe(0);
			expect(remote.getCredentialBlock(id, "anthropic", "scope-pending")).toBe(blockedUntilMs);
			releaseUpsert.resolve();
			await upsertCommitted.promise;
			const authoritative = await peer.fetchSnapshot();
			if (authoritative.status !== 200) throw new Error("expected final authoritative broker snapshot");
			expect(authoritative.snapshot.credentials.find(entry => entry.id === id)?.blocks).toMatchObject([
				{ providerKey: "anthropic", blockScope: "scope-pending", blockedUntilMs },
			]);
			// The local state must converge to the post-DELETE broker truth;
			// successful delete-all cannot evict a later-committed block.
			await waitUntil(() =>
				fullReads >= 1 &&
				remote!.getCredentialBlock(id, "anthropic", "scope-pending") === blockedUntilMs,
			);
			expect(remote.listCredentialBlocks([id])).toMatchObject([
				{ credentialId: id, providerKey: "anthropic", blockScope: "scope-pending", blockedUntilMs },
			]);
		} finally {
			releaseUpsert.resolve();
		}
	});

	test("reconciles a committed broker block DELETE whose acknowledgment was lost while SSE stalls", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const peer = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await peer.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		const id = initial.snapshot.credentials[0]!.id;
		const blockedUntilMs = Date.now() + 120_000;
		const blockAck = await peer.upsertCredentialBlock(id, {
			providerKey: "anthropic", blockScope: "credential", blockedUntilMs, updatedAtMs: Date.now(),
		});
		expect(blockAck).toEqual({ ok: true });
		const seeded = await peer.fetchSnapshot();
		if (seeded.status !== 200) throw new Error("expected seeded broker snapshot");
		expect(seeded.snapshot.credentials[0]?.blocks?.[0]?.blockedUntilMs).toBe(blockedUntilMs);

		// This client still believes SSE is healthy, but receives no mutation frames.
		// A lost DELETE acknowledgment cannot be corrected by waiting for this stream.
		const streamReady = Promise.withResolvers<void>();
		spyOn(client, "openSnapshotStream").mockImplementation(async function* (opts) {
			yield { kind: "snapshot" as const, ...seeded.snapshot };
			streamReady.resolve();
			await untilAborted(opts.signal);
		});
		const realFetch = client.fetchSnapshot.bind(client);
		let explicitSnapshotReads = 0;
		spyOn(client, "fetchSnapshot").mockImplementation(async opts => {
			if (opts?.waitMs !== undefined) throw new Error("unexpected long-poll with an active synthetic SSE stream");
			explicitSnapshotReads += 1;
			return realFetch(opts);
		});
		remote = new RemoteAuthCredentialStore({ client, initialSnapshot: seeded.snapshot });
		await streamReady.promise;
		expect(remote.getCredentialBlock(id, "anthropic", "credential")).toBe(blockedUntilMs);

		const realDelete = client.deleteCredentialBlocks.bind(client);
		const committed = Promise.withResolvers<void>();
		spyOn(client, "deleteCredentialBlocks").mockImplementation(async (credentialId, signal) => {
			const response = await realDelete(credentialId, signal);
			expect(response).toEqual({ ok: true });
			committed.resolve();
			throw new Error("synthetic DELETE acknowledgment lost after broker committed");
		});
		remote.deleteCredentialBlocks(id);
		await committed.promise;
		const authoritative = await peer.fetchSnapshot();
		if (authoritative.status !== 200) throw new Error("expected authoritative broker snapshot");
		expect(authoritative.snapshot.credentials[0]?.blocks ?? []).toEqual([]);
		await waitUntil(() =>
			explicitSnapshotReads === 1 &&
			remote!.getCredentialBlock(id, "anthropic", "credential") === undefined,
		);
		expect(remote.listCredentialBlocks([id])).toEqual([]);
		expect(remote.getCredentialBlockReconcileAfter(id, "anthropic", "credential")).toBeUndefined();
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
