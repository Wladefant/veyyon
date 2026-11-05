/**
 * The CLI's binding of the collab relay client. The host and the guest both send and receive
 * `CollabFrame`, reconnect on the shared backoff schedule, and report dropped frames to the log file.
 *
 * Ordering, backpressure, reconnect and the fatal close codes are `RelayClient` in
 * `@veyyon/wire/relay-client`, which the browser guest binds the same way.
 */
import { exponentialBackoffDelay, logger } from "@veyyon/utils";
import { RelayClient, type RelayClientLog, type RelayClientOptions } from "@veyyon/wire/relay-client";
import type { CollabFrame } from "./protocol";

const logToFile: RelayClientLog = (level, message, detail) => logger[level](message, detail);

export class CollabSocket extends RelayClient<CollabFrame, CollabFrame> {
	constructor(options: Pick<RelayClientOptions, "wsUrl" | "role" | "key">) {
		super({ ...options, retryDelayMs: attempt => exponentialBackoffDelay(attempt), log: logToFile });
	}
}
