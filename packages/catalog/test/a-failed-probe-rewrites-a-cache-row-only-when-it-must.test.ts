/**
 * WHY: a failed dynamic fetch rewrites the provider's cache row stamped with the current time, and that
 * timestamp is the retry backoff: `online-if-uncached` probes again only once the row is five minutes old.
 * A caller that probes on every refresh whatever the cache holds (llama.cpp, so a server restart reaches
 * the catalog) gets nothing from the timestamp, and the rewrite cost it a WAL append and an fsync on every
 * launch with the server down. `failureRestartsBackoff: false` makes the failure write only when the row's
 * content changes.
 *
 * Pinned through the real manager and a real database file: the unchanged case leaves the file byte for
 * byte as it was, the changed case still records the change, and the default still restarts the backoff.
 *
 * WHAT IT DOES NOT CATCH: which callers pass the option. The coding-agent suite on a discovery endpoint
 * that stays down sweeps every discovery type for that.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { buildModel } from "../src/build";
import { readModelCache, writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";

/** A provider no models.dev descriptor maps, so a refresh reaches no network. */
const PROVIDER = "local-runtime";

describe("a failed probe", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `veyyon-failed-probe-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	async function failAt(at: number, failureRestartsBackoff?: boolean): Promise<void> {
		await resolveProviderModels(
			{
				providerId: PROVIDER,
				staticModels: [],
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => null,
				now: () => at,
				...(failureRestartsBackoff === undefined ? {} : { failureRestartsBackoff }),
			},
			"online",
		);
	}

	function stampOfRow(): number | undefined {
		return readModelCache(PROVIDER, Number.POSITIVE_INFINITY, () => 0, dbPath)?.updatedAt;
	}

	it("leaves the database untouched when it restarts no backoff and changes nothing", async () => {
		await failAt(1_000, false);
		expect(stampOfRow()).toBe(1_000);
		const before = fs.readFileSync(dbPath);

		await failAt(2_000, false);

		expect(stampOfRow()).toBe(1_000);
		expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
	});

	it("records a change in what the row states even when it restarts no backoff", async () => {
		const served = buildModel({
			id: "served-model",
			name: "served-model",
			provider: PROVIDER,
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		});
		writeModelCache(PROVIDER, 1_000, [served], true, "", dbPath);

		await failAt(2_000, false);

		const row = readModelCache(PROVIDER, Number.POSITIVE_INFINITY, () => 0, dbPath);
		expect(row?.authoritative).toBe(false);
		expect(row?.updatedAt).toBe(2_000);
		expect(row?.models.map(model => model.id)).toEqual(["served-model"]);
	});

	it("restamps an unchanged row by default, which restarts the backoff", async () => {
		await failAt(1_000);
		await failAt(2_000);

		expect(stampOfRow()).toBe(2_000);
	});
});
