/**
 * WHY. On Linux the kernel kills a process at its cgroup's `memory.max`, which a
 * systemd slice or container often sets on an ANCESTOR of the process's own
 * cgroup (the leaf says `max`). A heartbeat that read only the leaf would record
 * no limit for exactly the deaths it exists to explain (veyyon#73).
 *
 * Closes: a limit missed because it sits above the leaf, a closer ancestor
 * shadowed by a looser one, `max` or junk read as a number, and a cgroup v1 or
 * unreadable host turning into a throw.
 * Leaves: the real /sys/fs/cgroup layout; the tree here is a fixture of it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readCgroupMemory } from "../src/commit-memory";

const roots: string[] = [];

/** A cgroup mount holding `levels` (relative dir -> counters), and a /proc file naming `self`. */
function mount(self: string | undefined, levels: Record<string, { current?: string; max?: string }>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgroup-"));
	roots.push(root);
	const cgroupRoot = path.join(root, "sys");
	for (const [dir, counters] of Object.entries(levels)) {
		const full = path.join(cgroupRoot, dir);
		fs.mkdirSync(full, { recursive: true });
		if (counters.current !== undefined) fs.writeFileSync(path.join(full, "memory.current"), `${counters.current}\n`);
		if (counters.max !== undefined) fs.writeFileSync(path.join(full, "memory.max"), `${counters.max}\n`);
	}
	const procCgroupFile = path.join(root, "proc-cgroup");
	if (self !== undefined) fs.writeFileSync(procCgroupFile, self);
	return { procCgroupFile, cgroupRoot };
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("the cgroup memory a process is held to", () => {
	it("is the limit of an ancestor when the process's own cgroup sets none", async () => {
		const sources = mount("0::/user.slice/app.scope\n", {
			"": { current: "9000", max: "max" },
			"user.slice": { current: "4000", max: "5000" },
			"user.slice/app.scope": { current: "3000", max: "max" },
		});
		expect(await readCgroupMemory(sources)).toEqual({ currentBytes: 4000, maxBytes: 5000 });
	});

	it("is the level with the least headroom, not the closest or the smallest limit", async () => {
		const sources = mount("0::/a/b\n", {
			a: { current: "100", max: "1000" },
			"a/b": { current: "500", max: "600" },
		});
		// Headroom: a has 900, a/b has 100. The leaf wins here...
		expect(await readCgroupMemory(sources)).toEqual({ currentBytes: 500, maxBytes: 600 });
		const reversed = mount("0::/a/b\n", {
			a: { current: "950", max: "1000" },
			"a/b": { current: "10", max: "600" },
		});
		// ...and the ancestor wins here, although its limit is the larger number.
		expect(await readCgroupMemory(reversed)).toEqual({ currentBytes: 950, maxBytes: 1000 });
	});

	it("is the process's own usage alone when no level has a numeric limit", async () => {
		const sources = mount("0::/a\n", { "": { max: "max" }, a: { current: "777", max: "max" } });
		expect(await readCgroupMemory(sources)).toEqual({ currentBytes: 777 });
	});

	it("is nothing on a host without cgroup v2 or without the files", async () => {
		expect(await readCgroupMemory(mount("12:memory:/legacy\n", {}))).toBeUndefined();
		expect(await readCgroupMemory(mount(undefined, {}))).toBeUndefined();
		expect(await readCgroupMemory(mount("0::/x\n", {}))).toBeUndefined();
	});

	it("ignores a cgroup path that climbs out of the mount", async () => {
		const sources = mount("0::/../../etc\n", { "": { current: "1", max: "2" } });
		expect(await readCgroupMemory(sources)).toBeUndefined();
	});
});
