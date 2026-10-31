/**
 * The browser guest's binding of the collab relay client. It sends `GuestFrame`, receives `HostFrame`,
 * reconnects on the shared backoff schedule, and shows peer and listener faults in the console.
 *
 * Ordering, backpressure, reconnect and the fatal close codes are `RelayClient` in
 * `@veyyon/wire/relay-client`, which the CLI host and guest bind the same way.
 */
import { exponentialBackoffDelay } from "@veyyon/utils/backoff";
import type { GuestFrame, HostFrame } from "@veyyon/wire";
import { RelayClient, type RelayClientLog, type RelayClientOptions } from "@veyyon/wire/relay-client";

const warnInConsole: RelayClientLog = (level, message, detail) => {
	if (level !== "warn") return;
	if (detail === undefined) console.warn(message);
	else console.warn(message, detail);
};

export class CollabSocket extends RelayClient<GuestFrame, HostFrame> {
	constructor(options: Pick<RelayClientOptions, "wsUrl" | "role" | "key">) {
		super({ ...options, retryDelayMs: attempt => exponentialBackoffDelay(attempt), log: warnInConsole });
	}
}
