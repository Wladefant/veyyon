import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { Settings } from "../../../config/settings";
import type { ToolSession } from "../..";
import { ToolAbortError, ToolError } from "../../core/tool-errors";
import { executeFileSearch } from "../file-search";

const ROOT_SEARCH_ERROR = "Searching from root directory '/' is not allowed";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	let thrown: unknown;
	try {
		await executeFileSearch(session, { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected file search path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("executeFileSearch", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});

	test("does not finish a timeout until the native scan has stopped", async () => {
		const started = Promise.withResolvers<void>();
		const timeoutObserved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let nativeSettled = false;
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const execution = executeFileSearch(
			session,
			{ path: "." },
			undefined,
			undefined,
			{
				timeoutMs: 100,
				nativeGlob: async options => {
					const nativeSignal = options.signal as AbortSignal | undefined;
					if (!nativeSignal) {
						started.resolve();
						timeoutObserved.resolve();
						throw new Error("Missing native cancellation signal");
					}
					nativeSignal.addEventListener("abort", () => timeoutObserved.resolve(), { once: true });
					started.resolve();
					await timeoutObserved.promise;
					await release.promise;
					nativeSettled = true;
					throw new Error("GenericFailure, Aborted: Timeout");
				},
			},
		);
		await started.promise;
		await timeoutObserved.promise;
		const stateBeforeCleanup = await Promise.race([
			execution.then(
				() => "settled",
				() => "settled",
			),
			Promise.resolve("pending"),
		]);
		expect(stateBeforeCleanup).toBe("pending");

		release.resolve();
		const result = await execution;

		expect(nativeSettled).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("File search timed out after 0.1s");
	});

	test("waits for every native scan to settle before rejecting an abort", async () => {
		const controller = new AbortController();
		const allStarted = Promise.withResolvers<void>();
		const allAborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let startedCount = 0;
		let abortedCount = 0;
		let settledCount = 0;
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const execution = executeFileSearch(
			session,
			{ path: `.; ${path.dirname(process.cwd())}` },
			controller.signal,
			undefined,
			{
				timeoutMs: 5000,
				nativeGlob: async options => {
					const nativeSignal = options.signal as AbortSignal | undefined;
					if (!nativeSignal) throw new Error("Missing native cancellation signal");
					const abortObserved = Promise.withResolvers<void>();
					nativeSignal.addEventListener(
						"abort",
						() => {
							abortedCount += 1;
							if (abortedCount === 2) allAborted.resolve();
							abortObserved.resolve();
						},
						{ once: true },
					);
					startedCount += 1;
					if (startedCount === 2) allStarted.resolve();
					await abortObserved.promise;
					await release.promise;
					settledCount += 1;
					throw new Error("GenericFailure, Aborted: Signal");
				},
			},
		);

		await allStarted.promise;
		controller.abort();
		await allAborted.promise;
		const stateBeforeCleanup = await Promise.race([
			execution.then(
				() => "settled",
				() => "settled",
			),
			Promise.resolve("pending"),
		]);
		expect(stateBeforeCleanup).toBe("pending");

		release.resolve();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		expect(settledCount).toBe(2);
	});
});
