import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { mnemopiBackend } from "@veyyon/coding-agent/memory/mnemopi/backend";
import { loadMnemopiConfig } from "@veyyon/coding-agent/memory/mnemopi/config";
import {
	dedupeScopedTargets,
	getMnemopiScopedBanks,
	getMnemopiScopedDbPaths,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
} from "@veyyon/coding-agent/memory/mnemopi/state";
import { initBeam } from "@veyyon/mnemopi/core/beam";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: the session's banks and the stats readers open the same Mnemopi store with different options, and
 * both options were untested. A session bank must link related memories exactly when
 * `mnemopi.proactiveLinking` says so. A stats reader must open with `reconcile: false`: reconciling
 * wipes every embedding stamped with another model and starts an asynchronous rebuild, and a stats reader
 * closes before that rebuild finishes, so reading stats after an embedding-model change would delete the
 * vectors and never write them back.
 *
 * Both callers build the store through `createBankMemory`. The class this closes is an option one caller
 * needs that the shared builder drops or overrides, on any bank the caller opens: each case sweeps every
 * bank the per-project-tagged scoping opens (the project bank and the shared bank).
 *
 * What this does not catch: options neither caller sets, and the `status` hook, which reads the live
 * session's banks rather than opening stats readers.
 */

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const roots: TempDir[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await root.remove();
});

function settingsFor(overrides: Record<string, unknown>): { settings: Settings; root: TempDir } {
	const root = TempDir.createSync("mnemopi-bank-open-");
	roots.push(root);
	const settings = Settings.isolated({
		"mnemopi.dbPath": root.join("mnemopi.db"),
		"mnemopi.scoping": "per-project-tagged",
		"mnemopi.autoRecall": false,
		"mnemopi.autoRetain": false,
		...overrides,
	});
	return { settings, root };
}

function relatedEdges(db: Database, source: string, target: string): number {
	const row = db
		.query(
			"SELECT COUNT(*) AS n FROM graph_edges WHERE edge_type = 'related_to' AND ((source = ? AND target = ?) OR (source = ? AND target = ?))",
		)
		.get(source, target, target, source) as { n: number };
	return row.n;
}

describe("a session's memory banks", () => {
	for (const proactiveLinking of [true, false]) {
		it(`link related memories ${proactiveLinking ? "when" : "only when"} proactive linking is ${proactiveLinking ? "on" : "off"}`, async () => {
			const { settings, root } = settingsFor({
				"mnemopi.proactiveLinking": proactiveLinking,
				"mnemopi.noEmbeddings": true,
			});
			const config = loadMnemopiConfig(settings, root.path());
			const state = new MnemopiSessionState({
				sessionId: "mnemopi-bank-linking",
				config,
				session: { sessionId: "mnemopi-bank-linking", settings } as never,
			});
			try {
				const targets = dedupeScopedTargets([state.getScopedRetainTarget(), ...state.getScopedRecallTargets()]);
				expect(targets.map(target => target.bank).sort()).toEqual([...getMnemopiScopedBanks(config)].sort());
				expect(targets).toHaveLength(2);
				for (const { memory } of targets) {
					const first = memory.remember("Database indexing improves query performance significantly", {
						importance: 0.8,
					});
					const second = memory.remember("Database indexing optimizes query performance and efficiency", {
						importance: 0.8,
					});
					expect(relatedEdges(memory.conn, first, second) > 0).toBe(proactiveLinking);
				}
			} finally {
				await state.dispose({ consolidate: false });
			}
		});
	}
});

describe("reading memory stats", () => {
	const STORED_MODEL = "BAAI/bge-small-en-v1.5";
	const CONFIGURED_MODEL = "intfloat/multilingual-e5-large";

	function seedBank(dbPath: string): void {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		try {
			initBeam(db);
			const ts = new Date().toISOString();
			db.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES ('wm-1', 'alpha working memory', 'test', ?, 'default')",
			).run(ts);
			db.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, binary_vector) VALUES ('ep-1', 'beta episodic memory', 'test', ?, 'default', ?)",
			).run(ts, new Uint8Array([1, 2, 3, 4]));
			for (const id of ["wm-1", "ep-1"]) {
				db.prepare(
					"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0,0,0]', ?)",
				).run(id, STORED_MODEL);
			}
		} finally {
			db.close();
		}
	}

	it("keeps every bank's embeddings after the embedding model changed", async () => {
		const { settings, root } = settingsFor({
			"mnemopi.noEmbeddings": false,
			"mnemopi.embeddingModel": CONFIGURED_MODEL,
		});
		const config = loadMnemopiConfig(settings, root.path());
		const banks = getMnemopiScopedBanks(config);
		const dbPaths = getMnemopiScopedDbPaths(config);
		expect(new Set(dbPaths).size).toBe(2);
		for (const dbPath of dbPaths) seedBank(dbPath);

		const rendered = await mnemopiBackend.stats?.(root.path(), root.path(), {
			sessionId: "mnemopi-stats-reader",
			settings,
		} as never);

		for (const bank of banks) expect(rendered).toContain(`| ${bank} | 1 | 1 |`);
		for (const dbPath of dbPaths) {
			const db = new Database(dbPath, { readonly: true });
			try {
				const embeddings = db.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all();
				expect(embeddings).toEqual([
					{ memory_id: "ep-1", model: STORED_MODEL },
					{ memory_id: "wm-1", model: STORED_MODEL },
				]);
				const episode = db.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
					v: Uint8Array | null;
				};
				expect(episode.v).not.toBeNull();
			} finally {
				db.close();
			}
		}
	});
});
