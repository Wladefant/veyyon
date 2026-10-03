/**
 * The model endpoint proof/scenes/agent-hud-click.sh records against.
 *
 * WHY A SCRIPTED ENDPOINT. The scene clicks an agent's row in the Agents block, and the
 * block lists an agent only while it runs detached. Reaching that state takes one model
 * decision (spawn two named agents) and two agents that stay busy long enough to click.
 * The 1.5B the other scenes use does neither on cue. Everything else in the take is the
 * shipped product: the real CLI, the real `task` tool, the observer registry, the Agents
 * block, the engine's mouse routing and the focus controller. Only the provider is
 * replaced, which is the one boundary a recording cannot run for real.
 *
 * It speaks the OpenAI chat-completions stream the `local` provider in
 * home-seed/profiles/default/agent/models.yml is configured for, and decides from the
 * request alone:
 *
 *   main session, nothing spawned yet   -> `task` call spawning Scout and Linter
 *   main session, after the task result -> a short closing sentence
 *   a spawned agent, first request      -> a reply streamed over RUN_STREAM_MS
 *   a spawned agent, after replying     -> `yield`
 *   no tools (the spawn's label request)-> a short label taken from the assignment
 *
 *   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
 *     --mount type=bind,src="$PWD/proof/docker",dst=/srv,readonly \
 *     veyyon-proof-recorder:<tag> bun /srv/hud-click-model.ts
 */
import * as http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 8080);
/** How long each spawned agent streams: long enough to click its row and photograph the result. */
const RUN_STREAM_MS = Number(process.env.RUN_STREAM_MS ?? 180_000);

interface ToolSpec {
	function?: { name?: string };
}
interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: { id: string; function: { name: string } }[];
	tool_call_id?: string;
}
interface ChatRequest {
	messages?: ChatMessage[];
	tools?: ToolSpec[];
	model?: string;
}

type Reply = { kind: "text"; text: string; paceMs?: number } | { kind: "tool"; name: string; args: unknown };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map(part => (typeof part === "object" && part && "text" in part ? String(part.text) : "")).join("");
	}
	return "";
}

function toolNamed(tools: ToolSpec[], base: string): string | undefined {
	return tools.map(tool => tool.function?.name ?? "").find(name => name === base || name.endsWith(`_${base}`));
}

function decide(request: ChatRequest): Reply {
	const messages = request.messages ?? [];
	const tools = request.tools ?? [];
	const yieldTool = toolNamed(tools, "yield");
	const taskTool = toolNamed(tools, "task");
	const transcript = messages.map(message => text(message.content)).join("\n");

	if (yieldTool) {
		const answered = messages.some(message => message.role === "assistant");
		if (answered) {
			return { kind: "tool", name: yieldTool, args: { result: { data: { finding: "Reviewed; nothing to change." } } } };
		}
		const linter = transcript.includes("biome.json");
		return {
			kind: "text",
			paceMs: RUN_STREAM_MS,
			text: linter
				? "Reading biome.json rule by rule and checking each against the files it governs. " +
					"Every rule that never fires is listed, then every rule that fires on generated code."
				: "Reading the refill logic in the rate limiter branch by branch. The window starts at the " +
					"first request, tokens refill once it elapses, and a burst at the edge sees a full bucket.",
		};
	}

	if (taskTool) {
		if (!messages.some(message => message.role === "tool")) {
			return {
				kind: "tool",
				name: taskTool,
				args: {
					context: "# Goal\nTwo read-only reviews.\n# Constraints\nRead only; edit nothing.\n# Contract\nOne finding each.",
					tasks: [
						{
							name: "Scout",
							task: "# Target\nsrc/rate-limiter.ts\n# Change\nRead the refill logic; edit nothing.\n# Acceptance\nOne finding.",
						},
						{
							name: "Linter",
							task: "# Target\nbiome.json\n# Change\nRead the lint rules; edit nothing.\n# Acceptance\nOne finding.",
						},
					],
				},
			};
		}
		return { kind: "text", text: "Scout and Linter are running in the background." };
	}

	return { kind: "text", text: transcript.includes("biome.json") ? "Lint rule audit" : "Rate limiter review" };
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
	let finish: string;
	if (reply.kind === "text") {
		const words = reply.text.split(/(?<= )/);
		const pause = reply.paceMs ? reply.paceMs / words.length : 15;
		for (const word of words) {
			if (res.destroyed) return;
			res.write(chunk(id, model, { content: word }));
			await sleep(pause);
		}
		finish = "stop";
	} else {
		await sleep(400);
		res.write(
			chunk(id, model, {
				tool_calls: [
					{
						index: 0,
						id: `call_${Date.now()}`,
						type: "function",
						function: { name: reply.name, arguments: JSON.stringify(reply.args) },
					},
				],
			}),
		);
		finish = "tool_calls";
	}
	res.write(chunk(id, model, {}, finish));
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
		const request: ChatRequest = JSON.parse(body);
		const reply = decide(request);
		const tools = (request.tools ?? []).map(tool => tool.function?.name).join(",");
		process.stderr.write(
			`${new Date().toISOString()} messages=${request.messages?.length ?? 0} tools=[${tools}] -> ${
				reply.kind === "tool" ? `${reply.name}(${JSON.stringify(reply.args).slice(0, 80)})` : `text(${reply.text.slice(0, 40)})`
			}\n`,
		);
		stream(res, request, reply).catch(error => {
			process.stderr.write(`stream failed: ${String(error)}\n`);
			res.destroy();
		});
	});
});

server.listen(PORT, "0.0.0.0", () => {
	process.stderr.write(`hud-click-model listening on ${PORT}\n`);
});
