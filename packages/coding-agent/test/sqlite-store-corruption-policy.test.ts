import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { buildModel } from "@veyyon/catalog/build";
import { readModelCache, writeModelCache } from "@veyyon/catalog/model-cache";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { openMemoryDb } from "../src/memory/storage";
import { TempDir } from "@veyyon/utils";

/**
 * Corruption policy per store class (https://github.com/Wladefant/veyyon/issues/467).
 *
 * Rebuildable caches quarantine a corrupt file and start empty. Durable stores
 * leave the file untouched and refuse to open, so no history is silently lost.
 */
const GARBAGE = "this is not a database, it is a text file\n".repeat(64);

let tempDir: TempDir | null = null;

beforeEach(() => {
	HistoryStorage.resetInstance();
	tempDir = TempDir.createSync("@veyyon-sqlite-policy-");
});

afterEach(async () => {
	HistoryStorage.resetInstance();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("rebuildable cache: model cache", () => {
	it("quarantines a corrupt file and serves a working empty cache", () => {
		const dbPath = tempDir!.join("models.db");
		fs.writeFileSync(dbPath, GARBAGE);
		const model = buildModel({
			id: "m1",
			name: "M1",
			api: "openai-completions",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});
		writeModelCache("ollama-cloud", 1000, [model], true, "fp", dbPath);
		const entry = readModelCache("ollama-cloud", 60_000, () => 1500, dbPath);
		expect(entry?.models.map(m => m.id)).toEqual(["m1"]);
		const quarantined = fs.readdirSync(tempDir!.path()).filter(f => f.startsWith("models.db") && f !== "models.db");
		expect(quarantined.length).toBeGreaterThan(0);
	});
});

describe("durable store: prompt history", () => {
	it("refuses to open a corrupt file and leaves its bytes untouched", () => {
		const dbPath = tempDir!.join("history.db");
		fs.writeFileSync(dbPath, GARBAGE);
		expect(() => HistoryStorage.open(dbPath)).toThrow(/not auto-recovered/);
		expect(fs.readFileSync(dbPath, "utf8")).toBe(GARBAGE);
		expect(fs.readdirSync(tempDir!.path())).toEqual(["history.db"]);
	});
});

describe("shared durable file: memory tables in agent.db", () => {
	it("fails closed instead of quarantining credentials that share the file", () => {
		const dbPath = tempDir!.join("agent.db");
		fs.writeFileSync(dbPath, GARBAGE);
		expect(() => openMemoryDb(dbPath)).toThrow(/not auto-recovered/);
		expect(fs.readFileSync(dbPath, "utf8")).toBe(GARBAGE);
		expect(fs.readdirSync(tempDir!.path())).toEqual(["agent.db"]);
	});
});
