import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract (issue: macOS libmalloc diagnostics painting into the TUI
 * viewport; mirrors openai/codex#24459): while suppression is active, fd-2
 * writes land in the redirect target instead of the previous stderr; restore
 * rejoins the saved stderr; without `force`, a stderr that is not the stdout
 * terminal (here: a pipe) is left untouched.
 *
 * Plus the half veyyon#73 turns on: whatever the CRASHING RUNTIME writes has to
 * reach the redirect target too, because that write happens after the process
 * has stopped running JavaScript and the terminal it would otherwise land on is
 * about to close. Which stderr that is differs by platform — fd 2 on POSIX, the
 * process standard-error handle on Windows — so the suite writes through the
 * real one for the platform it is on rather than assuming they are the same.
 *
 * Runs in a subprocess so the test suite's own fd 2 is never mutated.
 */

const GUARD_MODULE = path.resolve(import.meta.dir, "../src/stderr-guard.ts");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

/**
 * Write through the stderr an aborting runtime writes through, below the
 * JavaScript stream layer: the raw `write(2, …)` on POSIX, and `WriteFile` on
 * the standard-error handle on Windows, which is what Bun's panic printer
 * resolves. Rendered into the probe source, so the child does the writing.
 */
const NATIVE_STDERR_WRITE = [
	`import { dlopen, FFIType } from "bun:ffi";`,
	`function nativeStderrWrite(text: string): void {`,
	`	const bytes = Buffer.from(text, "utf8");`,
	`	if (process.platform === "win32") {`,
	`		const kernel32 = dlopen("kernel32.dll", {`,
	`			GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },`,
	`			WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },`,
	`		});`,
	`		const written = new Uint32Array(1);`,
	`		kernel32.symbols.WriteFile(kernel32.symbols.GetStdHandle(0xfffffff4), bytes, bytes.length, written, 0n);`,
	`		return;`,
	`	}`,
	`	const candidates = process.platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", "libc.so"];`,
	`	for (const candidate of candidates) {`,
	`		try {`,
	`			const libc = dlopen(candidate, { write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 } });`,
	`			libc.symbols.write(2, bytes, BigInt(bytes.length));`,
	`			return;`,
	`		} catch {}`,
	`	}`,
	`	throw new Error("no libc to write through");`,
	`}`,
].join("\n");

interface ProbeReport {
	platform: string;
	gateResult: boolean;
	forced: boolean;
	secondSuppress: boolean;
	suppressedWhileActive: boolean;
	suppressedAfterRestore: boolean;
}

interface ProbeRun {
	report: ProbeReport;
	/** What the parent saw on the child's stderr pipe. */
	stderr: string;
	/** What the guard captured, or `undefined` when no target was created. */
	redirect: string | undefined;
}

async function runProbe(body: string[]): Promise<ProbeRun> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-"));
	tempDirs.push(dir);
	const redirectPath = path.join(dir, "redirect.log");
	const probePath = path.join(dir, "probe.ts");
	fs.writeFileSync(
		probePath,
		[
			`import { isTerminalStderrSuppressed, restoreTerminalStderr, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
			`import * as fs from "node:fs";`,
			NATIVE_STDERR_WRITE,
			`const redirectPath = process.argv[2];`,
			...body,
		].join("\n"),
	);

	const proc = Bun.spawn([process.execPath, probePath, redirectPath], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr}`);
	return {
		report: JSON.parse(stdout) as ProbeReport,
		stderr,
		redirect: fs.existsSync(redirectPath) ? fs.readFileSync(redirectPath, "utf8") : undefined,
	};
}

const REPORT_LINE = [
	`process.stdout.write(JSON.stringify({`,
	`	platform: process.platform,`,
	`	gateResult,`,
	`	forced,`,
	`	secondSuppress,`,
	`	suppressedWhileActive,`,
	`	suppressedAfterRestore: isTerminalStderrSuppressed(),`,
	`}));`,
];

describe("stderr guard", () => {
	it("suppresses fd-2 writes only while active and refuses non-terminal stderr without force", async () => {
		const { report, stderr, redirect } = await runProbe([
			`fs.writeSync(2, "before\\n");`,
			`// stderr is a pipe here, so the same-terminal gate must refuse.`,
			`const gateResult = suppressTerminalStderr();`,
			`const forced = suppressTerminalStderr({ force: true, redirectPath });`,
			`const suppressedWhileActive = isTerminalStderrSuppressed();`,
			`if (forced) fs.writeSync(2, "hidden\\n");`,
			`// Idempotent while active: must not stack a second saved fd.`,
			`const secondSuppress = suppressTerminalStderr({ force: true, redirectPath });`,
			`restoreTerminalStderr();`,
			`fs.writeSync(2, "after\\n");`,
			`// Restore without active suppression is a no-op.`,
			`restoreTerminalStderr();`,
			`fs.writeSync(2, "still-visible\\n");`,
			...REPORT_LINE,
		]);

		// Piped stderr is not the stdout terminal → the non-forced gate refuses.
		expect(report.gateResult).toBe(false);
		expect(report.suppressedAfterRestore).toBe(false);

		if (!report.forced) {
			// The platform's fd ops are unavailable: the guard must stay inert and
			// every write must reach the original stderr.
			expect(stderr).toBe("before\nhidden\nafter\nstill-visible\n");
			expect(redirect).toBeUndefined();
			return;
		}
		expect(report.suppressedWhileActive).toBe(true);
		expect(report.secondSuppress).toBe(true);
		if (report.platform === "win32") {
			// Windows moves the crash-time standard handle and LEAVES fd 2 alone,
			// so an ordinary JS write keeps reaching the terminal. Redirecting fd 2
			// as well is not a stricter version of the same guard: Bun's fds are not
			// the CRT's, and dup2 over fd 2 kills the process on the next write.
			expect(stderr).toBe("before\nhidden\nafter\nstill-visible\n");
			expect(redirect).toBe("");
		} else {
			expect(stderr).toBe("before\nafter\nstill-visible\n");
			expect(redirect).toBe("hidden\n");
		}
	});

	it("captures what an aborting runtime writes, and gives that stderr back on restore", async () => {
		const { report, stderr, redirect } = await runProbe([
			`fs.writeSync(2, "before\\n");`,
			`const gateResult = suppressTerminalStderr();`,
			`const forced = suppressTerminalStderr({ force: true, redirectPath });`,
			`const secondSuppress = suppressTerminalStderr({ force: true, redirectPath });`,
			`const suppressedWhileActive = isTerminalStderrSuppressed();`,
			`nativeStderrWrite("native-while-active\\n");`,
			`restoreTerminalStderr();`,
			`nativeStderrWrite("native-after-restore\\n");`,
			...REPORT_LINE,
		]);

		expect(report.gateResult).toBe(false);
		if (!report.forced) {
			expect(stderr).toContain("native-while-active");
			expect(redirect).toBeUndefined();
			return;
		}

		// THE CONTRACT veyyon#73 TURNS ON, and it is the same sentence on every
		// platform: a trace written the way a dying runtime writes it is in the
		// redirect target and not on the terminal that is about to close.
		expect(redirect).toContain("native-while-active");
		expect(stderr).not.toContain("native-while-active");

		// And the guard gives that stderr back, so a crash report printed after
		// the TUI has released the terminal still reaches the person watching.
		expect(stderr).toContain("native-after-restore");
		expect(redirect).not.toContain("native-after-restore");
	});
});
