import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { loadRuntimeMCPConfig } from "../src/mcp/runtime-config";

const execFileAsync = promisify(execFile);
const childOptions = { timeout: 5_000, killSignal: "SIGKILL" as const, maxBuffer: 64 * 1024 };
const loaderUrl = new URL("../src/mcp/runtime-config.ts", import.meta.url).href;
const loaderEntryMarker = "entered-runtime-mcp-loader\n";

// WHY: the old read-only open waits for a FIFO writer before fstat can reject
// the non-regular file. Keep this negative fixture in its own bounded child so
// a regression cannot strand a blocked filesystem worker in the test runner.
// The entry marker distinguishes a loader hang from an import/setup failure;
// neither a setup failure nor a post-entry non-timeout proves the old defect.
// The child inherits the admitted test sandbox; no isolation markers change.
for (const route of ["direct", "symlink"] as const) {
	test.skipIf(process.platform === "win32")(
		`run-only MCP input rejects a ${route} FIFO without waiting for a writer`,
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-fifo-"));
			const fifo = path.join(dir, "config.pipe");
			const input = route === "direct" ? fifo : path.join(dir, "mcp.json");
			try {
				await execFileAsync("mkfifo", ["-m", "600", fifo], childOptions);
				expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
				if (route === "symlink") await fs.symlink(fifo, input);

				// No writer is opened. Only the production loader decides whether
				// this input is a regular configuration file.
				const program = `
					import { loadRuntimeMCPConfig } from ${JSON.stringify(loaderUrl)};
					let failure;
					process.stdout.write(${JSON.stringify(loaderEntryMarker)});
					try {
						await loadRuntimeMCPConfig(${JSON.stringify(input)});
					} catch (error) {
						failure = error;
					}
					if (!(failure instanceof Error) || !failure.message.includes("must be a regular JSON file")) {
						throw new Error("FIFO input was not rejected as a non-regular configuration file");
					}
					process.stdout.write("rejected-non-regular\\n");
				`;
				const { stdout } = await execFileAsync(process.execPath, ["--eval", program], childOptions).catch(
					(error: unknown) => {
						const entered = error !== null && typeof error === "object" && "stdout" in error &&
							typeof error.stdout === "string" && error.stdout.startsWith(loaderEntryMarker);
						throw new Error(
							entered
								? "FIFO child failed after loader entry; inspect the cause for the intended blocking-open timeout"
								: "FIFO child failed before loader entry; this is not a valid blocking-open negative control",
							{ cause: error },
						);
					},
				);
				expect(stdout).toBe(`${loaderEntryMarker}rejected-non-regular\n`);
				expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
				if (route === "symlink") expect(await fs.readlink(input)).toBe(fifo);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		15_000,
	);
}

test.skipIf(process.platform === "win32")("run-only MCP input still accepts a symlink to a regular file", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-regular-link-"));
	const file = path.join(dir, "source.json");
	const link = path.join(dir, "mcp.json");
	const config = { mcpServers: { fixture: { type: "stdio", command: process.execPath } } };
	const original = JSON.stringify(config);
	try {
		await fs.writeFile(file, original);
		await fs.symlink(file, link);
		const loaded = await loadRuntimeMCPConfig(link);
		expect(loaded.path).toBe(link);
		expect(loaded.configs.fixture).toEqual(config.mcpServers.fixture);
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(await fs.readlink(link)).toBe(file);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
