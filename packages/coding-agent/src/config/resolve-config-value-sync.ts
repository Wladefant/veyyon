/**
 * Synchronous resolution of a models.yml secret or config value, for the model registry, which
 * resolves provider API keys and headers on paths that cannot await.
 *
 * The asynchronous counterpart is `resolve-config-value.ts`. Both drive the caching, back-off and
 * report-once policy in `config-value-resolution.ts`, so a `!command` runs once whichever path asks
 * first, and a failure backs off and is reported once across both. The one difference is execution:
 * this path runs the command with `execSync` and separate pipes, so its report can include stderr.
 */
import { execSync } from "node:child_process";
import { errorMessage } from "@veyyon/utils";
import {
	commandFailureReason,
	configCommandPolicy,
	parseConfigValueCommand,
	reportUnresolvedEnvReference,
	resolveConfigEnvReference,
} from "./config-value-resolution";

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Run a `!command` synchronously and return its trimmed stdout, or `undefined`
 * on any failure. The caching, back-off and report-once policy is shared with
 * the async resolver through `configCommandPolicy`, so both paths cache
 * successes and back off failures identically; only the execution differs.
 */
function resolveCommandConfig(command: string, describedAs: string | undefined): string | undefined {
	const cached = configCommandPolicy.getCached(command);
	if (cached !== undefined) return cached;
	if (configCommandPolicy.isBackedOff(command)) return undefined;
	try {
		// stderr is captured rather than inherited so a failure can be explained.
		// It is kept apart from stdout, which carries the secret and must never be
		// reported (see `reportUnresolvedConfigValue`).
		const stdout = execSync(command, {
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			// Succeeded and printed nothing, which is the more confusing failure:
			// the command looks fine when run by hand if it writes its value
			// somewhere other than stdout.
			configCommandPolicy.recordFailure(command, describedAs, commandFailureReason.emptyOutput);
			return undefined;
		}
		configCommandPolicy.recordSuccess(command, trimmed);
		return trimmed;
	} catch (error) {
		const failure = error as { status?: number; signal?: string; stderr?: Buffer | string };
		const reason =
			failure.signal === "SIGTERM"
				? commandFailureReason.timedOut(COMMAND_TIMEOUT_MS)
				: typeof failure.status === "number"
					? commandFailureReason.exited(failure.status)
					: commandFailureReason.spawnFailed(errorMessage(error));
		configCommandPolicy.recordFailure(command, describedAs, reason, failure.stderr?.toString());
		return undefined;
	}
}

/**
 * Resolve a models.yml/models.yaml secret/config value to an actual value.
 * `!cmd` runs a shell command and returns trimmed stdout; `${NAME}` / `$NAME`
 * and a bare environment name resolve from the environment and produce nothing
 * when the variable is unset or empty; `literal:<text>` and any other bare value
 * are the value itself. `describedAs` names the setting in a failure report.
 */
export function resolveConfigValueSync(valueConfig: string, describedAs?: string): string | undefined {
	const command = parseConfigValueCommand(valueConfig);
	if (command !== null) return resolveCommandConfig(command, describedAs);
	const outcome = resolveConfigEnvReference(valueConfig);
	if (outcome.ok) return outcome.value;
	reportUnresolvedEnvReference({
		variable: outcome.variable,
		explicit: outcome.explicit,
		empty: outcome.empty,
		describedAs,
	});
	return undefined;
}
