/**
 * WHY: llama.cpp discovery probes its endpoint on every refresh, fresh cache or not, so a server restarted
 * with a new `n_ctx` reaches the catalog at the next launch. llama.cpp is also one of the implicit local
 * runtimes registered on every install. With no server running, each launch's probe failed, and the model
 * manager rewrote the provider's cache row stamped with the current time: a WAL append and an fsync on the
 * main thread, then a checkpoint with two more when the database closed at exit. A print run on a fast
 * provider paid it inside its exit tail on every launch.
 *
 * THE CLASS: a failed probe that rewrites a cache row whose content it does not change. For a provider
 * with a retry backoff the rewrite restarts the backoff, so it happens once per window, by design. For a
 * provider that probes on every refresh the timestamp restarts nothing, and the rewrite is a disk sync per
 * launch. This suite drives the real registry over every discovery type the models config schema accepts,
 * read out of the schema at run time, plus every implicit local runtime, with every endpoint refusing:
 * - after the backoff window, a provider with a backoff restamps its row and a provider that re-probes
 *   leaves it alone, the latter pinned by exact equality, so a new type that re-probes is a decision;
 * - a launch right after leaves every row in the database as it was, timestamps included.
 *
 * WHAT IT DOES NOT CATCH: a write that does not reach `model_cache`, and the row a re-probing provider
 * writes when its content does change (the catalog suite on failed probes owns that).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FetchImpl } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { IMPLICIT_LOCAL_RUNTIME_IDS, ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { modelsConfigSchemas } from "@veyyon/coding-agent/config/models-config-schema";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/** Past the five-minute window a provider with a backoff waits before probing a failed endpoint again. */
const PAST_BACKOFF_MS = 10 * 60 * 1000;

interface CacheRow {
	provider_id: string;
	updated_at: number;
	authoritative: number;
	content_fingerprint: string;
	models: string;
}

/** Every discovery type the models config accepts, read out of the schema rather than restated. */
function discoveryTypes(): string[] {
	const expression = modelsConfigSchemas().ProviderDiscoverySchema.expression;
	const quoted = expression.match(/"[^"]+"/g) ?? [];
	return quoted.map(token => token.slice(1, -1)).sort();
}

/** An endpoint that refuses every connection, as a stopped local server does. */
const refuse: FetchImpl = async input => {
	throw new Error(`Unable to connect: ${String(input)}`);
};

function readRows(dbPath: string): CacheRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query<CacheRow, []>(
				"SELECT provider_id, updated_at, authoritative, content_fingerprint, models FROM model_cache ORDER BY provider_id",
			)
			.all();
	} finally {
		db.close();
	}
}

function ageRows(dbPath: string, byMs: number): void {
	const db = new Database(dbPath);
	try {
		db.run("UPDATE model_cache SET updated_at = updated_at - ?", [byMs]);
	} finally {
		db.close();
	}
}

/** The row discovery keeps for `provider`: its own id, or a namespace under it. */
function rowFor(rows: readonly CacheRow[], provider: string): CacheRow {
	const row = rows.find(
		candidate => candidate.provider_id === provider || candidate.provider_id.startsWith(`${provider}:`),
	);
	if (!row)
		throw new Error(`no cache row for ${provider}: ${rows.map(candidate => candidate.provider_id).join(", ")}`);
	return row;
}

describe("a discovery endpoint that stays down", () => {
	let tempDir: string;
	let modelsPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `veyyon-down-endpoint-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	async function launch(): Promise<void> {
		await new ModelRegistry(authStorage, modelsPath, { fetch: refuse }).refresh();
	}

	it("restamps its cache row only to restart a backoff, and never on a launch that changes nothing", async () => {
		const configured = discoveryTypes().map(type => ({ provider: `down-${type}`, type }));
		const providers: Record<string, unknown> = {};
		for (const { provider, type } of configured) {
			providers[provider] = {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type },
			};
		}
		fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
		// A row older than the config is re-probed as stale config; this suite is about the backoff alone.
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		fs.utimesSync(modelsPath, anHourAgo, anHourAgo);
		const discoveryProviders = [...configured.map(({ provider }) => provider), ...IMPLICIT_LOCAL_RUNTIME_IDS].sort();

		await launch();
		ageRows(cacheDbPath, PAST_BACKOFF_MS);
		const aged = readRows(cacheDbPath);
		await launch();
		const afterBackoff = readRows(cacheDbPath);

		const kept = discoveryProviders.filter(
			provider => rowFor(afterBackoff, provider).updated_at === rowFor(aged, provider).updated_at,
		);
		expect(kept).toEqual(["down-llama.cpp", "llama.cpp"]);
		for (const provider of discoveryProviders) {
			const before = rowFor(aged, provider);
			const after = rowFor(afterBackoff, provider);
			expect({ provider, ...after, updated_at: 0 }).toEqual({ provider, ...before, updated_at: 0 });
			expect(after.authoritative).toBe(0);
		}

		// Any rewrite on the next launch would carry a later timestamp than the one it replaced.
		await sleep(5);
		await launch();
		expect(readRows(cacheDbPath)).toEqual(afterBackoff);
	});
});
