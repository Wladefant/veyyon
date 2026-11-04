/**
 * The model endpoint proof/scenes/agents-irc-wake.sh records against.
 *
 * WHY A SCRIPTED ENDPOINT. The scene is about what the terminal shows while a spawned
 * agent runs a turn that an IRC message woke. Reaching that state takes three model
 * decisions in order: spawn a named agent, let it finish, then message it. The 1.5B the
 * other scenes use does not make those calls on cue, so a take would record whatever the
 * weights felt like doing. Everything else in the take is the shipped product: the real
 * CLI, the real `task` and `irc` tools, the agent registry, the observer registry and
 * the Agents block. Only the provider is replaced, which is the one boundary a
 * recording cannot run for real.
 *
 * It speaks the OpenAI chat-completions stream the `local` provider in
 * home-seed/profiles/default/agent/models.yml is configured for, and it decides from the
 * request alone, so a retry or a second request for the same turn gets the same answer:
 *
 *   main session, nothing spawned yet  -> `task` call spawning Scout
 *   main session, after the task result -> `job` wait, so Scout's first run ends first
 *   main session, after the job result  -> `irc` send to Scout, which is idle by now
 *   main session, after the irc result  -> a short closing sentence
 *   Scout, first run                    -> `yield` straight away
 *   Scout, woken by the IRC message     -> a reply streamed over WAKE_STREAM_MS, then `yield`
 *
 *   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
 *     --mount type=bind,src="$PWD/proof/docker",dst=/srv,readonly \
 *     veyyon-proof-recorder:<tag> bun /srv/irc-wake-model.ts
 */
import * as http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 8080);
/** How long the woken turn streams: long enough to photograph the Agents block while it runs. */
const WAKE_STREAM_MS = Number(process.env.WAKE_STREAM_MS ?? 60_000);
const AGENT = "Scout";
/** Carried by the IRC message, so the woken turn can be told apart from the first run. */
const WAKE_MARKER = "recheck the refill window";

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
	const ircTool = toolNamed(tools, "irc");
	const jobTool = toolNamed(tools, "job");

	if (yieldTool) {
		const wakeAt = messages.findIndex(message => message.role !== "system" && text(message.content).includes(WAKE_MARKER));
		const answeredAfter = (from: number) => messages.slice(from + 1).some(message => message.role === "assistant");
		if (wakeAt === -1) {
			if (answeredAfter(0)) return { kind: "text", text: "Done." };
			return {
				kind: "tool",
				name: yieldTool,
				args: { result: { data: { finding: "The limiter refills tokens once per window; no defect found." } } },
			};
		}
		if (answeredAfter(wakeAt)) {
			const last = messages[messages.length - 1];
			if (last?.role === "tool") return { kind: "text", text: "Done." };
			return {
				kind: "tool",
				name: yieldTool,
				args: { result: { data: { finding: "Refill window rechecked: tokens refill at the window edge." } } },
			};
		}
		return {
			kind: "text",
			paceMs: WAKE_STREAM_MS,
			text:
				"Rechecking the refill window in the rate limiter. The window starts at the first request, " +
				"tokens refill once the window elapses, and a burst at the edge sees a full bucket. " +
				"I am walking through each branch of the refill logic again to confirm the edge case holds, " +
				"then I will report back.",
		};
	}

	if (taskTool && ircTool && jobTool) {
		const toolResults = messages.filter(message => message.role === "tool");
		if (toolResults.length === 0) {
			return {
				kind: "tool",
				name: taskTool,
				args: {
					context:
						"# Goal\nReview the rate limiter.\n# Constraints\nRead only; edit nothing.\n# Contract\nReport one observation.",
					tasks: [
						{
							name: AGENT,
							task:
								"# Target\nsrc/rate-limiter.ts\n# Change\nRead the refill logic; edit nothing.\n# Acceptance\nOne observation about the refill window.",
						},
					],
				},
			};
		}
		const callNames = new Map<string, string>();
		for (const message of messages) {
			for (const call of message.tool_calls ?? []) callNames.set(call.id, call.function.name);
		}
		const lastCall = callNames.get(toolResults[toolResults.length - 1]?.tool_call_id ?? "");
		// `task` returns while the spawn is still running, and a message to a running agent
		// is folded into its turn instead of waking one. Waiting on the job first is what
		// makes the send land on an idle agent, which is the state the scene is about.
		if (lastCall === taskTool) return { kind: "tool", name: jobTool, args: {} };
		if (lastCall === jobTool) {
			return {
				kind: "tool",
				name: ircTool,
				args: { op: "send", to: AGENT, message: `Please ${WAKE_MARKER} once more and report back.` },
			};
		}
		return { kind: "text", text: `Sent ${AGENT} a follow-up. It is rechecking the refill window now.` };
	}

	return { kind: "text", text: "Rate limiter review" };
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
		const request = JSON.parse(body) as ChatRequest;
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
	process.stderr.write(`irc-wake-model listening on ${PORT}\n`);
});
