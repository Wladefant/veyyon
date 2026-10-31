/**
 * Most discovery directories a launch scans (extensions, skills, rules, commands under each config
 * root) are missing or empty, and the first native glob loads the native addon, about 2 ms of a print
 * turn. Both discovery scans, `loadFilesFromDir` and `discoverExtensionModulePaths`, answer a missing
 * or empty directory with a `readdir` and never reach the glob.
 *
 * Each case runs the scan in a child bun with `VEYYON_DEBUG_STARTUP` set, so the addon loader writes
 * `native:loadNative:start` to stderr the moment it loads. A scan that leaves the addon unloaded writes
 * no marker; the populated case writes one, which proves the marker observes the glob route.
 *
 * Closes: a discovery scan that globs a directory with nothing in it, on either route. Also pins that
 * the probe is uncached, so a file written after an empty scan is found by the next one.
 * Does not catch: another startup path loading the addon for a reason unrelated to discovery.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const HELPERS_URL = pathToFileURL(path.resolve(import.meta.dirname, "../../src/discovery/helpers.ts")).href;
const LOAD_MARKER = "native:loadNative:start";

const created: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-empty-discovery-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Route {
	/** A child-process expression `(dir) => Promise<unknown[]>` over the imported `helpers`. */
	readonly scan: string;
	readonly file: string;
	readonly body: string;
	readonly found: (dir: string) => string;
}

const routes: Array<[string, Route]> = [
	[
		"loadFilesFromDir",
		{
			scan: `dir => helpers.loadFilesFromDir(dir, "test-provider", "user", { extensions: ["md"], transform: name => name }).then(result => result.items)`,
			file: "note.md",
			body: "body",
			found: () => "note.md",
		},
	],
	[
		"discoverExtensionModulePaths",
		{
			scan: "dir => helpers.discoverExtensionModulePaths(dir)",
			file: "ext.ts",
			body: "export default function () {}",
			found: dir => path.join(dir, "ext.ts"),
		},
	],
];

interface ChildRun {
	readonly scans: unknown[][];
	readonly addonLoads: number;
}

/**
 * Scan `targets` in order in one child process. A target of `{ write }` writes the route's file into
 * that directory instead of scanning, so a later scan of it sees the new entry.
 */
async function runScans(route: Route, targets: Array<string | { write: string }>): Promise<ChildRun> {
	const snippet = `
import * as fs from "node:fs";
import * as path from "node:path";
import * as helpers from ${JSON.stringify(HELPERS_URL)};
const scan = ${route.scan};
const scans = [];
for (const target of ${JSON.stringify(targets)}) {
	if (typeof target === "string") scans.push(await scan(target));
	else fs.writeFileSync(path.join(target.write, ${JSON.stringify(route.file)}), ${JSON.stringify(route.body)});
}
process.stdout.write(JSON.stringify(scans));
`;
	const hermetic = hermeticSpawnEnv({ VEYYON_DEBUG_STARTUP: "1" });
	const child = Bun.spawn([process.execPath, "-e", snippet], {
		env: hermetic.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]).finally(hermetic.cleanup);
	expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
	return { scans: JSON.parse(stdout) as unknown[][], addonLoads: stderr.split(LOAD_MARKER).length - 1 };
}

describe.each(routes)("%s", (_name, route) => {
	it("answers a missing directory without loading the native addon", async () => {
		expect(await runScans(route, [path.join(tempDir(), "absent")])).toEqual({ scans: [[]], addonLoads: 0 });
	});

	it("answers an empty directory without loading the native addon", async () => {
		expect(await runScans(route, [tempDir()])).toEqual({ scans: [[]], addonLoads: 0 });
	});

	it("globs a directory with an entry and finds a file written after an empty scan", async () => {
		const dir = tempDir();
		expect(await runScans(route, [dir, { write: dir }, dir])).toEqual({
			scans: [[], [route.found(dir)]],
			addonLoads: 1,
		});
	});
});
