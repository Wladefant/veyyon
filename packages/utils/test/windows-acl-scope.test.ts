import { afterEach, describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { verifyOwnerOnlyWindowsAcl, withOwnerOnlyWindowsAclVerification } from "../src/windows-acl";

const originalRoot = process.env.SystemRoot;
const originalTimeout = process.env.VEYYON_WINDOWS_ACL_TIMEOUT_MS;
afterEach(() => {
	if (originalRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = originalRoot;
	if (originalTimeout === undefined) delete process.env.VEYYON_WINDOWS_ACL_TIMEOUT_MS;
	else process.env.VEYYON_WINDOWS_ACL_TIMEOUT_MS = originalTimeout;
});

type FakeProcess = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kills: number; closed: boolean };
function verifier(respond: (child: FakeProcess, id: string, target: string) => void, closeOnEnd = true) {
	process.env.SystemRoot = "C:\\Windows";
	const children: FakeProcess[] = [];
	const paths: string[] = [];
	const spawnProcess = (() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: 0, closed: false,
			kill() {
				child.kills++;
				queueMicrotask(() => child.emit("close", null, "SIGTERM"));
				return true;
			},
		});
		children.push(child);
		child.once("close", () => { child.closed = true; });
		child.stdin.on("data", (chunk: Buffer) => {
			const [id, encodedPath] = chunk.toString("utf8").trimEnd().split("\t");
			const target = Buffer.from(encodedPath, "base64").toString("utf8");
			paths.push(target);
			queueMicrotask(() => respond(child, id, target));
		});
		child.stdin.on("finish", () => {
			if (closeOnEnd) queueMicrotask(() => child.emit("close", 0, null));
		});
		return child as unknown as ChildProcessWithoutNullStreams;
	}) as typeof spawn;
	return { children, paths, options: { platform: "win32" as const, spawn: spawnProcess } };
}

describe("scan-scoped Windows ACL verifier", () => {
	it("reuses a process, preserves arbitrary path bytes, and closes before returning", async () => {
		const fixture = verifier((child, id) => {
			child.stdout.write(`${id}\tO`);
			child.stdout.write("K\r\n");
		});
		const targets = ["C:\\a'雪\n.json", "C:\\second.json"];
		await withOwnerOnlyWindowsAclVerification(async options => {
			for (const target of targets) await verifyOwnerOnlyWindowsAcl(target, options);
		}, fixture.options);
		expect(fixture.paths).toEqual(targets);
		expect(fixture.children).toHaveLength(1);
		expect(fixture.children[0].closed).toBe(true);
		expect(fixture.children[0].kills).toBe(0);
	});

	it("starts nothing for an empty scope and never shares a process across scopes", async () => {
		const fixture = verifier((child, id) => child.stdout.write(`${id}\tOK\n`));
		await withOwnerOnlyWindowsAclVerification(async () => {}, fixture.options);
		expect(fixture.children).toHaveLength(0);
		for (const target of ["C:\\one", "C:\\two"]) {
			await withOwnerOnlyWindowsAclVerification(options => verifyOwnerOnlyWindowsAcl(target, options), fixture.options);
		}
		expect(fixture.children).toHaveLength(2);
		expect(fixture.children.every(child => child.closed)).toBe(true);
	});

	it("keeps per-path ACL refusal separate from a broken verifier", async () => {
		const fixture = verifier((child, id, target) => {
			child.stdout.write(target.endsWith("bad")
				? `${id}\tERR\t${Buffer.from("ACL grants another identity access").toString("base64")}\n`
				: `${id}\tOK\n`);
		});
		await withOwnerOnlyWindowsAclVerification(async options => {
			await expect(verifyOwnerOnlyWindowsAcl("C:\\bad", options)).rejects.toThrow("another identity");
			await verifyOwnerOnlyWindowsAcl("C:\\good", options);
		}, fixture.options);
		expect(fixture.children).toHaveLength(1);
		expect(fixture.paths).toHaveLength(2);
	});

	for (const [name, response] of [
		["wrong response ID", (child: FakeProcess) => child.stdout.write("99\tOK\n")],
		["trailing frame", (child: FakeProcess, id: string) => child.stdout.write(`${id}\tOK\n${id}\tOK\n`)],
		["invalid base64", (child: FakeProcess, id: string) => child.stdout.write(`${id}\tERR\tA\n`)],
		["stderr", (child: FakeProcess) => child.stderr.write("unexpected")],
		["excess output", (child: FakeProcess) => child.stdout.write("x".repeat(16 * 1024 + 1))],
		["early exit", (child: FakeProcess) => child.emit("close", 1, null)],
	] as const) {
		it(`fails closed on ${name}`, async () => {
			const fixture = verifier(response);
			await expect(withOwnerOnlyWindowsAclVerification(
				options => verifyOwnerOnlyWindowsAcl("C:\\record", options), fixture.options,
			)).rejects.toThrow("Windows ACL");
			expect(fixture.children).toHaveLength(1);
			expect(fixture.children[0].closed).toBe(true);
		});
	}

	it("rejects a duplicate late OK instead of using it for a subsequent check", async () => {
		const fixture = verifier((child, id) => {
			child.stdout.write(`${id}\tOK\n`);
			child.stdout.write(`${id}\tOK\n`);
		});
		await expect(withOwnerOnlyWindowsAclVerification(async options => {
			await verifyOwnerOnlyWindowsAcl("C:\\first", options);
			await verifyOwnerOnlyWindowsAcl("C:\\second", options);
		}, fixture.options)).rejects.toThrow("unsolicited");
		expect(fixture.paths).toEqual(["C:\\first"]);
	});

	it("uses the configured timeout and never respawns after it", async () => {
		process.env.VEYYON_WINDOWS_ACL_TIMEOUT_MS = "20";
		const fixture = verifier(() => {});
		await expect(withOwnerOnlyWindowsAclVerification(async options => {
			await expect(verifyOwnerOnlyWindowsAcl("C:\\first", options)).rejects.toThrow("timed out");
			await expect(verifyOwnerOnlyWindowsAcl("C:\\second", options)).rejects.toThrow("timed out");
		}, fixture.options)).rejects.toThrow("timed out");
		expect(fixture.children).toHaveLength(1);
		expect(fixture.children[0].kills).toBe(1);
		expect(fixture.children[0].closed).toBe(true);
	});

	it("rejects concurrent requests rather than mixing their results", async () => {
		const fixture = verifier(() => {});
		await expect(withOwnerOnlyWindowsAclVerification(options => Promise.all([
			verifyOwnerOnlyWindowsAcl("C:\\first", options), verifyOwnerOnlyWindowsAcl("C:\\second", options),
		]), fixture.options)).rejects.toThrow("sequential");
		expect(fixture.children[0].kills).toBe(1);
	});

	it("preserves a callback failure while closing its process", async () => {
		const fixture = verifier((child, id) => child.stdout.write(`${id}\tOK\n`));
		const failure = new Error("caller refused the record");
		await expect(withOwnerOnlyWindowsAclVerification(async options => {
			await verifyOwnerOnlyWindowsAcl("C:\\record", options);
			throw failure;
		}, fixture.options)).rejects.toBe(failure);
		expect(fixture.children[0].closed).toBe(true);
	});

	it("bounds process shutdown and terminates only its own child", async () => {
		process.env.VEYYON_WINDOWS_ACL_TIMEOUT_MS = "20";
		const fixture = verifier((child, id) => child.stdout.write(`${id}\tOK\n`), false);
		await expect(withOwnerOnlyWindowsAclVerification(
			options => verifyOwnerOnlyWindowsAcl("C:\\record", options), fixture.options,
		)).rejects.toThrow("did not exit");
		expect(fixture.children[0].kills).toBe(1);
	});
});
