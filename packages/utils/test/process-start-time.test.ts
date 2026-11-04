import { expect, it } from "bun:test";
import { getProcessStartTime, type ProcessIdentityDependencies } from "../src/process-liveness";

function dependencies(platform: NodeJS.Platform): ProcessIdentityDependencies {
	return {
		platform,
		readBoundedTextFile: () => null,
		querySystem: () => null,
		queryDarwinProcessStart: () => null,
		queryWindowsProcessStart: () => null,
	};
}

it("converts Windows FILETIME creation timestamps to Unix milliseconds", () => {
	const deps = dependencies("win32");
	deps.queryWindowsProcessStart = () => "133444736000000000";
	expect(getProcessStartTime(42, deps)).toBe(1_700_000_000_000);
});

it("converts Darwin seconds and microseconds without decimal padding assumptions", () => {
	const deps = dependencies("darwin");
	deps.querySystem = () => "{ sec = 1600000000, usec = 0 }";
	deps.queryDarwinProcessStart = () => "1700000000.42";
	expect(getProcessStartTime(42, deps)).toBe(1_700_000_000_000.042);
});

it("uses Linux boot time and the OS clock-tick rate rather than guessing a rate", () => {
	const deps = dependencies("linux");
	deps.readBoundedTextFile = file => {
		if (file === "/proc/sys/kernel/random/boot_id") return "12345678-1234-1234-1234-123456789abc";
		if (file === "/proc/stat") return "cpu 1 2 3\nbtime 1700000000\n";
		if (file === "/proc/42/stat") return `42 (worker) S ${Array(18).fill("0").join(" ")} 500`;
		return null;
	};
	deps.querySystem = () => "250\n";
	expect(getProcessStartTime(42, deps)).toBe(1_700_000_002_000);
	deps.querySystem = () => null;
	expect(getProcessStartTime(42, deps)).toBeNull();
});

it("rejects a process incarnation that changes during the timestamp query", () => {
	const deps = dependencies("win32");
	let calls = 0;
	deps.queryWindowsProcessStart = () => String(133444736000000000n + BigInt(calls++));
	expect(getProcessStartTime(42, deps)).toBeNull();
});
