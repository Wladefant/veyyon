/**
 * WHY: a legacy Pi extension's tool call reaches the real tool through
 * `TOOL_EXECUTION_ENTRIES["legacy.adapter"]`, and that boundary refuses to dispatch without a
 * session policy frame. The shim built each tool from a session and then invoked the entry with a
 * bare four-argument call, so every legacy tool call threw `Tool execution requires missing session
 * policy context` — `createCodingTools()` handed an extension tools that could not run at all.
 *
 * The class this closes: the shim dispatches with the frame of the session its tool was built from.
 * Every registry-backed entry point it exports — `createCodingTools`, `createReadTool`,
 * `createBashTool`, `createGrepTool`, `createFindTool` — carries that frame; the sweep below drives
 * the two that reach a tool without the native addon, which is every path a filesystem-only tool
 * needs. The control below keeps the fence itself load-bearing, so nobody can satisfy this suite by
 * relaxing the boundary instead of carrying a frame.
 *
 * What it does not catch: the `bash`, `grep` and `find` dispatch sites, which execute through
 * `veyyon_natives` and need `bun run ci:build:native` in the tree under test; a frame carrying an
 * unrelated session's settings; and a call the frame should refuse — the shim builds an isolated
 * settings set, so no operator denial reaches this route yet. `ls` needs no frame at all: it lists
 * the filesystem itself and never dispatches a registry tool.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	__resetLegacyPiResolutionCache,
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@veyyon/coding-agent/extensibility/plugins/legacy-pi-compat";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TOOL_EXECUTION_ENTRIES } from "@veyyon/coding-agent/tools/core/execution-registry";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { removeWithRetries } from "@veyyon/utils";

installLegacyPiSpecifierShim();

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

beforeEach(() => {
	// The resolver memoizes canonical lookups process-wide; a sibling suite's mocked
	// `Bun.resolveSync` must not be observed here as a resolved legacy scope.
	__resetLegacyPiResolutionCache();
});

/**
 * A legacy extension beside its own fixture file. The fixture reports each entry point's outcome as
 * text rather than letting the first failure abort the module, so one broken entry point names
 * itself in the assertion instead of hiding the other.
 */
const SWEEP_FIXTURE = [
	'import { dirname } from "node:path";',
	'import { fileURLToPath } from "node:url";',
	'import { createCodingTools, createReadTool } from "@earendil-works/pi-coding-agent";',
	"const cwd = dirname(fileURLToPath(import.meta.url));",
	"const text = result =>",
	"\tresult.content",
	"\t\t.filter(block => block.type === 'text')",
	"\t\t.map(block => block.text)",
	"\t\t.join('\\n');",
	"const attempt = async run => {",
	"\ttry {",
	"\t\treturn text(await run());",
	"\t} catch (error) {",
	"\t\treturn `ERROR: ${error.message}`;",
	"\t}",
	"};",
	"const codingRead = createCodingTools(cwd).find(tool => tool.name === 'read');",
	"export const coding = await attempt(() => codingRead.execute('legacy-coding-read', { path: 'sample.txt' }));",
	"export const read = await attempt(() => createReadTool(cwd).execute('legacy-read', { path: 'sample.txt' }));",
].join("\n");

async function writeFixtureExtension(source: string, files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-legacy-tool-frame-"));
	tempRoots.push(dir);
	for (const [name, body] of Object.entries(files)) {
		await fs.writeFile(path.join(dir, name), body, "utf8");
	}
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("a legacy tool call carries the policy frame of its own session", () => {
	it("runs the entry points that reach a tool without the native addon", async () => {
		const entry = await writeFixtureExtension(SWEEP_FIXTURE, { "sample.txt": "legacy read body\n" });
		const loaded = (await loadLegacyPiModule(entry)) as { coding: string; read: string };

		expect(loaded.coding).toContain("legacy read body");
		expect(loaded.read).toContain("legacy read body");
	});

	it("refuses the same dispatch when no frame is offered", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-legacy-tool-frame-control-"));
		tempRoots.push(dir);
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};

		// The pre-fix call shape: the entry with no frame at all. It must keep refusing, so the
		// suite above can only pass by carrying a frame rather than by relaxing the fence.
		await expect(
			TOOL_EXECUTION_ENTRIES["legacy.adapter"].invoke(new ReadTool(session), "legacy-no-frame", {
				path: "sample.txt",
			}),
		).rejects.toThrow("missing session policy context");
	});
});
