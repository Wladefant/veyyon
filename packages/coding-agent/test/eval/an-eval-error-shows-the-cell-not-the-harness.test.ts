/**
 * An eval error shows the cell, not the harness that ran it.
 *
 * WHY THIS SUITE EXISTS. Every Python error carried the three runner frames that dispatched the cell
 * (`_handle_request_async`, `_exec_source_async`, `_run_compiled_async`), and a cell that did not compile carried
 * those plus `ast.parse`, under a `<unknown>` file name. Every JS error carried the frames under the cell (`eval`,
 * the worker's `run` and dispatch), a thrown non-Error carried the host frames that rebuilt it as an Error, and
 * each cell was named by a UUID file. None of that is code the cell ran, and on a short error it was most of the
 * text. A chained Python exception also lost the blank line after its "direct cause" separator.
 *
 * The class: in each language a thrown error shows the frames from the cell's code inward, so what the cell called
 * stays, and nothing outward; an error with no cell frame shows its text alone. The shapes swept are a runtime
 * error, a library callee, a cell that did not compile, a chained exception, an async throw, a helper an earlier
 * cell defined, and a thrown non-Error.
 *
 * Not caught: the Ruby runner, which already keeps only its `(eval)` frames, and the Julia runner, which shows its
 * whole backtrace. Neither is swept here.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import { executeJs } from "@veyyon/coding-agent/eval/js/executor";
import { disposeKernelSessionsByOwner, executePython } from "@veyyon/coding-agent/eval/py/executor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();
setDefaultTimeout(60_000);

const OWNER = "eval-error-frames-suite";

afterAll(async () => {
	await Promise.all([disposeAllVmContexts(), disposeKernelSessionsByOwner(OWNER)]);
});

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "eval-error-frames",
		getEvalSessionId: () => "eval-error-frames",
	} as ToolSession;
}

/** Runs each cell in order in one fresh session, returning the last cell's result. */
async function runPython(...cells: string[]) {
	using tempDir = TempDir.createSync("@veyyon-eval-error-py-");
	const options = {
		cwd: tempDir.path(),
		sessionId: `eval-error-py:${crypto.randomUUID()}`,
		kernelOwnerId: OWNER,
		artifactsDir: path.join(tempDir.path(), "artifacts"),
	};
	let result = await executePython(cells[0]!, options);
	for (const cell of cells.slice(1)) result = await executePython(cell, options);
	return result;
}

async function runJs(...cells: string[]) {
	using tempDir = TempDir.createSync("@veyyon-eval-error-js-");
	const options = {
		cwd: tempDir.path(),
		sessionId: `eval-error-js:${crypto.randomUUID()}`,
		session: makeSession(tempDir.path()),
		kernelOwnerId: OWNER,
	};
	let result = await executeJs(cells[0]!, options);
	for (const cell of cells.slice(1)) result = await executeJs(cell, options);
	return result;
}

/** The `File "…"` lines of a Python traceback. */
function pythonFrames(output: string): string[] {
	return output.split("\n").filter(line => line.startsWith('  File "'));
}

/** A JS stack's frame lines with line and column dropped: those place code inside the cell wrapper. */
function jsFrames(output: string): string[] {
	return output
		.trimEnd()
		.split("\n")
		.filter(line => /^\s+at /.test(line))
		.map(line => line.replace(/:\d+:\d+\)$/, ")"));
}

describeRequiringTool("python3", "a Python error", () => {
	it("starts at the cell's first frame and shows no runner frame", async () => {
		const result = await runPython("def f():\n    return 1/0\nf()");
		expect(result.exitCode).toBe(1);
		expect(result.output).toBe(
			'Traceback (most recent call last):\n  File "<cell>", line 3, in <module>\n  File "<cell>", line 2, in f\nZeroDivisionError: division by zero\n',
		);
	});

	it("keeps the frames of the library code the cell called", async () => {
		const result = await runPython("import json\njson.loads('{')");
		expect(pythonFrames(result.output).map(line => line.replace(/^.*, in /, ""))).toEqual([
			"<module>",
			"loads",
			"decode",
			"raw_decode",
		]);
		expect(pythonFrames(result.output)[0]).toBe('  File "<cell>", line 2, in <module>');
		expect(result.output).toMatch(/\njson\.decoder\.JSONDecodeError: [^\n]+\n$/);
	});

	it("shows a cell that did not compile as the error at its line in the cell, with no frames", async () => {
		const result = await runPython("x = 1\ndef f(:\n    pass");
		expect(result.exitCode).toBe(1);
		const lines = result.output.trimEnd().split("\n");
		expect(lines[0]).toBe('  File "<cell>", line 2');
		expect(pythonFrames(result.output)).toEqual(['  File "<cell>", line 2']);
		expect(lines.at(-1)).toMatch(/^SyntaxError: /);
	});

	it("keeps the blank lines around a chained exception's separator", async () => {
		const result = await runPython(
			"try:\n    1/0\nexcept ZeroDivisionError as e:\n    raise ValueError('wrapped') from e",
		);
		expect(result.output).toBe(
			[
				"Traceback (most recent call last):",
				'  File "<cell>", line 2, in <module>',
				"ZeroDivisionError: division by zero",
				"",
				"The above exception was the direct cause of the following exception:",
				"",
				"Traceback (most recent call last):",
				'  File "<cell>", line 4, in <module>',
				"ValueError: wrapped",
				"",
			].join("\n"),
		);
	});
});

describe("a JS error", () => {
	it("ends at the cell's outermost frame and names the cell <cell>", async () => {
		const result = await runJs("function f() { throw new Error('boom') }\nf()");
		expect(result.exitCode).toBe(1);
		expect(result.output.split("\n")[0]).toBe("Error: boom");
		expect(jsFrames(result.output)).toEqual(["    at f (<cell>)", "    at <anonymous> (<cell>)"]);
	});

	it("keeps the async frames of the cell and nothing that awaited it", async () => {
		const result = await runJs("async function g() { await 0; throw new RangeError('late') }\nawait g()");
		expect(result.output.split("\n")[0]).toBe("RangeError: late");
		expect(jsFrames(result.output)).toEqual(["    at g (<cell>)", "    at async <anonymous> (<cell>)"]);
	});

	it("names a helper an earlier cell defined as a cell frame", async () => {
		const result = await runJs("function boom() { throw new Error('from earlier') }", "boom()");
		expect(result.output.split("\n")[0]).toBe("Error: from earlier");
		expect(jsFrames(result.output)).toEqual(["    at boom (<cell>)", "    at <anonymous> (<cell>)"]);
	});

	it("keeps the frames of the library code the cell called", async () => {
		const result = await runJs("[1].map(() => { throw new Error('in map') })");
		expect(result.output.split("\n")[0]).toBe("Error: in map");
		expect(jsFrames(result.output)).toEqual([
			"    at <anonymous> (<cell>)",
			"    at map (native)",
			"    at <anonymous> (<cell>)",
		]);
	});

	it("ends an awaited helper's error at the cell that awaited it", async () => {
		const result = await runJs("await read('definitely-missing.txt')");
		expect(result.output.split("\n")[0]).toMatch(/^Error: ENOENT/);
		expect(jsFrames(result.output).at(-1)).toBe("    at async <anonymous> (<cell>)");
	});

	it("shows a cell that did not parse as the error text alone", async () => {
		const result = await runJs("let x = ;");
		expect(result.exitCode).toBe(1);
		expect(result.output.trimEnd()).toBe("SyntaxError: Unexpected token ';'");
	});

	it("shows a thrown non-Error as its text, without the frames that rebuilt it", async () => {
		const result = await runJs("throw 'plain string'");
		expect(result.exitCode).toBe(1);
		expect(result.output.trimEnd()).toBe("Error: plain string");
	});
});
