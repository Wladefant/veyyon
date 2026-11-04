import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { initDb } from "@veyyon/stats/db";
import { getStatsDbPath } from "@veyyon/utils/dirs";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-corrupt-");

// stats.db also holds usage rows for sessions the GC archived (archive/sessions/*.jsonl.gz), which the
// session-file sync does not re-parse. Quarantining and rebuilding would drop that history, so a corrupt
// file must be left untouched and reported. https://github.com/Wladefant/veyyon/pull/477#issuecomment-5982791555
it("refuses to open a corrupt stats.db and leaves it untouched", async () => {
	const dbPath = getStatsDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const garbage = "this is not a database, it is a text file\n".repeat(64);
	fs.writeFileSync(dbPath, garbage);

	await expect(initDb()).rejects.toThrow(/not auto-recovered/);

	expect(fs.readFileSync(dbPath, "utf8")).toBe(garbage);
	const siblings = fs.readdirSync(path.dirname(dbPath)).filter(f => f.startsWith("stats.db"));
	expect(siblings).toEqual(["stats.db"]);
});
