/**
 * Most discovery directories a launch scans (extensions, skills, rules, commands under each config
 * root) are missing or empty, and the first native glob loads the native addon, about 2 ms of a print
 * turn. Both discovery scans, `loadFilesFromDir` and `discoverExtensionModulePaths`, answer a missing
 * or empty directory with a `readdir` and never reach the glob.
 *
 * Closes: a discovery scan that globs a directory with nothing in it, on either route. Also pins that
 * the probe is uncached, so a file written after an empty scan is found by the next one.
 * Does not catch: another startup path loading the addon for a reason unrelated to discovery.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import { discoverExtensionModulePaths, loadFilesFromDir } from "../../src/discovery/helpers";

const created: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-empty-discovery-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function scanMarkdown(dir: string): Promise<string[]> {
	const result = await loadFilesFromDir<string>(dir, "test-provider", "user", {
		extensions: ["md"],
		transform: name => name,
	});
	return result.items;
}

const routes: Array<[string, (dir: string) => Promise<string[]>, (dir: string) => string]> = [
	[
		"loadFilesFromDir",
		scanMarkdown,
		dir => {
			fs.writeFileSync(path.join(dir, "note.md"), "body");
			return "note.md";
		},
	],
	[
		"discoverExtensionModulePaths",
		discoverExtensionModulePaths,
		dir => {
			const file = path.join(dir, "ext.ts");
			fs.writeFileSync(file, "export default function () {}");
			return file;
		},
	],
];

describe.each(routes)("%s", (_name, scan, populate) => {
	it("answers a missing directory without the native glob", async () => {
		const globSpy = vi.spyOn(natives, "glob");
		expect(await scan(path.join(tempDir(), "absent"))).toEqual([]);
		expect(globSpy).not.toHaveBeenCalled();
	});

	it("answers an empty directory without the native glob", async () => {
		const globSpy = vi.spyOn(natives, "glob");
		expect(await scan(tempDir())).toEqual([]);
		expect(globSpy).not.toHaveBeenCalled();
	});

	it("globs a directory with an entry and finds a file written after an empty scan", async () => {
		const dir = tempDir();
		const globSpy = vi.spyOn(natives, "glob");
		expect(await scan(dir)).toEqual([]);
		const expected = populate(dir);
		expect(await scan(dir)).toEqual([expected]);
		expect(globSpy).toHaveBeenCalled();
	});
});
