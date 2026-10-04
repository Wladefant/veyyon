import { execFile } from "node:child_process";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { getActiveProfileOrDefault } from "@veyyon/utils/dirs";
import type { AgentSession } from "../../session/agent-session";

type State = "idle" | "working";
type Runner = (binary: string, args: string[]) => Promise<void>;

function runReport(binary: string, args: string[]): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	execFile(binary, args, { timeout: 2000, windowsHide: true, maxBuffer: 8192 }, () => resolve());
	return promise;
}

/**
 * Herdr reruns the saved argv in the pane's current directory, which `/cd` and cross-project resume
 * change. The loader resolves extension paths against the launch cwd, so pin them to it. A leading
 * `~` is home-relative whatever the cwd, and the loader expands it itself.
 */
function resolveLaunchPath(value: string, startupCwd: string): string {
	return value.startsWith("~") ? value : path.resolve(startupCwd, value);
}

/** Herdr validates argv before accepting a report, including its lifecycle state. */
export function herdrResumeArgv(
	sessionFile: string,
	profile: string,
	launchArgs: string[],
	startupCwd: string,
): string[] | undefined {
	const argv = ["veyyon", "--profile", profile, "--resume", sessionFile];
	// Explicit extensions are not necessarily installed in the profile. Do not
	// replay prompts, fork/new-session flags, or other one-shot launch arguments.
	for (let i = 0; i < launchArgs.length; i++) {
		const arg = launchArgs[i]!;
		if ((arg === "--extension" || arg === "-e" || arg === "--hook") && launchArgs[i + 1]) {
			argv.push(arg, resolveLaunchPath(launchArgs[++i]!, startupCwd));
		} else if (arg.startsWith("--extension=") || arg.startsWith("--hook=")) {
			const split = arg.indexOf("=");
			argv.push(arg.slice(0, split), resolveLaunchPath(arg.slice(split + 1), startupCwd));
		}
	}
	if (
		argv.length > 64 ||
		Buffer.byteLength(argv.join("\0")) > 8192 ||
		argv.some(arg => /['\x00-\x1f\x7f]/.test(arg))
	) {
		return undefined;
	}
	return argv;
}

function identityOf(session: AgentSession): string {
	return `${session.sessionManager.getSessionId()}\0${session.sessionManager.getSessionFile() ?? ""}`;
}

/** Only the foreground terminal session owns this pane. Reporting never blocks it. */
export class HerdrReporter {
	#unsubscribe?: () => void;
	#pending?: string[];
	#sending = false;
	#sequence = Date.now() * 1000;
	#session?: AgentSession;
	#released = false;
	#reported?: string;
	#timer?: NodeJS.Timeout;

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly runner: Runner = runReport,
		private readonly profile = getActiveProfileOrDefault(),
		private readonly launchArgs = process.argv.slice(2),
		private readonly startupCwd = process.cwd(),
		private readonly identityPollMs = 1000,
	) {}

	#stopWatching(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	attach(session: AgentSession): void {
		this.#stopWatching();
		this.#session = session;
		if (
			this.env.HERDR_ENV !== "1" ||
			!this.env.HERDR_BIN_PATH ||
			!this.env.HERDR_PANE_ID ||
			!this.env.HERDR_SOCKET_PATH
		)
			return;
		this.#released = false;
		this.#report(session.isStreaming ? "working" : "idle");
		this.#unsubscribe = session.subscribe(event => {
			try {
				if (event.type === "agent_start") this.#report("working");
				else if (event.type === "agent_end") this.#report("idle");
			} catch (error) {
				logger.warn("herdr state report failed", { error: String(error) });
			}
		});
		// `switchSession`, `newSession`, `fork` and `branch` replace the session in place and raise no
		// event this reporter can see. Herdr would keep restoring the previous conversation until the
		// next turn, so compare identity on a short timer. A report only spawns when it changed.
		this.#timer = setInterval(() => {
			try {
				const current = this.#session;
				if (!current || this.#released || identityOf(current) === this.#reported) return;
				this.#report(current.isStreaming ? "working" : "idle");
			} catch (error) {
				logger.warn("herdr identity report failed", { error: String(error) });
			}
		}, this.identityPollMs);
		this.#timer.unref?.();
	}

	#report(state: State): void {
		const manager = this.#session?.sessionManager;
		const file = manager?.getSessionFile();
		const resume = file ? herdrResumeArgv(file, this.profile, this.launchArgs, this.startupCwd) : undefined;
		this.#reported = this.#session ? identityOf(this.#session) : undefined;
		const args = [
			"pane",
			"report-agent",
			this.env.HERDR_PANE_ID!,
			"--source",
			"veyyon",
			"--agent",
			"veyyon",
			"--state",
			state,
			"--seq",
			String(++this.#sequence),
		];
		if (resume) args.push("--agent-session-id", manager!.getSessionId(), "--", ...resume);
		this.#queue(args);
	}

	#queue(args: string[]): void {
		this.#pending = args;
		if (!this.#sending) void this.#flush();
	}

	async #flush(): Promise<void> {
		this.#sending = true;
		try {
			while (this.#pending) {
				const args = this.#pending;
				this.#pending = undefined;
				try {
					await this.runner(this.env.HERDR_BIN_PATH!, args);
				} catch {
					/* Herdr is optional, including during server loss. */
				}
			}
		} finally {
			this.#sending = false;
		}
	}

	/** Call only for an intentional quit, not a signal or a terminal transport failure. */
	release(): void {
		this.#stopWatching();
		if (
			this.#released ||
			this.env.HERDR_ENV !== "1" ||
			!this.env.HERDR_BIN_PATH ||
			!this.env.HERDR_PANE_ID ||
			!this.env.HERDR_SOCKET_PATH
		)
			return;
		this.#released = true;
		this.#queue([
			"pane",
			"release-agent",
			this.env.HERDR_PANE_ID,
			"--source",
			"veyyon",
			"--agent",
			"veyyon",
			"--seq",
			String(++this.#sequence),
		]);
	}
}
