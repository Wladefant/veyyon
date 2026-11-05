import { setTimeout as delay } from "node:timers/promises";
import type { DaemonBrokerClient } from "../../src/launch/client";

/** Request a broker shutdown through `client`, then close the client. */
export async function shutdownBroker(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// A last-client shutdown may already have closed the broker.
	}
	client.close();
}

/**
 * Check `condition` every `intervalMs` until it holds or `timeoutMs` passes, then return one final check.
 *
 * The broker, its daemons and the OS process table run outside the test process, so fake timers cannot
 * advance them and progress is observed by polling.
 */
export async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
	intervalMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(intervalMs);
	}
	return condition();
}
