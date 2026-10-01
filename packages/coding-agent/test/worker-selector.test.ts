import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { runCli } from "../src/cli";

// The worker-host re-entry seam dispatches any `__veyyon_worker_*` selector to
// `runWorkerEntrypoint`. An unrecognized selector must fail loudly rather than
// exit 0 with empty output, so a stale/mistyped selector cannot look healthy to
// a parent process or install smoke path.
describe("worker selector dispatch", () => {
	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	it("fails with a nonzero exit and stderr error on an unknown selector", async () => {
		const chunks: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		});

		await runCli(["__veyyon_worker_does_not_exist"]);

		expect(process.exitCode).toBe(1);
		expect(chunks.join("")).toBe("Error: unknown worker selector: __veyyon_worker_does_not_exist\n");
	});

	it("leaves normal root flags untouched", async () => {
		const outChunks: string[] = [];
		const errChunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			outChunks.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			errChunks.push(String(chunk));
			return true;
		});

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(outChunks.length).toBeGreaterThan(0);
		expect(errChunks.join("")).not.toContain("unknown worker selector");
	});
});
