import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { hermeticSpawnEnv } from "./hermetic-spawn-env";

/**
 * Appended to every census entry. The report goes to a file and not to stdout: `process.exit` drops
 * whatever of a stdout write the pipe has not taken yet, and a census listing every evaluated module
 * path is larger than a pipe holds, so on a loaded host the parent received it cut mid-string. A
 * synchronous file write is complete before the exit. `node:fs` is required inside the function, so it
 * loads after the values the report carries were read.
 */
const REPORT_FUNCTION = `
function report(value) {
	require("node:fs").writeFileSync(process.env.MODULE_CENSUS_REPORT, JSON.stringify(value));
	process.exit(0);
}
`;

/**
 * Run a module census in its own Bun process and return its report.
 *
 * `source` is an entry that statically imports the modules under test, reads `require.cache`, and ends
 * by calling `report(value)`, which this function defines. ES module imports evaluate before the
 * importing body runs, so the body reads the cache with every module under test evaluated. The entry is
 * written to `dir`, which is also the process's working directory, under a hermetic home.
 */
export async function runModuleCensus<T>(dir: string, source: string): Promise<T> {
	const entry = path.join(dir, "census.ts");
	const reportPath = path.join(dir, "census.json");
	fs.writeFileSync(entry, `${source}\n${REPORT_FUNCTION}`);
	const { env, cleanup } = hermeticSpawnEnv({ MODULE_CENSUS_REPORT: reportPath });
	try {
		const child = spawn(process.execPath, [entry], { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const [code] = await once(child, "close");
		if (code !== 0) throw new Error(`census process exited ${code}:\n${stderr}`);
		return JSON.parse(fs.readFileSync(reportPath, "utf8")) as T;
	} finally {
		cleanup();
	}
}
