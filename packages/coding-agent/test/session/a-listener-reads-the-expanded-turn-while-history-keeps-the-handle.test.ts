/**
 * WHY: argot handles (`§svc`) are the model's shorthand. History keeps them,
 * because the token saving lives in what is sent back next turn, and every
 * surface a person reads expands them. `AgentSession` is the choke point: it
 * receives the agent's raw events and re-emits them to every listener (the
 * terminal, `--print`, ACP, the collab relay). A listener that receives a raw
 * handle shows it to a person.
 *
 * The suite drives a real turn through a real session with a loaded
 * vocabulary and reads what a subscriber receives for each event that carries
 * a whole assistant message (`message_end`, `turn_end`, `agent_end`), then
 * reads what the agent and the session branch kept. It closes the class "an
 * event re-emitted without the display expansion" for those events, and the
 * opposite class "the expansion written back into history".
 *
 * Not covered: the streamed `message_update` preview, which decodes deltas
 * through its own decoder (`argot-agent-stream-display.test.ts`), and the
 * secret-masking expander that shares the display path
 * (`secrets/redaction-outlives-expansion-on-every-outbound-seam.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake, TempDir } from "@veyyon/utils";
import { ArgotSession, DICT_FILENAME, parseDict } from "argot";

const DICT = `
version = 1

[handles]
svc = "the checkout service"
`;
const REPLY = "I restarted §svc for you.";
const EXPANDED = "I restarted the checkout service for you.";

function assistantText(message: AgentMessage | undefined): string | undefined {
	if (message?.role !== "assistant") return undefined;
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

describe("AgentSession display expansion", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-display-expansion-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
			await tempDir.remove();
		}
	});

	async function runTurn(): Promise<{ events: AgentSessionEvent[]; session: AgentSession }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const mock = createMockModel({ responses: [{ content: [REPLY] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const argot = new ArgotSession();
		argot.loadVocab(parseDict(DICT, `/repo/${DICT_FILENAME}`));
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join(`models-${Snowflake.next()}.yml`)),
			argot,
		});
		session = created;
		const events: AgentSessionEvent[] = [];
		created.subscribe(event => {
			events.push(event);
		});
		await created.prompt("restart it");
		await created.waitForIdle();
		return { events, session: created };
	}

	it.each(["message_end", "turn_end"] as const)("a %s listener reads the expanded reply", async type => {
		const { events } = await runTurn();
		const texts = events
			.filter(event => event.type === type)
			.map(event =>
				event.type === "message_end" || event.type === "turn_end" ? assistantText(event.message) : undefined,
			)
			.filter(text => text !== undefined);
		expect(texts).toEqual([EXPANDED]);
	});

	it("an agent_end listener reads the expanded reply among the turn's messages", async () => {
		const { events } = await runTurn();
		const ends = events.filter(event => event.type === "agent_end");
		expect(ends).toHaveLength(1);
		const end = ends[0];
		const texts = end?.type === "agent_end" ? end.messages.map(assistantText).filter(text => text !== undefined) : [];
		expect(texts).toEqual([EXPANDED]);
	});

	it("the agent's history and the session branch keep the handle", async () => {
		const { session: ran } = await runTurn();
		expect(ran.agent.state.messages.map(assistantText).filter(text => text !== undefined)).toEqual([REPLY]);
		const persisted = ran.sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" ? [assistantText(entry.message)] : []))
			.filter(text => text !== undefined);
		expect(persisted).toEqual([REPLY]);
	});
});
