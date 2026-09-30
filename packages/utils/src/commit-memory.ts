/**
 * The memory limits a process runs into before physical memory runs out.
 *
 * `os.freemem()` and the resident set say how much RAM is left. They do not say
 * how close the process is to being refused memory, and that is the figure a
 * silent death needs (veyyon#73, D06: "Out of Virtual Memory" with gigabytes of
 * RAM free).
 *
 * - Windows allocates against the commit limit, RAM plus pagefile. The native
 *   addon reads the system commit charge and limit and this process's private
 *   commit in-process; there is no JavaScript API for them and no tool is
 *   spawned.
 * - Linux kills against the cgroup's `memory.max`. It is read as files from the
 *   process's cgroup v2, and from every ancestor, because a systemd slice or a
 *   container sets the limit above the cgroup the process is in.
 *
 * Every reading is optional. A platform, kernel or addon without the source
 * returns nothing for it, and a caller never has to tell "unavailable" from a
 * failure: the heartbeat that carries it must not be a way to break a session.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readCommitMemory } from "@veyyon/natives";

/** What one reading yields; each field is absent where its source is. */
export interface MemoryLimits {
	/** Windows: committed bytes across the whole system. */
	commitChargeBytes?: number;
	/** Windows: the most the system can commit, RAM plus pagefile. */
	commitLimitBytes?: number;
	/** Windows: private committed bytes of this process (`PrivateUsage`). */
	processCommitBytes?: number;
	/**
	 * Linux: `memory.current` of the cgroup closest to its limit, or of the
	 * process's own cgroup when no level sets one.
	 */
	cgroupMemoryBytes?: number;
	/** Linux: the tightest numeric `memory.max` from the process's cgroup up to the root. */
	cgroupMemoryMaxBytes?: number;
}

/** The cgroup v2 reading alone. */
export interface CgroupMemory {
	currentBytes?: number;
	maxBytes?: number;
}

/** Where the cgroup files live; a test points it at a fixture tree. */
export interface CgroupSources {
	/** The file naming the process's cgroup, `/proc/self/cgroup`. */
	procCgroupFile: string;
	/** The cgroup v2 mount, `/sys/fs/cgroup`. */
	cgroupRoot: string;
}

const SYSTEM_CGROUP_SOURCES: CgroupSources = {
	procCgroupFile: "/proc/self/cgroup",
	cgroupRoot: "/sys/fs/cgroup",
};

/** A file's text, or `undefined` for any reason it cannot be read. */
async function readText(file: string): Promise<string | undefined> {
	try {
		return (await fsp.readFile(file, "utf8")).trim();
	} catch {
		return undefined;
	}
}

/** A cgroup counter: decimal bytes. `max`, empty and anything else is no number. */
function parseBytes(text: string | undefined): number | undefined {
	if (text === undefined || !/^\d+$/.test(text)) return undefined;
	return Number(text);
}

/**
 * The path segments of this process's cgroup v2 from `/proc/self/cgroup`, whose
 * unified-hierarchy line is `0::<path>`. `undefined` on a cgroup v1 host, where
 * that line does not exist.
 */
function cgroupSegments(procCgroup: string): string[] | undefined {
	for (const line of procCgroup.split("\n")) {
		if (!line.startsWith("0::")) continue;
		const segments = line
			.slice("0::".length)
			.replace(/ \(deleted\)$/, "")
			.split("/")
			.filter(segment => segment.length > 0);
		// A path that climbs out of the mount is not one the kernel wrote.
		if (segments.some(segment => segment === "." || segment === "..")) return undefined;
		return segments;
	}
	return undefined;
}

/**
 * Read the memory the process's cgroup is held to.
 *
 * The limit that matters is the one with the least headroom on the way from the
 * process's cgroup to the root, not necessarily its own (`max` there means "no
 * limit here", and a parent slice often sets one). Returns that level's
 * `memory.current` and `memory.max`. With no numeric limit anywhere it returns
 * the process's own `memory.current` alone; with nothing readable, `undefined`.
 */
export async function readCgroupMemory(
	sources: CgroupSources = SYSTEM_CGROUP_SOURCES,
): Promise<CgroupMemory | undefined> {
	const procCgroup = await readText(sources.procCgroupFile);
	if (procCgroup === undefined) return undefined;
	const segments = cgroupSegments(procCgroup);
	if (!segments) return undefined;

	let tightest: { currentBytes: number; maxBytes: number } | undefined;
	for (let depth = segments.length; depth >= 0; depth--) {
		const dir = path.join(sources.cgroupRoot, ...segments.slice(0, depth));
		const maxBytes = parseBytes(await readText(path.join(dir, "memory.max")));
		if (maxBytes === undefined) continue;
		const currentBytes = parseBytes(await readText(path.join(dir, "memory.current")));
		if (currentBytes === undefined) continue;
		if (!tightest || maxBytes - currentBytes < tightest.maxBytes - tightest.currentBytes) {
			tightest = { currentBytes, maxBytes };
		}
	}
	if (tightest) return tightest;

	const ownBytes = parseBytes(await readText(path.join(sources.cgroupRoot, ...segments, "memory.current")));
	return ownBytes === undefined ? undefined : { currentBytes: ownBytes };
}

/** Set once the addon cannot answer, so a session does not retry a load on every beat. */
let nativeUnavailable = false;

function readWindowsCommit(): MemoryLimits | undefined {
	if (nativeUnavailable) return undefined;
	try {
		const commit = readCommitMemory();
		if (!commit) return undefined;
		return {
			commitChargeBytes: commit.commitChargeBytes,
			commitLimitBytes: commit.commitLimitBytes,
			processCommitBytes: commit.processCommitBytes,
		};
	} catch {
		// An addon that does not carry the function, or does not load at all.
		nativeUnavailable = true;
		return undefined;
	}
}

/** Take the reading this platform can give; `{}` where it gives none. */
export async function readMemoryLimits(): Promise<MemoryLimits> {
	if (process.platform === "win32") return readWindowsCommit() ?? {};
	if (process.platform === "linux") {
		const cgroup = await readCgroupMemory();
		return {
			...(cgroup?.currentBytes !== undefined ? { cgroupMemoryBytes: cgroup.currentBytes } : {}),
			...(cgroup?.maxBytes !== undefined ? { cgroupMemoryMaxBytes: cgroup.maxBytes } : {}),
		};
	}
	return {};
}
