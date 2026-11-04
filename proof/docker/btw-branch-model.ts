/**
 * The model endpoint proof/scenes/btw-branch-guards.sh records against.
 *
 * WHY A SCRIPTED ENDPOINT. The scene photographs the /btw panel in two states that
 * depend on timing: a side answer that completes while the main turn is still
 * streaming, and a branch that is in flight. Both need the main turn to run for a
 * known length and the side answer to arrive at once. A real model does neither on
 * cue. Everything else in the take is the shipped product: the CLI, /btw, the panel,
 * the session and its branch. Only the provider is replaced, which is the one
 * boundary a recording cannot run for real.
 *
 * It speaks the OpenAI chat-completions stream the `local` provider in
 * home-seed/profiles/default/agent/models.yml is configured for, and it decides from
 * the request alone:
 *
 *   last user message carries <btw>  -> a one-sentence side answer, streamed fast
 *                                       (a question about what empties the bucket gets a second one)
 *   any other request with tools     -> the main reply, streamed over MAIN_STREAM_MS
 *   anything else (a title request)  -> a short title
 *
 *   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
 *     --mount type=bind,src="$PWD/proof/docker",dst=/srv,readonly \
 *     veyyon-proof-recorder:<tag> bun /srv/btw-branch-model.ts
 */
import * as http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 8080);
/** How long the main reply streams: long enough to ask /btw and photograph its answer mid-turn. */
const MAIN_STREAM_MS = Number(process.env.MAIN_STREAM_MS ?? 30_000);

interface ChatMessage {
	role: string;
	content?: unknown;
}
interface ChatRequest {
	messages?: ChatMessage[];
	tools?: unknown[];
	model?: string;
}

interface Reply {
	text: string;
	paceMs?: number;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map(part => (typeof part === "object" && part && "text" in part ? String(part.text) : "")).join("");
	}
	return "";
}

function decide(request: ChatRequest): Reply {
	const messages = request.messages ?? [];
	const lastUser = [...messages].reverse().find(message => message.role === "user");
	const side = lastUser ? text(lastUser.content) : "";
	if (side.includes("<btw>")) {
		if (side.includes("empties the bucket")) {
			return { text: "Requests empty it, one token each; an empty bucket waits for the window to close." };
		}
		return { text: "The bucket starts full: ten tokens, refilled once per window." };
	}
	if ((request.tools ?? []).length > 0) {
		return {
			paceMs: MAIN_STREAM_MS,
			text:
				"Walking through the refill window. The window opens on the first request and the bucket " +
				"starts full. Each request takes one token, and a request that finds the bucket empty waits " +
				"for the window to close. When the window closes the bucket refills in one step, not token by " +
				"token, so a burst at the edge of a window sees a full bucket again. Nothing carries over " +
				"between windows. That is the whole refill path.",
		};
	}
	return { text: "Rate limiter refill window" };
}

function chunk(id: string, model: string, delta: object, finish: string | null = null): string {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

async function stream(res: http.ServerResponse, request: ChatRequest, reply: Reply): Promise<void> {
	const id = `chatcmpl-${Date.now()}`;
	const model = request.model ?? "scripted";
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	res.write(chunk(id, model, { role: "assistant", content: "" }));
	const words = reply.text.split(/(?<= )/);
	const pause = reply.paceMs ? reply.paceMs / words.length : 15;
	for (const word of words) {
		if (res.destroyed) return;
		res.write(chunk(id, model, { content: word }));
		await sleep(pause);
	}
	res.write(chunk(id, model, {}, "stop"));
	res.write(
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [],
			usage: { prompt_tokens: 4000, completion_tokens: 60, total_tokens: 4060 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url?.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
		return;
	}
	if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
		res.writeHead(404);
		res.end();
		return;
	}
	let body = "";
	req.setEncoding("utf8");
	req.on("data", part => {
		body += part;
	});
	req.on("end", () => {
		const request = JSON.parse(body) as ChatRequest;
		const reply = decide(request);
		process.stderr.write(
			`${new Date().toISOString()} messages=${request.messages?.length ?? 0} tools=${request.tools?.length ?? 0} -> ${reply.text.slice(0, 40)}\n`,
		);
		stream(res, request, reply).catch(error => {
			process.stderr.write(`stream failed: ${String(error)}\n`);
			res.destroy();
		});
	});
});

server.listen(PORT, "0.0.0.0", () => {
	process.stderr.write(`btw-branch-model listening on ${PORT}\n`);
});
