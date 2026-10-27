/**
 * WHY THIS SUITE EXISTS. Each eval kernel runs a runner script published into
 * `<tmpdir>/veyyon-<language>-runner/`, and the publisher remembered that path for the life of the
 * process. A temp cleaner that removed the file (a tmpfs wiped on a schedule, `systemd-tmpfiles`
 * ageing) left every later kernel start in that process launching its interpreter on a missing
 * script: the interpreter exited before its first frame, and every Python cell after a reset came
 * back as an empty cancelled result with no exit code.
 *
 * THE CLASS THIS CLOSES: a file the process placed in a shared temp directory is assumed to still be
 * there, or to be whole when another process finds it. Python, Ruby and Julia publish through the one
 * `createRunnerScriptPublisher` (kernel-shared-budgets.test.ts pins that each kernel imports it), so
 * the publisher arms cover all three; the end-to-end arm drives Python, the interpreter CI carries.
 *
 * WHAT THIS DOES NOT CATCH: a file removed between the presence check and the interpreter opening it,
 * a window of one spawn. That start fails, and a-kernel-that-cannot-start-says-why.test.ts pins that
 * it fails with the runner's exit code rather than as a cancellation.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunnerScriptPublisher, kernelRunnerCacheDir } from "@veyyon/coding-agent/eval/kernel-base";
import { TempDir } from "@veyyon/utils";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

/** A language name of this run's own, so the arms never touch a runner directory a live kernel uses. */
function isolatedLanguage(): string {
	return `runner-removal-${crypto.randomUUID()}`;
}

const cleanupPaths: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const entry of cleanupPaths.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

function publisherFor(language: string, script: string): () => Promise<string> {
	cleanupPaths.push(kernelRunnerCacheDir(os.tmpdir(), language));
	return createRunnerScriptPublisher(language, script, "py");
}

describe("the runner script publisher", () => {
	it("writes the script again when the file was removed after the first start", async () => {
		const script = "print('runner')\n";
		const publish = publisherFor(isolatedLanguage(), script);
		const first = await publish();

		fs.rmSync(first);
		expect(await publish()).toBe(first);
		expect(fs.readFileSync(first, "utf8")).toBe(script);

		fs.rmSync(path.dirname(first), { recursive: true });
		expect(await publish()).toBe(first);
		expect(fs.readFileSync(first, "utf8")).toBe(script);
	});

	it("leaves only the script when several processes publish it at once", async () => {
		const language = isolatedLanguage();
		const script = `# ${"x".repeat(1 << 20)}\n`;
		// One publisher per simulated process: each holds its own view, as separate processes do.
		const paths = await Promise.all(Array.from({ length: 8 }, () => publisherFor(language, script)()));

		expect(new Set(paths).size).toBe(1);
		expect(fs.readdirSync(path.dirname(paths[0]))).toEqual([path.basename(paths[0])]);
		expect(fs.readFileSync(paths[0], "utf8")).toBe(script);
	});

	it("keeps the script a concurrent publisher renamed into place first", async () => {
		const script = "print('runner')\n";
		const publish = publisherFor(isolatedLanguage(), script);
		// Windows refuses to replace a script an interpreter holds open: the other publisher's file is there.
		vi.spyOn(fs.promises, "rename").mockImplementation(async (_from, to) => {
			fs.writeFileSync(to, script);
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		});

		const target = await publish();

		expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
		expect(fs.readFileSync(target, "utf8")).toBe(script);
	});

	it("fails when the rename fails and no script is there", async () => {
		const language = isolatedLanguage();
		const publish = publisherFor(language, "print('runner')\n");
		vi.spyOn(fs.promises, "rename").mockRejectedValue(
			Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" }),
		);

		await expect(publish()).rejects.toThrow("EACCES: permission denied, rename");
		// The staging file goes with the failure; a later start writes the script afresh.
		expect(fs.readdirSync(kernelRunnerCacheDir(os.tmpdir(), language))).toEqual([]);
	});

	it("never shows another process a partly written script", async () => {
		const script = `# ${"x".repeat(8 << 20)}\n`;
		const publish = publisherFor(isolatedLanguage(), script);
		const target = await publish();
		fs.rmSync(target);
		const stopFile = `${path.dirname(target)}.stop`;
		cleanupPaths.push(stopFile);

		// A separate process polls the path the way an interpreter opening it would, and counts every
		// time it finds the file at a size other than the whole script.
		const watcher = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require("node:fs");
				const [target, stop, size] = process.argv.slice(1);
				let partial = 0;
				let seen = 0;
				process.stdout.write("ready\\n");
				for (let i = 0; ; i++) {
					try {
						const found = fs.statSync(target).size;
						seen++;
						if (found !== Number(size)) partial++;
					} catch {}
					if (i % 256 === 0 && fs.existsSync(stop)) break;
				}
				process.stdout.write(JSON.stringify({ partial, seen }));`,
				target,
				stopFile,
				String(Buffer.byteLength(script)),
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let report = "";
		const ready = Promise.withResolvers<void>();
		watcher.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			report += chunk;
			if (report.includes("ready\n")) ready.resolve();
		});
		const closed = once(watcher, "close");
		await ready.promise;

		for (let round = 0; round < 10; round++) {
			await publish();
			fs.rmSync(target);
		}
		await publish();
		fs.writeFileSync(stopFile, "");
		const [code] = await closed;

		expect(code).toBe(0);
		const { partial, seen } = JSON.parse(report.slice(report.indexOf("\n") + 1)) as {
			partial: number;
			seen: number;
		};
		expect(seen).toBeGreaterThan(0);
		expect(partial).toBe(0);
	});
});

describeRequiringTool("python3", "a Python cell after the runner script was removed", () => {
	it("runs on a kernel started from the script written again", async () => {
		using tempDir = TempDir.createSync("@runner-removed-");
		const tmp = path.join(tempDir.path(), "tmp");
		fs.mkdirSync(tmp);
		const reportPath = path.join(tempDir.path(), "report.json");
		const entry = path.join(tempDir.path(), "entry.ts");
		// Its own TMPDIR, so removing the runner directory cannot reach a kernel another process runs.
		fs.writeFileSync(
			entry,
			`import * as fs from "node:fs";
import * as os from "node:os";
import { kernelRunnerCacheDir } from ${JSON.stringify(path.join(SRC, "eval", "kernel-base.ts"))};
import { disposeAllKernelSessions, executePython } from ${JSON.stringify(path.join(SRC, "eval", "py", "executor.ts"))};
const options = { cwd: process.cwd(), sessionId: "runner-removed" };
const cell = async (code, reset) => {
	const result = await executePython(code, { ...options, reset });
	return { exitCode: result.exitCode ?? null, cancelled: result.cancelled, output: result.output.trim() };
};
const before = await cell("print('before')", false);
fs.rmSync(kernelRunnerCacheDir(os.tmpdir(), "python"), { recursive: true, force: true });
const after = await cell("print('after')", true);
await disposeAllKernelSessions();
fs.writeFileSync(process.env.RUNNER_REMOVED_REPORT, JSON.stringify({ before, after }));
process.exit(0);
`,
		);
		const { env, cleanup } = hermeticSpawnEnv({ TMPDIR: tmp, RUNNER_REMOVED_REPORT: reportPath });
		try {
			const child = spawn(process.execPath, [entry], {
				cwd: tempDir.path(),
				env,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const [code] = await once(child, "close");
			expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
		} finally {
			cleanup();
		}

		expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual({
			before: { exitCode: 0, cancelled: false, output: "before" },
			after: { exitCode: 0, cancelled: false, output: "after" },
		});
	}, 60_000);
});
