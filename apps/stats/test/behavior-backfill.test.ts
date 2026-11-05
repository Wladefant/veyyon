import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { emptyUsage } from "@veyyon/catalog/models";
import { syncAllSessions } from "@veyyon/stats/aggregator";
import { closeDb, getBehaviorOverall, getFileOffset, initDb } from "@veyyon/stats/db";
import { getAgentDir, getStatsDbPath } from "@veyyon/utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-behavior-backfill-");

async function writeSessionFile(): Promise<string> {
	const sessionDir = path.join(getAgentDir(), "sessions", "--tmp--behavior-backfill");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const timestamp = new Date().toISOString();
	const user = {
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "PLEASE FIX THIS NOW" },
	};
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: "user-1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: { ...emptyUsage(), input: 1, output: 2, totalTokens: 3 },
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
	return sessionFile;
}

describe("behavior backfill", () => {
	it("retries when a failed compiled sync left old backfill sentinels behind", async () => {
		const sessionFile = await writeSessionFile();
		await initDb();
		closeDb();

		const stats = await fs.stat(sessionFile);
		const database = new Database(getStatsDbPath());
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_messages_v8", "1778589361860");
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_message_links_v1", "1778589361862");
		database
			.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)")
			.run(sessionFile, stats.size, stats.mtimeMs);
		database.close();

		const synced = await syncAllSessions();
		const behavior = getBehaviorOverall(null);

		expect(synced.files).toBe(1);
		expect(behavior.totalMessages).toBe(1);
		expect(behavior.totalYelling).toBe(1);
	});

	it("does not re-wipe existing progress when the backfill sentinel is already pending", async () => {
		const sessionFile = await writeSessionFile();
		await syncAllSessions();
		expect(getBehaviorOverall(null).totalMessages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
		closeDb();

		const database = new Database(getStatsDbPath());
		database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("user_messages_v8", "pending");
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_message_links_v1", "pending");
		database.close();

		await initDb();
		expect(getBehaviorOverall(null).totalMessages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
	});

	it("rebuilds a v3 user_messages table and refills it from the sessions", async () => {
		const sessionFile = await writeSessionFile();
		await syncAllSessions();
		closeDb();

		const database = new Database(getStatsDbPath());
		database.run("DROP TABLE user_messages");
		// The v3 shape: `yelling_sentences` before its rename, no negation, repetition or blame.
		database.run(`
			CREATE TABLE user_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				model TEXT,
				provider TEXT,
				chars INTEGER NOT NULL,
				words INTEGER NOT NULL,
				yelling_sentences INTEGER NOT NULL,
				profanity INTEGER NOT NULL,
				anguish INTEGER NOT NULL,
				UNIQUE(session_file, entry_id)
			)
		`);
		database
			.prepare(
				"INSERT INTO user_messages (session_file, entry_id, folder, timestamp, chars, words, yelling_sentences, profanity, anguish) VALUES (?, 'stale', '/', 1, 1, 1, 9, 0, 0)",
			)
			.run(sessionFile);
		database.run("DELETE FROM meta WHERE key = 'user_messages_v8'");
		database.close();

		await initDb();
		closeDb();
		const rebuilt = new Database(getStatsDbPath());
		const columns = (rebuilt.prepare("PRAGMA table_info(user_messages)").all() as { name: string }[]).map(
			c => c.name,
		);
		const indexes = (rebuilt.prepare("PRAGMA index_list(user_messages)").all() as { name: string }[])
			.map(i => i.name)
			.filter(name => name.startsWith("idx_"))
			.sort();
		const staleRows = rebuilt.prepare("SELECT COUNT(*) as n FROM user_messages WHERE entry_id = 'stale'").get() as {
			n: number;
		};
		rebuilt.close();

		expect(columns).toEqual([
			"id",
			"session_file",
			"entry_id",
			"folder",
			"timestamp",
			"model",
			"provider",
			"chars",
			"words",
			"yelling",
			"profanity",
			"anguish",
			"negation",
			"repetition",
			"blame",
		]);
		expect(indexes).toEqual(["idx_user_messages_timestamp", "idx_user_messages_timestamp_model"]);
		expect(staleRows.n).toBe(0);

		await syncAllSessions();
		expect(getBehaviorOverall(null).totalYelling).toBe(1);
	});
});
