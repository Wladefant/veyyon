/**
 * The shell commands and Python cells the user runs directly (`!`, `$`), and the eval runs a tool
 * starts, from their start to their record in the transcript.
 *
 * This is a session collaborator. It holds the abort controller of every running command and cell,
 * the eval runs still in flight and the results recorded while a turn streamed, and reaches the
 * session only through {@link UserExecutionsHost}. An extension handling `user_bash` or
 * `user_python` may run a command or cell in place of the shell or the kernel; its result is
 * recorded the same way.
 *
 * A result recorded while a turn streams waits for the next prompt: appending it mid-turn would put
 * a message between a tool call and its result. Shell results are appended before Python results.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import type { PythonResult } from "../../eval/py/executor";
// The leaf, not `../../eval/py`: that module declares the Python backend descriptor and reaches
// hundreds of modules, and all this needs is the id prefix.
import { namespaceSessionId as namespacePythonSessionId } from "../../eval/py/session-namespace";
import { type BashResult, executeBash as executeBashCommand } from "../../exec/bash-executor";
import type { ExtensionRunner } from "../../extensibility/extensions";
import { TOOL } from "../../tools/core/builtin-names";
import { reportLostOutputArtifact } from "../../tools/core/output-artifact";
import { outputMeta } from "../../tools/core/output-meta";
import { clampTimeout } from "../../tools/core/tool-timeouts";
import type { BashExecutionMessage, PythonExecutionMessage } from "../../tools/shell/execution-messages";
import { loadPythonExecutor } from "../../tools/shell/manifest";

/** How long dispose waits for eval runs to finish on their own, then after aborting them. */
const EVAL_SETTLE_MS = 3_000;
const EVAL_ABORT_SETTLE_MS = 1_000;

/** What {@link UserExecutions} needs from the session that owns it. */
export interface UserExecutionsHost {
	/** Whether a turn is streaming, so a recorded result waits for the next prompt. */
	isStreaming(): boolean;
	/** Add `message` to the agent's context and the session log. */
	append(message: BashExecutionMessage | PythonExecutionMessage): void;
	/** The directory a command or cell runs in. */
	cwd(): string;
	/** The session a shell command runs under. */
	sessionId(): string;
	/** The eval session whose Python kernel a cell shares with the eval tool. */
	evalSessionId(): string;
	/** The owner the session's Python kernels are released under. */
	evalKernelOwnerId(): string;
	/** The extensions that may run a command or cell in place of the shell or the kernel. */
	extensions(): Pick<ExtensionRunner, "hasHandlers" | "emitUserBash" | "emitUserPython"> | undefined;
	/** The command timeout ceiling and the Python kernel mode and interpreter, read per run. */
	settings(): Pick<Settings, "get">;
	/** Save `content` as a session artifact of `type`, returning its id. */
	saveArtifact(content: string, type: string): Promise<string | undefined>;
}

/** Whether a command's or cell's output stays out of the model's context (`!!`, `$$`). */
export interface UserExecutionOptions {
	excludeFromContext?: boolean;
}

export class UserExecutions {
	readonly #host: UserExecutionsHost;
	readonly #bashRuns = new Set<AbortController>();
	readonly #evalRuns = new Set<AbortController>();
	readonly #evalExecutions = new Set<Promise<unknown>>();
	#deferredBash: BashExecutionMessage[] = [];
	#deferredPython: PythonExecutionMessage[] = [];
	#evalStopped = false;

	constructor(host: UserExecutionsHost) {
		this.#host = host;
	}

	abortBash(): void {
		for (const controller of this.#bashRuns) controller.abort();
	}

	get bashRunning(): boolean {
		return this.#bashRuns.size > 0;
	}

	get hasDeferredBash(): boolean {
		return this.#deferredBash.length > 0;
	}

	/**
	 * Run a shell command the user typed and record its result. `useUserShell` lets the caller route
	 * the command through the configured user shell.
	 */
	async executeBash(
		command: string,
		onChunk: ((chunk: string) => void) | undefined,
		options: (UserExecutionOptions & { useUserShell?: boolean }) | undefined,
	): Promise<BashResult> {
		const host = this.#host;
		const cwd = host.cwd();
		const extensions = host.extensions();
		if (extensions?.hasHandlers("user_bash")) {
			const excludeFromContext = options?.excludeFromContext === true;
			const hookResult = await extensions.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd });
			if (hookResult?.result) {
				this.recordBash(command, hookResult.result, options);
				return hookResult.result;
			}
		}
		const controller = new AbortController();
		this.#bashRuns.add(controller);
		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: controller.signal,
				sessionKey: host.sessionId(),
				cwd,
				timeout: clampTimeout(TOOL.bash, undefined, host.settings().get("tools.maxTimeout")) * 1000,
				onMinimizedSave: originalText => this.#saveBashOriginal(originalText),
				useUserShell: options?.useUserShell,
			});
			this.recordBash(command, result, options);
			return result;
		} finally {
			this.#bashRuns.delete(controller);
		}
	}

	/** Record a shell command's result; an extension that ran the command itself records through this. */
	recordBash(command: string, result: BashResult, options: UserExecutionOptions | undefined): void {
		this.#record({
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			signal: result.signal,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta: outputMeta().truncationFromSummary(result, { direction: "tail" }).get(),
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		});
	}

	/**
	 * Run a Python cell the user typed in the kernel the eval tool's Python backend uses, and record its
	 * result. Tracked as an eval run, so {@link abortEval} reaches it and dispose waits for it.
	 */
	async executePython(
		code: string,
		onChunk: ((chunk: string) => void) | undefined,
		options: UserExecutionOptions | undefined,
	): Promise<PythonResult> {
		const host = this.#host;
		const cwd = host.cwd();
		this.assertEvalAllowed();
		const controller = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			const extensions = host.extensions();
			if (extensions?.hasHandlers("user_python")) {
				const excludeFromContext = options?.excludeFromContext === true;
				const hookResult = await extensions.emitUserPython({ type: "user_python", code, excludeFromContext, cwd });
				this.assertEvalAllowed();
				if (hookResult?.result) {
					this.recordPython(code, hookResult.result, options);
					return hookResult.result;
				}
			}
			const sessionId = host.evalSessionId();
			const { executePython: executePythonCommand } = await loadPythonExecutor();
			this.assertEvalAllowed();
			const settings = host.settings();
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: host.evalKernelOwnerId(),
				kernelMode: settings.get("python.kernelMode"),
				interpreter: settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: controller.signal,
			});
			this.recordPython(code, result, options);
			return result;
		})();
		return await this.trackEval(execution, controller);
	}

	/** Record a Python cell's result; an extension that ran the cell itself records through this. */
	recordPython(code: string, result: PythonResult, options: UserExecutionOptions | undefined): void {
		this.#record({
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta: outputMeta().truncationFromSummary(result, { direction: "tail" }).get(),
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		});
	}

	/** Record a result: appended now, or at the next prompt while a turn streams. */
	#record(message: BashExecutionMessage | PythonExecutionMessage): void {
		if (!this.#host.isStreaming()) {
			this.#host.append(message);
		} else if (message.role === "bashExecution") {
			this.#deferredBash.push(message);
		} else {
			this.#deferredPython.push(message);
		}
	}

	/**
	 * Save a shell command's unminimized output. The executor appends the `artifact://<id>` footer
	 * only when an id comes back, so a failed save answers undefined: the minimized output stays
	 * correct and cannot be expanded. The loss is reported through the owner the tool spill path
	 * uses, so both report it the same way.
	 */
	async #saveBashOriginal(originalText: string): Promise<string | undefined> {
		try {
			return await this.#host.saveArtifact(originalText, "bash-original");
		} catch (err) {
			reportLostOutputArtifact("bash-original", err);
			return undefined;
		}
	}

	/** Append the results recorded while the last turn streamed. */
	flush(): void {
		const deferred = [...this.#deferredBash, ...this.#deferredPython];
		if (deferred.length === 0) return;
		this.#deferredBash = [];
		this.#deferredPython = [];
		for (const message of deferred) this.#host.append(message);
	}

	/** @throws Once the session began disposing, since its kernels are about to be released. */
	assertEvalAllowed(): void {
		if (this.#evalStopped) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/** Track an eval run so {@link abortEval} reaches it and dispose waits for it. */
	trackEval<T>(execution: Promise<T>, controller: AbortController): Promise<T> {
		this.#evalRuns.add(controller);
		this.#evalExecutions.add(execution);
		const untrack = () => {
			this.#evalRuns.delete(controller);
			this.#evalExecutions.delete(execution);
		};
		void execution.then(untrack, untrack);
		return execution;
	}

	abortEval(): void {
		for (const controller of this.#evalRuns) controller.abort();
	}

	get evalRunning(): boolean {
		return this.#evalRuns.size > 0;
	}

	get hasDeferredPython(): boolean {
		return this.#deferredPython.length > 0;
	}

	/** Refuse every eval run from now on: the session began disposing. */
	stopEval(): void {
		this.#evalStopped = true;
	}

	/**
	 * Wait for the eval runs to finish, aborting them after {@link EVAL_SETTLE_MS}. `false` when one is
	 * still running {@link EVAL_ABORT_SETTLE_MS} after the abort, so its kernel is released under it.
	 */
	async settleEvalForDispose(): Promise<boolean> {
		if (await this.#settleEval(EVAL_SETTLE_MS)) return true;
		logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
		this.abortEval();
		if (await this.#settleEval(EVAL_ABORT_SETTLE_MS)) return true;
		logger.warn(
			"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
		);
		return false;
	}

	/** Whether every eval run finished within `timeoutMs`, including runs tracked while waiting. */
	async #settleEval(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#evalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			// The timer is cancelled once the runs settle, so it holds neither the event loop nor a
			// dispose that already finished.
			const timer = new AbortController();
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#evalExecutions)).then(() => true),
				sleep(remainingMs, false, { signal: timer.signal }).catch(() => false),
			]);
			timer.abort();
			if (!settled && this.#evalExecutions.size > 0) return false;
		}
		return true;
	}
}
