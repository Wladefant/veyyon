/**
 * A workspace file another process holds a lease on is read, edited and written once the lease breaks,
 * instead of failing with `EAGAIN`.
 *
 * WHY THIS SUITE EXISTS. The kernel NFS server holds a lease on every file it has delegated to a client.
 * Bun opens with `O_NONBLOCK`, and such an open of a leased file fails at once with
 * "EAGAIN: resource temporarily unavailable, open '<path>'", while a `node:fs` open waits for the holder to
 * release the lease. On an exported tree `edit` failed that way whenever another machine had the file open,
 * and context discovery cached an `AGENTS.md` it could not open as absent. Each case here takes a real
 * `fcntl(F_SETLEASE)` lease in a separate process, renews it after every break, and drives the production
 * path a user reaches: every edit mode, the read tool, an LSP workspace edit and context discovery.
 *
 * THE CLASS is a production open of a workspace file that does not wait out a lease. A write lease
 * conflicts with every open, so the read and edit cases hold one; a read lease conflicts only with an open
 * for writing, so the LSP case holds that. Every case asserts the holder saw a break, so a path that never
 * opened the leased file, or a host where the lease never took, fails rather than passes.
 *
 * WHAT THIS DOES NOT CATCH. A path not driven here; `scripts/a-file-open-waits-out-a-lease.test.ts` sweeps
 * the shipped source for every non-blocking open instead. The holder renews its lease after each break, so
 * an open that follows a release faster than the renewal sees no lease. Leases are Linux-only, so the suite
 * runs on Linux.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { readFile as readContextFile } from "@veyyon/coding-agent/discovery/capability/fs";
import { EditTool } from "@veyyon/coding-agent/edit";
import { applyTextEdits } from "@veyyon/coding-agent/lsp/edits";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { EDIT_MODES, type EditMode } from "@veyyon/coding-agent/utils/edit-mode";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { makeToolSession } from "./helpers/tool-session";

const ORIGINAL = ["def greet(name):", '    print("Hi")', "", "def farewell(name):", '    print("Bye")', ""].join("\n");
const GREETED = ORIGINAL.replace('    print("Hi")', '    print("Hello")');

/**
 * Takes the lease, prints `leased`, and on every break releases it, prints `broken` and takes it again as
 * soon as the file is closed, until killed.
 */
const HOLDER = `
import fcntl, os, signal, sys
kind = fcntl.F_RDLCK if sys.argv[2] == "read" else fcntl.F_WRLCK
fd = os.open(sys.argv[1], os.O_RDONLY)
def on_break(signum, frame):
    fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
    print("broken", flush=True)
signal.signal(signal.SIGIO, on_break)
fcntl.fcntl(fd, fcntl.F_SETLEASE, kind)
print("leased", flush=True)
while True:
    if fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_UNLCK:
        try:
            fcntl.fcntl(fd, fcntl.F_SETLEASE, kind)
        except OSError:
            pass
`;

interface Lease {
	/** Stops the holder and returns how many times an open broke the lease. */
	release(): Promise<number>;
}

async function holdLease(file: string, kind: "read" | "write"): Promise<Lease> {
	const holder: ChildProcess = spawn("python3", ["-c", HOLDER, file, kind], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const exited = Promise.withResolvers<void>();
	const leased = Promise.withResolvers<void>();
	holder.stdout?.on("data", chunk => {
		stdout += String(chunk);
		if (stdout.includes("leased")) leased.resolve();
	});
	holder.stderr?.on("data", chunk => {
		stderr += String(chunk);
	});
	holder.on("error", error => leased.reject(error));
	holder.on("exit", code => {
		leased.reject(new Error(`lease holder exited with ${code} before taking the lease: ${stderr}`));
		exited.resolve();
	});
	await leased.promise;
	return {
		async release() {
			holder.kill("SIGKILL");
			await exited.promise;
			return stdout.split("\n").filter(line => line === "broken").length;
		},
	};
}

/** Runs `action` while `kind` lease is held on `file`, and fails unless an open broke the lease. */
async function underLease<T>(file: string, kind: "read" | "write", action: () => Promise<T>): Promise<T> {
	const lease = await holdLease(file, kind);
	let result: T;
	try {
		result = await action();
	} finally {
		const breaks = await lease.release();
		expect(breaks, "the path under test never opened the leased file").toBeGreaterThan(0);
	}
	return result;
}

let settingsState: SettingsTestState | undefined;
let tmpDir = "";

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "leased-file-"));
});

afterEach(async () => {
	if (tmpDir) {
		await removeWithRetries(tmpDir);
		tmpDir = "";
	}
});

function session(mode: EditMode = "hashline") {
	return makeToolSession({
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"lsp.formatOnWrite": false,
			"lsp.diagnosticsOnWrite": false,
			"read.summarize.enabled": false,
			"edit.mode": mode,
		}),
		enableLsp: false,
		getPlanModeState: () => ({ enabled: false }),
	}) as never;
}

function text(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function seed(name = "app.py"): Promise<string> {
	const file = path.join(tmpDir, name);
	await fs.writeFile(file, ORIGINAL);
	return file;
}

/** The arguments each edit mode takes for the same change; typed by mode, so a new mode is a build error here. */
const EDIT_ARGS: Record<EditMode, (file: string) => Promise<Record<string, unknown>>> = {
	replace: async file => ({ path: file, edits: [{ old_text: '    print("Hi")', new_text: '    print("Hello")' }] }),
	patch: async file => ({
		path: file,
		edits: [{ op: "update", diff: '@@ def greet(name):\n-    print("Hi")\n+    print("Hello")\n' }],
	}),
	apply_patch: async file => ({
		input: [
			"*** Begin Patch",
			`*** Update File: ${path.basename(file)}`,
			"@@ def greet(name):",
			'-    print("Hi")',
			'+    print("Hello")',
			"*** End Patch",
			"",
		].join("\n"),
	}),
	hashline: async file => {
		const read = await new ReadTool(session("hashline")).execute("read-for-tag", { path: file });
		const header = text(read).split("\n", 1)[0];
		return { input: [header, "SWAP 2.=2:", '+    print("Hello")'].join("\n") };
	},
};

describe.skipIf(process.platform !== "linux")("a leased workspace file", () => {
	it("makes a non-blocking open fail, so a green case below is a wait and not a missing lease", async () => {
		const file = await seed();
		const error = await underLease(file, "write", () =>
			Bun.file(file)
				.text()
				.then(
					() => null,
					caught => caught,
				),
		);
		expect(error).toMatchObject({ code: "EAGAIN" });
	});

	it("covers every edit mode", () => {
		expect(Object.keys(EDIT_ARGS).sort()).toEqual([...EDIT_MODES].sort());
	});

	for (const mode of EDIT_MODES) {
		it(`is edited in ${mode} mode while another process writes it`, async () => {
			const file = await seed();
			const args = await EDIT_ARGS[mode](file);
			await underLease(file, "write", () => new EditTool(session(mode)).execute(`edit-${mode}`, args as never));
			expect(await fs.readFile(file, "utf8")).toBe(GREETED);
		});
	}

	it("is read by the read tool while another process writes it, tag and block context included", async () => {
		const file = path.join(tmpDir, "app.py");
		const body = Array.from({ length: 10 }, (_, i) => `    print("Bye ${i}")`);
		await fs.writeFile(file, ["def farewell(name):", ...body, ""].join("\n"));
		// Line 9 sits past the leading padding, so `def farewell` appears only as block context, which is
		// drawn from the whole-file read; a failed whole-file read drops it without an error.
		const read = () => new ReadTool(session()).execute("read", { path: `${file}:9-9` });
		const unleased = text(await read());
		const leased = text(await underLease(file, "write", read));
		expect(unleased).toMatch(/^\[app\.py#[0-9A-F]{4}\]\n1:def farewell\(name\):/);
		expect(leased).toBe(unleased);
	});

	it("takes an LSP workspace edit while another process reads it", async () => {
		const file = await seed();
		await underLease(file, "read", () =>
			applyTextEdits(file, [
				{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 15 } }, newText: 'print("Hello")' },
			]),
		);
		expect(await fs.readFile(file, "utf8")).toBe(GREETED);
	});

	it("is found by context discovery while another process writes it", async () => {
		const file = path.join(tmpDir, "AGENTS.md");
		await fs.writeFile(file, "# Rules\n");
		expect(await underLease(file, "write", () => readContextFile(file))).toBe("# Rules\n");
	});
});
