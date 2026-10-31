import { errorMessage, isCancellation, isTimeoutError } from "@veyyon/utils";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { OutputSink } from "../../session/streaming-output";
import { ProducerOutputGuard } from "../../secrets/producer-output";
import type { ToolSession } from "../../tools";
import { inlineBudgetFor } from "../../tools/core/output-artifact";
import {
	type OutputArtifactError,
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../../tools/core/output-meta";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import { executeInVmContext, type JsDisplayOutput } from "./context-manager";
import type { JsStatusEvent } from "./shared/types";

export interface JsExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used for worker cold-start headroom and
	 * timeout-annotation text when the caller drives cancellation via the eval
	 * watchdog `signal` instead of `deadlineMs`/`timeoutMs`. Never arms a timer.
	 */
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: JsStatusEvent) => void;
	signal?: AbortSignal;
	sessionId: string;
	/**
	 * Agent session that owns this eval context, so it is reaped when that session
	 * ends (mirrors the python/ruby/julia kernels). Unset falls back to per-context
	 * ownership. Without this the JS eval worker leaked across sessions (GRAN-11).
	 */
	kernelOwnerId?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;
	/** On-disk roots the helpers substitute for internal-URL schemes (e.g. `local://`). */
	localRoots?: Record<string, string>;
	/** Session artifacts directory; the `kv` helper stores under it so values outlive the kernel. */
	artifactsDir?: string | null;
}

export interface JsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	artifactElidedBytes?: number;
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: JsDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function formatJsTimeoutAnnotation(timeoutMs: number | undefined): string {
	// Timeout cancellation force-kills the worker (the only way to interrupt
	// synchronous user code), which discards the persistent VM state. Say so,
	// or the model will keep referencing variables that no longer exist.
	const reset = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
	if (timeoutMs === undefined) return `Command timed out. ${reset}`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds. ${reset}`;
}

/** The prefix of the name each cell is compiled under. */
const CELL_FILE_PREFIX = "js-cell-";
/** A cell's compiled name, with any path in front of it: one cell's, or an earlier cell's that defined a helper. */
const CELL_FILE = new RegExp(`(?:[^\\s()]*/)?${CELL_FILE_PREFIX}[0-9a-f-]{36}\\.js`);
const CELL_FILES = new RegExp(CELL_FILE.source, "g");
const STACK_FRAME = /^\s+at /;

/**
 * A thrown value as the cell's reader needs it: the error text, then the stack from the innermost frame down to the
 * last frame of cell code, with each cell named `<cell>`. The frames under that one dispatched the cell. A stack with
 * no cell frame, from a cell that did not parse or a thrown non-Error the host wrapped, holds only harness frames.
 */
function cellErrorText(error: unknown): string {
	if (!(error instanceof Error)) return errorMessage(error);
	const lines = (error.stack ?? error.message).split("\n");
	const firstFrame = lines.findIndex(line => STACK_FRAME.test(line));
	if (firstFrame < 0) return lines.join("\n");
	let end = firstFrame;
	for (let i = lines.length - 1; i >= firstFrame; i--) {
		if (STACK_FRAME.test(lines[i]!) && CELL_FILE.test(lines[i]!)) {
			end = i + 1;
			break;
		}
	}
	return lines.slice(0, end).join("\n").replace(CELL_FILES, "<cell>");
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const displayOutputs: JsDisplayOutput[] = [];
	const outputSink = new OutputSink({
		outputGuard: new ProducerOutputGuard(options.session.obfuscateProviderText),
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(options.session.settings),
		spillThreshold: inlineBudgetFor(options.session),
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const legacyTimeoutMs = getExecutionTimeoutMs(options);
	const scopedTimeout =
		typeof legacyTimeoutMs === "number" && Number.isFinite(legacyTimeoutMs) && legacyTimeoutMs > 0
			? scopedTimeoutSignal(legacyTimeoutMs, options.signal)
			: undefined;
	const signal = scopedTimeout ? scopedTimeout.signal : options.signal;
	// The eval tool drives cancellation via its own watchdog `signal` and passes
	// only the runtime-work budget; use it solely as worker cold-start headroom
	// and never derive a competing fixed timer from it.
	const acquireBudgetMs = legacyTimeoutMs ?? options.idleTimeoutMs;
	const finish = async (exitCode: number | undefined, cancelled: boolean): Promise<JsResult> => {
		const summary = await outputSink.dumpWithArtifactStatus();
		return {
			output: summary.output,
			exitCode,
			cancelled,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactElidedBytes: summary.artifactElidedBytes,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	};

	try {
		await executeInVmContext({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			cwd: options.cwd ?? options.session.cwd,
			session: options.session,
			localRoots: options.localRoots,
			artifactsDir: options.artifactsDir,
			reset: options.reset,
			code,
			filename: `${CELL_FILE_PREFIX}${crypto.randomUUID()}.js`,
			timeoutMs: acquireBudgetMs,
			runState: {
				signal,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					if (output.type === "json") {
						try {
							const serialized = JSON.stringify(output.data);
							const filtered = new ProducerOutputGuard(options.session.obfuscateProviderText).sanitize(serialized);
							output = { type: "json", data: filtered === serialized ? output.data : "[credential output withheld]" };
						} catch {
							output = { type: "json", data: "[credential output withheld]" };
						}
					}
					if (output.type === "status") {
						// Timeout-control events drive the eval watchdog only; never
						// store or render them as cell output.
						options.onStatus?.(output.event);
						if (isEvalTimeoutControlEvent(output.event)) return;
					}
					displayOutputs.push(output);
				},
			},
		});
		return await finish(0, false);
	} catch (error) {
		if (signal?.aborted || isCancellation(error)) {
			const timedOut = isTimeoutError(signal?.reason) || isTimeoutError(options.signal?.reason);
			if (timedOut) {
				outputSink.push(formatJsTimeoutAnnotation(legacyTimeoutMs ?? options.idleTimeoutMs));
			}
			return await finish(undefined, true);
		}
		outputSink.push(cellErrorText(error));
		return await finish(1, false);
	}
}
