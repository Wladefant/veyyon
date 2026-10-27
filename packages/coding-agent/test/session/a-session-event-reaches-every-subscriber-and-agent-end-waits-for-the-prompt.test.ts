/**
 * WHY THIS SUITE EXISTS. `SessionEvents` is the one road every session event takes to the TUI, the
 * RPC and ACP bridges and the extensions. A subscriber that throws, or one that unsubscribes while it
 * runs, must not cost the next subscriber the event; the wire-level `agent_end` that tells a client the
 * session is idle must wait for the prompt that is still unwinding, or the client sends its next
 * prompt into a session that still reports itself busy; and a streamed `message_update` must reach the
 * screen without waiting for a slow extension handler, while the extensions still see the deltas in
 * the order they streamed.
 *
 * THE CLASS. Subscriber isolation (a throw, a rejection, an unsubscribe during delivery, an
 * unsubscribe called twice), the order of extension and subscriber delivery for each kind of send,
 * the held `agent_end` (held while in flight, replaced by a later one, delivered once), a detached
 * send whose extension path fails, and a disposed session reaching no subscriber. Driven through a
 * real `ExtensionRunner` with an extension loaded from disk, and a real `AgentSession` for dispose.
 *
 * WHAT IT DOES NOT CATCH. Which session paths call `send` rather than `emit`; the session's own
 * routing of agent events is covered where those events are produced.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionEvents } from "@veyyon/coding-agent/session/runtime/session-events";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/** Shared with the extension through `globalThis`, because the extension is a module loaded from disk. */
interface Sink {
	readonly order: string[];
	/** While set, the next `message_update` handler takes it and waits on it before recording. */
	hold: Promise<void> | undefined;
	/** The event type whose handler throws. */
	throwOn: string | undefined;
}

const SINK_KEY = "__sessionEventsSink";

const RECORDER = `
export default function (pi) {
	const sink = globalThis[${JSON.stringify(SINK_KEY)}];
	for (const type of ["turn_start", "message_start", "message_update"]) {
		pi.on(type, async event => {
			// A handler that yields before it records, as a real one awaiting its own work does.
			await Promise.resolve();
			if (sink.throwOn === type) throw new Error("handler failed");
			if (type === "message_update" && sink.hold) {
				const hold = sink.hold;
				sink.hold = undefined;
				await hold;
			}
			const delta = event.assistantMessageEvent?.delta;
			sink.order.push(delta === undefined ? "extension:" + type : "extension:" + type + ":" + delta);
		});
	}
}
`;

let tempDir: TempDir;
let authStorage: AuthStorage;
let runner: ExtensionRunner;
const sink: Sink = { order: [], hold: undefined, throwOn: undefined };
const globals = globalThis as Record<string, unknown>;

beforeAll(async () => {
	tempDir = TempDir.createSync("@session-events-");
	const projectDir = tempDir.join("project");
	fs.mkdirSync(projectDir, { recursive: true });
	// Outside the project directory, so the loader treats it as the operator's own extension.
	const extensionPath = tempDir.join("recorder.ts");
	fs.writeFileSync(extensionPath, RECORDER);
	globals[SINK_KEY] = sink;

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const loaded = await loadExtensions([extensionPath], projectDir);
	expect(loaded.errors).toEqual([]);
	runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		projectDir,
		SessionManager.inMemory(),
		new ModelRegistry(authStorage),
	);
});

afterEach(() => {
	sink.order.length = 0;
	sink.hold = undefined;
	sink.throwOn = undefined;
	vi.restoreAllMocks();
});

afterAll(() => {
	delete globals[SINK_KEY];
	authStorage?.close();
	tempDir?.removeSync();
});

/** The stream under test, with its in-flight state under the test's control. */
function stream(): { events: SessionEvents; inFlight: { value: boolean } } {
	const inFlight = { value: false };
	return { events: new SessionEvents(runner, { promptInFlight: () => inFlight.value }), inFlight };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1_756_080_000 };
}

function agentEnd(text: string): AgentSessionEvent {
	return { type: "agent_end", messages: [userMessage(text)] };
}

function update(delta: string): AgentSessionEvent {
	const partial = createAssistantMessage(delta);
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
	};
}

/** What a subscriber saw, one label per event: the type, and the text an `agent_end` carried. */
function label(event: AgentSessionEvent): string {
	if (event.type === "agent_end") {
		const first = event.messages[0];
		return `agent_end:${first?.role === "user" ? first.content : "?"}`;
	}
	if (event.type === "notice") return `notice:${event.message}`;
	return event.type;
}

async function drainMicrotasks(): Promise<void> {
	for (let tick = 0; tick < 100; tick++) await Promise.resolve();
}

describe("a session event reaches every subscriber", () => {
	it("still reaches a subscriber after one that throws and one that rejects", async () => {
		const { events } = stream();
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		const seen: string[] = [];
		events.subscribe(() => {
			throw new Error("subscriber threw");
		});
		events.subscribe(async () => {
			throw new Error("subscriber rejected");
		});
		events.subscribe(event => {
			seen.push(label(event));
		});

		events.emit({ type: "notice", level: "info", message: "hello" });
		await drainMicrotasks();

		expect(seen).toEqual(["notice:hello"]);
		expect(warnings.sort()).toEqual(["AgentSession listener rejected", "AgentSession listener threw"]);
	});

	it("delivers the event to the next subscriber when one unsubscribes while it runs", () => {
		const { events } = stream();
		const seen: string[] = [];
		const unsubscribe = events.subscribe(() => {
			seen.push("once");
			unsubscribe();
		});
		events.subscribe(() => {
			seen.push("always");
		});

		events.emit({ type: "notice", level: "info", message: "first" });
		events.emit({ type: "notice", level: "info", message: "second" });

		expect(seen).toEqual(["once", "always", "always"]);
	});

	it("removes nothing else when an unsubscribe runs a second time", () => {
		const { events } = stream();
		const seen: string[] = [];
		const unsubscribe = events.subscribe(() => {
			seen.push("first");
		});
		events.subscribe(() => {
			seen.push("last");
		});

		unsubscribe();
		unsubscribe();
		events.emit({ type: "notice", level: "info", message: "after" });

		expect(seen).toEqual(["last"]);
	});

	it("reaches no subscriber once the stream is cleared", () => {
		const { events } = stream();
		const seen: string[] = [];
		events.subscribe(event => {
			seen.push(label(event));
		});

		events.clear();
		events.emit({ type: "notice", level: "info", message: "after dispose" });

		expect(seen).toEqual([]);
	});

	it("reaches the extensions and then the subscribers when sent", async () => {
		const { events } = stream();
		events.subscribe(event => {
			sink.order.push(`subscriber:${event.type}`);
		});

		await events.send({ type: "turn_start" });

		expect(sink.order).toEqual(["extension:turn_start", "subscriber:turn_start"]);
	});

	it("reaches no extension when emitted", async () => {
		const { events } = stream();
		events.subscribe(event => {
			sink.order.push(`subscriber:${event.type}`);
		});

		events.emit({ type: "turn_start" });
		await drainMicrotasks();

		expect(sink.order).toEqual(["subscriber:turn_start"]);
	});
});

describe("a streamed delta reaches the screen without waiting for an extension", () => {
	it("hands each delta to the subscribers at once and to the extensions in stream order", async () => {
		const { events } = stream();
		events.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				sink.order.push(`subscriber:${event.assistantMessageEvent.delta}`);
			}
		});
		const release = Promise.withResolvers<void>();
		sink.hold = release.promise;

		await events.send(update("a"));
		await events.send(update("b"));
		await drainMicrotasks();
		expect(sink.order).toEqual(["subscriber:a", "subscriber:b"]);

		release.resolve();
		await drainMicrotasks();
		expect(sink.order).toEqual([
			"subscriber:a",
			"subscriber:b",
			"extension:message_update:a",
			"extension:message_update:b",
		]);
	});
});

describe("the wire-level agent_end waits for the prompt that is unwinding", () => {
	it("reaches the subscribers at once when no prompt is in flight", async () => {
		const { events } = stream();
		const seen: string[] = [];
		events.subscribe(event => {
			seen.push(label(event));
		});

		await events.send(agentEnd("settled"));

		expect(seen).toEqual(["agent_end:settled"]);
	});

	it("is held while a prompt is in flight and delivered once, the latest one, on release", async () => {
		const { events, inFlight } = stream();
		const seen: string[] = [];
		events.subscribe(event => {
			seen.push(label(event));
		});

		inFlight.value = true;
		await events.send(agentEnd("first run"));
		await events.send(agentEnd("compaction run"));
		expect(seen).toEqual([]);

		inFlight.value = false;
		events.releaseHeldAgentEnd();
		events.releaseHeldAgentEnd();

		expect(seen).toEqual(["agent_end:compaction run"]);
	});

	it("holds nothing but the agent_end", async () => {
		const { events, inFlight } = stream();
		const seen: string[] = [];
		events.subscribe(event => {
			seen.push(label(event));
		});

		inFlight.value = true;
		await events.send({ type: "turn_start" });

		expect(seen).toEqual(["turn_start"]);
	});
});

describe("a detached send whose extension path fails", () => {
	it("is logged with its context, reaches no subscriber and leaves no unhandled rejection", async () => {
		const { events } = stream();
		const warnings: Array<{ message: string; context: unknown }> = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, context?: Record<string, unknown>) => {
			warnings.push({ message, context: context?.context });
		});
		const seen: string[] = [];
		events.subscribe(event => {
			seen.push(label(event));
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		// The handler's own throw is caught by the runner and reported to its error listeners; a listener
		// that throws in turn is what makes the extension path fail.
		sink.throwOn = "message_start";
		const stopListening = runner.onError(() => {
			throw new Error("error listener failed");
		});
		try {
			events.sendDetached({ type: "message_start", message: userMessage("late") }, "late tool result");
			await drainMicrotasks();
			await new Promise(resolve => setImmediate(resolve));
		} finally {
			stopListening();
			process.off("unhandledRejection", onUnhandled);
		}

		expect(seen).toEqual([]);
		expect(warnings).toEqual([{ message: "session event emit failed", context: "late tool result" }]);
		expect(unhandled).toEqual([]);
	});
});

describe("a disposed session", () => {
	it("delivers nothing more to the subscribers it had", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] }, convertToLlm }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		session.emitNotice("info", "before dispose");
		await session.dispose();
		session.emitNotice("info", "after dispose");

		expect(notices).toEqual(["before dispose"]);
	});
});
