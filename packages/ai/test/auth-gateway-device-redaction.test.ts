import { expect, it } from "bun:test";
import { redactResponse } from "../src/auth-gateway/http";
import { GATEWAY_SEMANTIC_MAX_HELD_BYTES, GATEWAY_SEMANTIC_MAX_HELD_FRAMES, GatewaySemanticRedactor } from "../src/auth-gateway/semantic-redaction";

it("redacts credential bytes split across SSE chunks and keeps cancellation", async () => {
	const encoder = new TextEncoder();
	let cancelled = false;
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('data: {"text":"access-'));
			controller.enqueue(encoder.encode('secret refresh-secret"}\n\n'));
			controller.close();
		},
		cancel() { cancelled = true; },
	});
	const response = redactResponse(new Response(source, { headers: { "content-type": "text/event-stream", "x-debug": "access-secret" } }), ["access-secret", "refresh-secret"]);
	expect(response.headers.get("x-debug")).toBe("[REDACTED]");
	const text = await response.text();
	expect(text).toBe('data: {"text":"[REDACTED] [REDACTED]"}\n\n');
	const pending = redactResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), ["access-secret"]);
	await pending.body!.cancel();
	expect(cancelled).toBe(true);
});

it("redacts credentials learned after a streaming response starts", async () => {
	const secrets: string[] = [];
	const response = redactResponse(new Response('data: {"error":"new-secret"}\n\n', { headers: { "content-type": "text/event-stream" } }), secrets);
	secrets.push("new-secret");
	expect(await response.text()).not.toContain("new-secret");
});

it("redacts credentials reconstructed from separate semantic SSE deltas", async () => {
	const cases = [
		(fragment: string) => ({ type: "text_delta", contentIndex: 0, delta: fragment }),
		(fragment: string) => ({ type: "thinking_delta", contentIndex: 0, delta: fragment }),
		(fragment: string) => ({ type: "toolcall_delta", contentIndex: 0, delta: fragment }),
		(fragment: string) => ({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: fragment }),
		(fragment: string) => ({ type: "content_block_delta", index: 0, delta: { text: fragment } }),
		(fragment: string) => ({ choices: [{ index: 0, delta: { content: fragment } }] }),
	];
	for (const event of cases) {
		const raw = ["prefix provider-", "secret suffix"].map(fragment => `data: ${JSON.stringify(event(fragment))}\n\n`).join("") + "data: [DONE]\n\n";
		const response = redactResponse(new Response(raw, { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
		const frames = (await response.text()).split("\n\n").filter(frame => frame.startsWith("data: {"));
		const values = frames.map(frame => JSON.parse(frame.slice(6)));
		const text = values.map(value => typeof value.delta === "string" ? value.delta : value.delta?.text ?? value.choices?.[0].delta.content).join("");
		expect(text).toBe("prefix [REDACTED] suffix");
		expect(text).not.toContain("provider-secret");
	}
});

it("leaves harmless semantic deltas and false credential prefixes byte-for-byte unchanged", async () => {
	for (const fragments of [["ordinary", " response"], ["provider-", "public"], ["end with provider-"]]) {
		const raw = fragments.map(delta => `data: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta })}\n\n`).join("") + "data: [DONE]\n\n";
		const response = redactResponse(new Response(raw, { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
		expect(await response.text()).toBe(raw);
	}
});

it("does not join unrelated semantic channels into a credential", async () => {
	const raw = 'data: {"type":"text_delta","contentIndex":0,"delta":"provider-"}\n\n'
		+ 'data: {"type":"thinking_delta","contentIndex":1,"delta":"secret"}\n\n'
		+ 'data: [DONE]\n\n';
	const response = redactResponse(new Response(raw, { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
	expect(await response.text()).toBe(raw);
});

it("emits safe deltas immediately and holds only a possible credential prefix", () => {
	const guard = new GatewaySemanticRedactor(["provider-secret"]);
	const safe = 'data: {"type":"text_delta","contentIndex":0,"delta":"hello "}\n\n';
	const prefix = 'data: {"type":"text_delta","contentIndex":0,"delta":"provider-"}\n\n';
	const harmless = 'data: {"type":"text_delta","contentIndex":0,"delta":"public"}\n\n';
	expect(guard.push(safe)).toBe(safe);
	expect(guard.push(prefix)).toBe("");
	expect(guard.push(harmless)).toBe(prefix + harmless);
});

it("guards text credentials split between distinct content blocks", async () => {
	const raw = 'data: {"type":"text_delta","contentIndex":0,"delta":"provider-"}\n\n'
		+ 'data: {"type":"text_delta","contentIndex":1,"delta":"secret"}\n\n'
		+ 'data: [DONE]\n\n';
	const response = redactResponse(new Response(raw, { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
	const values = (await response.text()).split("\n\n").filter(frame => frame.startsWith("data: {")).map(frame => JSON.parse(frame.slice(6)));
	expect(values.map(value => value.delta).join("")).toBe("[REDACTED]");
});

it("guards semantic deltas in event-labelled SSE without changing the event label", async () => {
	const raw = ["provider-", "secret"].map(text =>
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
	).join("");
	const response = redactResponse(new Response(raw, { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
	const frames = (await response.text()).split("\n\n").filter(Boolean);
	expect(frames.every(frame => frame.startsWith("event: content_block_delta\n"))).toBe(true);
	const text = frames.map(frame => JSON.parse(frame.split("\ndata: ")[1]).delta.text).join("");
	expect(text).toBe("[REDACTED]");
});

it("releases completed text prefixes and later safe events before upstream EOF", async () => {
	const encoder = new TextEncoder();
	let upstream!: ReadableStreamDefaultController<Uint8Array>;
	const source = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
	const response = redactResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
	const reader = response.body!.getReader();
	const prefix = 'data: {"type":"text_delta","contentIndex":0,"delta":"provider-"}\n\n';
	const end = 'data: {"type":"text_end","contentIndex":0}\n\n';
	const safe = 'data: {"type":"thinking_delta","contentIndex":1,"delta":"safe thought"}\n\n';
	try {
		const first = reader.read();
		upstream.enqueue(encoder.encode(prefix + end));
		expect(new TextDecoder().decode((await first).value)).toBe(prefix + end);
		upstream.enqueue(encoder.encode(safe));
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(safe);
	} finally { await reader.cancel(); }
});

it("bounds held semantic frames and bytes without waiting for EOF", () => {
	const prefix = 'data: {"type":"text_delta","delta":"provider-"}\n\n';
	const safe = 'data: {"type":"thinking_delta","delta":"safe"}\n\n';
	const byFrames = new GatewaySemanticRedactor(["provider-secret"]);
	expect(byFrames.push(prefix)).toBe("");
	for (let count = 1; count < GATEWAY_SEMANTIC_MAX_HELD_FRAMES - 1; count++) expect(byFrames.push(safe)).toBe("");
	const flushed = byFrames.push(safe);
	expect(flushed).toContain("[REDACTED]");
	expect(flushed).toContain('"delta":"safe"');
	expect(byFrames.push(safe)).toBe(safe);
	const byBytes = new GatewaySemanticRedactor(["provider-secret"]);
	expect(byBytes.push(prefix)).toBe("");
	const oversized = `data: ${JSON.stringify({ type: "thinking_delta", delta: "x".repeat(GATEWAY_SEMANTIC_MAX_HELD_BYTES) })}\n\n`;
	expect(byBytes.push(oversized)).toContain("[REDACTED]");
	expect(byBytes.push(safe)).toBe(safe);
});

it("discards held raw prefixes on semantic errors and transport aborts", async () => {
	const prefix = 'data: {"type":"text_delta","delta":"provider-"}\n\n';
	const error = 'data: {"type":"error","message":"upstream failed"}\n\n';
	const semantic = new GatewaySemanticRedactor(["provider-secret"]);
	expect(semantic.push(prefix)).toBe("");
	expect(semantic.push(error)).toBe(error);
	expect(semantic.push("", true)).toBe("");
	let source!: ReadableStreamDefaultController<Uint8Array>;
	let requested!: () => void;
	const awaitingContinuation = new Promise<void>(resolve => { requested = resolve; });
	const response = redactResponse(new Response(new ReadableStream<Uint8Array>({
		start(controller) { source = controller; controller.enqueue(new TextEncoder().encode(prefix)); },
		pull() { requested(); },
	}, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }), ["provider-secret"]);
	const result = response.text();
	await awaitingContinuation;
	source.error(new Error("abort provider-secret"));
	await expect(result).rejects.toThrow("Gateway response stream failed");
});

it("redacts credentials in three or more semantic fragments and after a completed prefix", () => {
	const semantic = new GatewaySemanticRedactor(["provider-secret"]);
	expect(semantic.push('data: {"type":"text_delta","delta":"prov"}\n\n')).toBe("");
	expect(semantic.push('data: {"type":"text_delta","delta":"ider-"}\n\n')).toBe("");
	const output = semantic.push('data: {"type":"text_delta","delta":"secret"}\n\n');
	const values = output.trim().split("\n\n").map(frame => JSON.parse(frame.slice(6)).delta).join("");
	expect(values).toBe("[REDACTED]");
	const completed = new GatewaySemanticRedactor(["provider-secret"]);
	const first = 'data: {"type":"text_delta","delta":"provider-"}\n\n';
	expect(completed.push(first)).toBe("");
	const visible = completed.push('data: {"type":"text_end"}\n\n');
	const continuation = completed.push('data: {"type":"text_delta","delta":"secret"}\n\n');
	const reconstructed = (visible + continuation).trim().split("\n\n").map(frame => JSON.parse(frame.slice(6)).delta ?? "").join("");
	expect(reconstructed).not.toContain("provider-secret");
	expect(reconstructed).toContain("[REDACTED]");
});
