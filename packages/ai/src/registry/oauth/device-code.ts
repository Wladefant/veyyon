import { scheduler } from "node:timers/promises";
import * as AIError from "../../error";

const DEVICE_FLOW_CANCEL_MESSAGE = "Login cancelled";
const DEVICE_FLOW_TIMEOUT_MESSAGE = "Device flow timed out";
const DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const MINIMUM_DEVICE_FLOW_INTERVAL_MS = 1000;
const DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

/** Result returned by one OAuth device-code polling attempt. */
export type OAuthDeviceCodePollResult<T> =
	| { status: "complete"; value: T }
	| { status: "pending" }
	/** `intervalSeconds` is the interval the server named in its `slow_down` answer, when it named one. */
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string };

/** Options for polling an RFC 8628-style OAuth device-code flow. */
export interface OAuthDeviceCodeFlowOptions<T> {
	/** Poll the provider once and classify the response. */
	poll(): OAuthDeviceCodePollResult<T> | Promise<OAuthDeviceCodePollResult<T>>;
	/** Provider-requested polling cadence; defaults to RFC 8628's five seconds. */
	intervalSeconds?: number;
	/** Provider-issued expiry window for the device code. */
	expiresInSeconds?: number;
	/**
	 * Cancels the flow with `LoginCancelledError`: an abort ends the wait between polls at once, and a
	 * poll that fails or answers after the abort ends the flow as cancelled rather than as its answer.
	 */
	signal?: AbortSignal;
	/** Provider id recorded on the `OAuthError` a failed or expired flow ends in. */
	provider?: string;
}

/**
 * Run one step of a login (a request, a poll, a wait) and settle it as the login's abort has it. Once
 * `signal` aborts, the step ends the login with `LoginCancelledError`: a request the abort cut short
 * rejects however its client reports that, and an approval answered after the abort signs in nobody.
 * The step itself must hand `signal` to what it waits on, so the abort ends the wait at once.
 */
export async function loginStep<T>(signal: AbortSignal | undefined, step: () => T | Promise<T>): Promise<T> {
	let value: T;
	try {
		value = await step();
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
		throw error;
	}
	if (signal?.aborted) throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
	return value;
}

/** Wait `ms` before the next poll of a login; an abort of `signal` ends the wait at once as the cancel. */
export function waitForNextLoginPoll(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return loginStep(signal, () => scheduler.wait(ms, { signal }));
}

/**
 * The error a device flow ends in when its code expires before it is approved. After a `slow_down` the
 * message points at clock drift, the usual reason a client keeps polling too early.
 */
export function deviceFlowTimeoutError(slowDownResponses: number, provider?: string): AIError.OAuthError {
	return new AIError.OAuthError(
		slowDownResponses > 0 ? DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE : DEVICE_FLOW_TIMEOUT_MESSAGE,
		{ kind: "timeout", provider },
	);
}

/** Poll an OAuth device-code flow until completion, provider failure, timeout, or cancellation. */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodeFlowOptions<T>): Promise<T> {
	const { signal, provider } = options;
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_DEVICE_FLOW_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS) * 1000),
	);
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
		}
		const result = await loginStep(signal, () => options.poll());
		if (result.status === "complete") {
			return result.value;
		}
		if (result.status === "failed") {
			throw new AIError.OAuthError(result.message, { kind: "polling", provider });
		}
		if (result.status === "slow_down") {
			slowDownResponses += 1;
			const requestedMs =
				typeof result.intervalSeconds === "number" && Number.isFinite(result.intervalSeconds)
					? result.intervalSeconds * 1000
					: 0;
			intervalMs = Math.max(
				MINIMUM_DEVICE_FLOW_INTERVAL_MS,
				intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS,
				requestedMs,
			);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await waitForNextLoginPoll(Math.min(intervalMs, remainingMs), signal);
	}

	throw deviceFlowTimeoutError(slowDownResponses, provider);
}
