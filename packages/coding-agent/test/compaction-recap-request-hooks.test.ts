import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@veyyon/agent-core";
import { markCompactionRecapRequest } from "@veyyon/agent-core/compaction/recap-request";
import type { Context } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SecretRequestLeases } from "../src/secrets/request-leases";
import type { SecretRuntimeLease } from "../src/session/agent-session-types";
import { createLeasedStreamFn } from "../src/session/startup-request-hooks";

const { model } = createMockModel({ responses: [] });

interface Payload {
	messages: string[];
	tools?: string[];
	redactedBy?: string;
}

/** A lease whose redaction stamps the payload with the lease's name, so the test sees which lease redacted it. */
function fakeLease(name: string): SecretRuntimeLease {
	return {
		hasRedactions: true,
		obfuscatePayload: (payload: unknown) => ({ ...(payload as Payload), redactedBy: name }),
	} as unknown as SecretRuntimeLease;
}

/** Drives `context` through the real leased wrapper and returns the payload that reaches the transport. */
async function wirePayload(context: Context, requestLeases: SecretRequestLeases): Promise<Payload> {
	let wire: unknown;
	const transport: StreamFn = async (_model, _context, options) => {
		wire = (await options?.onPayload?.({ messages: ["hello"] }, model)) ?? { messages: ["hello"] };
		return new AssistantMessageEventStream();
	};
	// The session hook injects tools; the caller hook replaces the messages. Either one showing up on the
	// wire proves it ran.
	const sessionHook = async (payload: unknown) => ({ ...(payload as Payload), tools: ["injected-tool"] });
	const stream = createLeasedStreamFn(requestLeases, () => sessionHook, transport, undefined);
	await stream(model, context, {
		onPayload: async payload => ({ ...(payload as Payload), messages: ["caller-replaced"] }),
	});
	return wire as Payload;
}

describe("compaction recap request hooks", () => {
	it("applies the session hook, caller onPayload, and the main lease to an unmarked request", async () => {
		const mainLease = fakeLease("main");
		const requestLeases = new SecretRequestLeases({ lease: mainLease, acquire: async () => mainLease });
		const wire = await wirePayload({ messages: [] }, requestLeases);
		expect(wire).toEqual({ messages: ["caller-replaced"], tools: ["injected-tool"], redactedBy: "main" });
	});

	it("bypasses the session hook and caller onPayload for a marked recap, still redacting under the source lease", async () => {
		const mainLease = fakeLease("main");
		const sourceLease = fakeLease("source");
		const requestLeases = new SecretRequestLeases({ lease: mainLease, acquire: async () => mainLease });
		const source: Context = { messages: [] };
		requestLeases.bind(source, sourceLease);
		const recap: Context = { messages: [] };
		markCompactionRecapRequest(recap, source);

		const wire = await wirePayload(recap, requestLeases);
		expect(wire).toEqual({ messages: ["hello"], redactedBy: "source" });
	});

	it("refuses to dispatch a recap when its source secret lease is missing", async () => {
		const mainLease = fakeLease("main");
		const requestLeases = new SecretRequestLeases({ lease: mainLease, acquire: async () => mainLease });
		const recap: Context = { messages: [] };
		markCompactionRecapRequest(recap, { messages: [] });
		await expect(wirePayload(recap, requestLeases)).rejects.toThrow("no source secret lease");
	});
});
