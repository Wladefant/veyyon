/**
 * WHY: glibc keeps a freed block below its mmap threshold inside its heap and returns only the heap's
 * top to the system. A Python eval kernel whose cell read files or responses of varying sizes kept
 * that peak resident after the cell dropped them, for as long as the kernel sat idle: 170 MB of a
 * 380 MB working set stayed resident here, and a bugbounty kernel held gigabytes. The runner now
 * returns the free pages of the heap before it reports a cell done.
 *
 * Closes: memory a finished cell freed through malloc staying resident in a kernel the host sees idle,
 * whatever allocated it (bytes, str, list storage, a C extension's buffers), read from outside the
 * kernel so a trim deferred to the next cell fails too.
 * Does not catch: memory a cell still references (the kernel keeps its namespace by contract),
 * pymalloc arenas pinned by a surviving small object, or an allocator other than glibc's, which is
 * why the suite runs on Linux only.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const pythonPath = Bun.env.PYTHON ?? "python3";
const runnerPath = path.resolve(import.meta.dir, "..", "runner.py");
const encoder = new TextEncoder();

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
	evalue?: string;
}

/** One runner process, driven one cell at a time; each cell's stdout is returned when its done frame arrives. */
function startRunner() {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let next = 0;

	async function readFrame(): Promise<RunnerFrame> {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				return JSON.parse(line) as RunnerFrame;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`Python runner exited before done frame: ${await stderr}`);
			pending += decoder.decode(value, { stream: true });
		}
	}

	return {
		/** Resident memory of the kernel process, in MiB, read from outside it. */
		rssMb(): number {
			const status = fs.readFileSync(`/proc/${proc.pid}/status`, "utf8");
			return Math.floor(Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) / 1024);
		},
		async run(code: string): Promise<string> {
			const id = `r${next++}`;
			proc.stdin.write(encoder.encode(`${JSON.stringify({ id, code })}\n`));
			proc.stdin.flush();
			let stdout = "";
			while (true) {
				const frame = await readFrame();
				if (frame.id !== id) continue;
				if (frame.type === "stdout") stdout += frame.data ?? "";
				if (frame.type === "error") throw new Error(`cell ${id} raised: ${frame.evalue}`);
				if (frame.type === "done") return stdout.trim();
			}
		},
		async close(): Promise<void> {
			try {
				reader.releaseLock();
			} catch {
				// Released by stream closure.
			}
			proc.kill("SIGKILL");
			await proc.exited;
		},
	};
}

const RSS_MB = "int(next(l for l in open('/proc/self/status') if l.startswith('VmRSS:')).split()[1]) // 1024";
const WORKING_SET = "[b'x' * (64 + (i * 7919) % 200_000) for i in range(4_000)]";

describe.skipIf(process.platform !== "linux")("an idle Python kernel", () => {
	it("has returned the heap a cell freed by the time the cell is reported done", async () => {
		const kernel = startRunner();
		try {
			await kernel.run("pass");
			const base = kernel.rssMb();
			const peak = Number(await kernel.run([`held = ${WORKING_SET}`, `print(${RSS_MB})`, "del held"].join("\n")));
			const idle = kernel.rssMb();
			// The working set is resident while the cell holds it, so a low idle reading is the trim.
			expect(peak - base).toBeGreaterThan(300);
			expect(idle - base).toBeLessThan((peak - base) / 4);
		} finally {
			await kernel.close();
		}
	});

	it("keeps what the namespace still references", async () => {
		const kernel = startRunner();
		try {
			await kernel.run("pass");
			const base = kernel.rssMb();
			await kernel.run(`kept = ${WORKING_SET}`);
			expect(kernel.rssMb() - base).toBeGreaterThan(300);
			expect(await kernel.run("print(sum(len(b) for b in kept) > 300_000_000)")).toBe("True");
		} finally {
			await kernel.close();
		}
	});
});
