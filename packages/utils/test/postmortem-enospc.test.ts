import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as postmortem from "../src/postmortem";

/**
 * ENOSPC errors must not terminate the host process. Disk-full writes from
 * logs, sessions, or artifacts are transient; killing Main discards every
 * running lane. See issue #73.
 */
function makeEnospc(syscall: string = "write"): Error {
	const err = new Error("ENOSPC: no space left on device, write");
	Object.assign(err, { code: "ENOSPC", syscall, errno: -4055 });
	return err;
}

describe("postmortem.isEnospc", () => {
	it("matches ENOSPC write error", () => {
		expect(postmortem.isEnospc(makeEnospc("write"))).toBe(true);
	});

	it("matches ENOSPC with any syscall", () => {
		expect(postmortem.isEnospc(makeEnospc("open"))).toBe(true);
	});

	it("matches ENOSPC without a syscall property", () => {
		const err = new Error("disk full");
		Object.assign(err, { code: "ENOSPC" });
		expect(postmortem.isEnospc(err)).toBe(true);
	});

	it("does not match EPIPE", () => {
		const err = new Error("broken pipe");
		Object.assign(err, { code: "EPIPE", syscall: "write" });
		expect(postmortem.isEnospc(err)).toBe(false);
	});

	it("does not match ENOENT", () => {
		const err = new Error("file not found");
		Object.assign(err, { code: "ENOENT", syscall: "open" });
		expect(postmortem.isEnospc(err)).toBe(false);
	});

	it("does not match a plain Error with no code", () => {
		expect(postmortem.isEnospc(new Error("boom"))).toBe(false);
	});

	it("returns false for null", () => {
		expect(postmortem.isEnospc(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(postmortem.isEnospc(undefined)).toBe(false);
	});

	it("returns false for a string", () => {
		expect(postmortem.isEnospc("ENOSPC")).toBe(false);
	});

	it("returns false for a number", () => {
		expect(postmortem.isEnospc(-4055)).toBe(false);
	});
});

// Subprocess integration: an ENOSPC rejection must not exit the process.
// These tests spawn real child processes to verify the global handler wiring.
const modulePath = fileURLToPath(new URL("../src/postmortem.ts", import.meta.url));

/**
 * Spawn a child that runs `code`, collect stdout, and return exit code + output.
 * Uses a real short delay in the child because the unhandledRejection handler
 * fires asynchronously on the microtask/next-tick boundary and fake timers
 * cannot control a separate process's event loop.
 */
function runChild(code: string): { code: number | null; output: string } {
	const result = spawnSync(process.execPath, ["-e", code], {
		encoding: "utf8",
		timeout: 5000,
	});
	return { code: result.status, output: result.stdout ?? "" };
}

describe("global ENOSPC routing", () => {
	it("unhandledRejection with ENOSPC does not exit the process", () => {
		const result = runChild(
			[
				`import ${JSON.stringify(modulePath)};`,
				`const err = new Error("ENOSPC: no space left on device, write");`,
				`Object.assign(err, { code: "ENOSPC", syscall: "write", errno: -4055 });`,
				`Promise.reject(err);`,
				// Real delay: the rejection handler fires on the microtask queue of
				// a separate process; fake timers cannot reach across processes.
				`setTimeout(() => { process.stdout.write("survived"); process.exit(0); }, 50);`,
			].join("\n"),
		);

		// The process should exit 0 (survived), not 1 (fatal unhandled rejection).
		expect(result.code).toBe(0);
		expect(result.output).toContain("survived");
	});

	it("uncaughtException with ENOSPC does not exit the process", () => {
		const result = runChild(
			[
				`import ${JSON.stringify(modulePath)};`,
				`const err = new Error("ENOSPC: no space left on device, write");`,
				`Object.assign(err, { code: "ENOSPC", syscall: "write", errno: -4055 });`,
				`process.emit("uncaughtException", err);`,
				// Real delay: same cross-process rationale as above.
				`setTimeout(() => { process.stdout.write("survived"); process.exit(0); }, 50);`,
			].join("\n"),
		);

		expect(result.code).toBe(0);
		expect(result.output).toContain("survived");
	});

	it("non-ENOSPC rejection still exits the process", () => {
		const result = runChild(
			[
				`import ${JSON.stringify(modulePath)};`,
				`Promise.reject(new Error("real bug"));`,
				// Real delay: cross-process event loop; the process should exit 1
				// before this fires.
				`setTimeout(() => { process.stdout.write("should-not-reach"); process.exit(0); }, 200);`,
			].join("\n"),
		);

		// The process should exit 1 (fatal), not 0.
		expect(result.code).toBe(1);
		expect(result.output).not.toContain("should-not-reach");
	});
});
