import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { detachedSpawnOptions, exec } from "../src/ptree";

// On Windows, Bun maps `detached: true` to DETACHED_PROCESS (no console), so every console
// grandchild allocates its own conhost and flashes a visible window. detachedSpawnOptions()
// must therefore keep a hidden, inheritable console there. The Windows case runs the real
// probe and counts grandchildren that got a console of their own.

describe("detachedSpawnOptions", () => {
	it("detaches on POSIX and hides the console", () => {
		expect(detachedSpawnOptions("linux")).toEqual({ detached: true, windowsHide: true });
		expect(detachedSpawnOptions("darwin")).toEqual({ detached: true, windowsHide: true });
	});

	it("never uses DETACHED_PROCESS on Windows", () => {
		expect(detachedSpawnOptions("win32")).toEqual({ detached: false, windowsHide: true });
	});
});

const python = Bun.which("python");
const probe = path.join(import.meta.dir, "../../coding-agent/scripts/console-window-probe.py");

describe.skipIf(process.platform !== "win32" || !python)("ptree.exec detached on Windows", () => {
	it("gives console grandchildren a shared console, not a new visible one", async () => {
		const result = await exec([python as string, probe], { detached: true });
		const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}") as {
			n: number;
			shared: number;
			new_console: number;
			hung: number;
		};
		expect(summary.new_console).toBe(0);
		expect(summary.hung).toBe(0);
		expect(summary.shared).toBe(summary.n);
	}, 120_000);
});
