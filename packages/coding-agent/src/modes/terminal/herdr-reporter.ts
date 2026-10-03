import { execFile } from "node:child_process";
import { getActiveProfileOrDefault } from "@veyyon/utils/dirs";
import type { AgentSession } from "../../session/agent-session";

type State = "idle" | "working";
type Runner = (binary: string, args: string[]) => Promise<void>;

function runReport(binary: string, args: string[]): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	execFile(binary, args, { timeout: 2000, windowsHide: true, maxBuffer: 8192 }, () => resolve());
	return promise;
}

/** Herdr validates argv before accepting a report, including its lifecycle state. */
export function herdrResumeArgv(sessionFile: string, profile: string, launchArgs: string[]): string[] | undefined {
	const argv = ["veyyon", "--profile", profile, "--resume", sessionFile];
	// Explicit extensions are not necessarily installed in the profile. Do not
	// replay prompts, fork/new-session flags, or other one-shot launch arguments.
	for (let i = 0; i < launchArgs.length; i++) {
		const arg = launchArgs[i]!;
		if ((arg === "--extension" || arg === "-e" || arg === "--hook") && launchArgs[i + 1]) {
			argv.push(arg, launchArgs[++i]!);
		} else if (arg.startsWith("--extension=") || arg.startsWith("--hook=")) {
			const split = arg.indexOf("=");
			argv.push(arg.slice(0, split), arg.slice(split + 1));
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

/** Only the foreground terminal session owns this pane. Reporting never blocks it. */
export class HerdrReporter {
	#unsubscribe?: () => void;
	#pending?: string[];
	#sending = false;
	#sequence = Date.now() * 1000;
	#session?: AgentSession;
	#released = false;

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly runner: Runner = runReport,
		private readonly profile = getActiveProfileOrDefault(),
		private readonly launchArgs = process.argv.slice(2),
	) {}

	attach(session: AgentSession): void {
		this.#unsubscribe?.();
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
			if (event.type === "agent_start") this.#report("working");
			else if (event.type === "agent_end") this.#report("idle");
		});
	}

	#report(state: State): void {
		const manager = this.#session?.sessionManager;
		const file = manager?.getSessionFile();
		const resume = file ? herdrResumeArgv(file, this.profile, this.launchArgs) : undefined;
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
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
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
