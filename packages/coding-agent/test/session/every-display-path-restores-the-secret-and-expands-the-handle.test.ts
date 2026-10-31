/**
 * WHY: a person reads the session's content through one display copy. A placeholder a `secrets.yml`
 * regex produced is restored first, then an Argot handle the model wrote is expanded, on every path
 * that shows content: a finished reply, the rebuilt display context, the transcript every repaint
 * reads, and entries a viewer parsed off disk. The session file keeps both the placeholder and the
 * handle.
 *
 * The class this closes is "a display path that runs one transform and not the other, or runs the
 * second on the input instead of on the first one's output": each path is driven with one message
 * carrying both a placeholder and a handle, and the copy it shows must carry neither. It also pins
 * that the repaint transcript passes its options through to the transcript build: chronological
 * history with the compaction inline, the collapsed tail, and the tool call still in flight.
 *
 * Not caught here: the streamed `message_update` decode (`argot-adoption-loop-e2e.test.ts`,
 * `argot-agent-stream-display.test.ts`) and the withholding of vault secrets
 * (`secrets/renderpathsneverthrow-*.test.ts`). Mutants of the display copy that no observer can
 * tell apart, left unpinned: the empty-intent return in `toolIntent` (both transforms map "" to ""),
 * the `flush()` and the reset in `endStream` (the next assistant `message_start` replaces the
 * decoder, so only memory differs), the role check in `streamUpdate` (a decoder exists only while an
 * assistant message streams), and the unchanged-event return there (only the outer event object
 * differs).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { DICT_FILENAME, parseDict } from "argot";
import { createAssistantStopMessage } from "../helpers/agent-session";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const DICT = `
version = 1

[handles]
svc = "the checkout service"
`;
const HANDLE = "§svc";
const EXPANSION = "the checkout service";
const MATCHED = "ghp_abcdefghij0123456789";

const getConfigRoot = useIsolatedConfigRoot();

let registryRoot: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	registryRoot = TempDir.createSync("display-copy-registry-");
	authStorage = await AuthStorage.create(registryRoot.join("auth.db"));
	modelRegistry = new ModelRegistry(authStorage, registryRoot.join("models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await registryRoot.remove();
});

interface Fixture {
	session: AgentSession;
	/** The placeholder the regex secret redacts {@link MATCHED} to. */
	placeholder: string;
}

let root: TempDir | undefined;
let live: AgentSession | undefined;

afterEach(async () => {
	try {
		await live?.dispose();
	} finally {
		live = undefined;
		await root?.remove();
		root = undefined;
	}
});

/** A real session with a regex secret and a loaded Argot dictionary, the two display transforms. */
async function createFixture(): Promise<Fixture> {
	root = TempDir.createSync("display-copy-");
	const project = path.resolve(root.join("project"));
	await fs.mkdir(path.join(project, ".veyyon"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".veyyon", "secrets.yml"),
		'- type: regex\n  content: "ghp_[A-Za-z0-9]{20}"\n',
	);
	const settings = Settings.isolated({ "argot.enabled": true });
	const { session } = await createAgentSession({
		cwd: project,
		agentDir: path.resolve(root.join("agent")),
		sessionManager: SessionManager.inMemory(project),
		settings,
		modelRegistry,
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	live = session;
	settings.set("secrets.enabled", true);
	await session.refreshSecrets({ refreshPrompt: false });
	const argot = session.getArgotSession();
	if (argot === undefined) throw new Error("argot.enabled did not give the session a codec");
	argot.loadVocab(parseDict(DICT, path.join(getConfigRoot(), DICT_FILENAME)));
	// A regex mapping exists once the value has passed through redaction, which is how it arises in
	// a session: the text went out, so the map learned the value.
	const redacted = session.obfuscator?.obfuscate(`found ${MATCHED} here`) ?? "";
	const placeholder = redacted.slice("found ".length, redacted.indexOf(" here"));
	expect(placeholder.startsWith("#")).toBe(true);
	return { session, placeholder };
}

function assistantSaying(content: AssistantMessage["content"]): AssistantMessage {
	return { ...createAssistantStopMessage(""), content };
}

function userSaying(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** Each message as `role: text`, tool calls by id, so order and content read in one assertion. */
function lines(messages: AgentMessage[]): string[] {
	return messages.map(message => {
		if (message.role === "user") {
			return `user: ${typeof message.content === "string" ? message.content : ""}`;
		}
		if (message.role === "assistant") {
			const parts = message.content.map(block =>
				block.type === "text" ? block.text : block.type === "toolCall" ? `[call ${block.id}]` : "",
			);
			return `assistant: ${parts.join(" ")}`;
		}
		return message.role;
	});
}

describe("the display copy", () => {
	it("shows a finished reply with the match restored and then the handle expanded, tool call included", async () => {
		const { session, placeholder } = await createFixture();
		const content: AssistantMessage["content"] = [
			{ type: "text", text: `found ${placeholder} in ${HANDLE}` },
			{
				type: "toolCall",
				id: "call_1",
				name: `probe_${placeholder}`,
				intent: `checking ${placeholder} on ${HANDLE}`,
				arguments: { target: `${placeholder} at ${HANDLE}` },
			},
		];

		expect(session.displayAssistantContent(content)).toEqual([
			{ type: "text", text: `found ${MATCHED} in ${EXPANSION}` },
			{
				type: "toolCall",
				id: "call_1",
				name: `probe_${MATCHED}`,
				intent: `checking ${MATCHED} on ${EXPANSION}`,
				arguments: { target: `${MATCHED} at ${EXPANSION}` },
			},
		]);
		// The copy is new; what history holds is untouched.
		expect(content[0]).toEqual({ type: "text", text: `found ${placeholder} in ${HANDLE}` });
	});

	it("shows a tool intent with the match restored and then the handle expanded", async () => {
		const { session, placeholder } = await createFixture();
		expect(session.displayToolIntent(`checking ${placeholder} on ${HANDLE}`)).toBe(
			`checking ${MATCHED} on ${EXPANSION}`,
		);
		expect(session.displayToolIntent(undefined)).toBeUndefined();
	});

	it("rebuilds the display context and the repaint transcript with both transforms, keeping the file raw", async () => {
		const { session, placeholder } = await createFixture();
		session.sessionManager.appendMessage(userSaying("check it"));
		session.sessionManager.appendMessage(
			assistantSaying([{ type: "text", text: `found ${placeholder} in ${HANDLE}` }]),
		);
		const shown = ["user: check it", `assistant: found ${MATCHED} in ${EXPANSION}`];

		expect(lines(session.buildDisplaySessionContext().messages)).toEqual(shown);
		expect(lines(session.buildTranscriptSessionContext().messages)).toEqual(shown);
		expect(lines(session.sessionManager.buildSessionContext().messages)).toEqual([
			"user: check it",
			`assistant: found ${placeholder} in ${HANDLE}`,
		]);
	});

	it("expands the handle in entries a viewer parsed off disk and leaves the entries it was given alone", async () => {
		const { session } = await createFixture();
		session.sessionManager.appendMessage(assistantSaying([{ type: "text", text: `restarted ${HANDLE}` }]));
		const entries = session.sessionManager.getBranch().flatMap(entry => (entry.type === "message" ? [entry] : []));

		const expanded = session.expandArgotEntries(entries);

		expect(lines(expanded.map(entry => entry.message))).toEqual([`assistant: restarted ${EXPANSION}`]);
		expect(lines(entries.map(entry => entry.message))).toEqual([`assistant: restarted ${HANDLE}`]);
	});

	describe("the repaint transcript passes its options to the transcript build", () => {
		/**
		 * One compaction kept the second exchange, and the turn after it holds a call whose result is
		 * not on the branch yet: the shape of a session compacted once and mid-tool now.
		 */
		async function compactedSessionMidCall(): Promise<AgentSession> {
			const { session } = await createFixture();
			const store = session.sessionManager;
			store.appendMessage(userSaying("first question"));
			store.appendMessage(assistantSaying([{ type: "text", text: "first answer" }]));
			const keptId = store.appendMessage(userSaying("second question"));
			store.appendMessage(assistantSaying([{ type: "text", text: "second answer" }]));
			store.appendCompaction("the first exchange, summarized", undefined, keptId, 1000);
			store.appendMessage(userSaying("third question"));
			store.appendMessage(
				assistantSaying([
					{ type: "text", text: `looking at ${HANDLE}` },
					{ type: "toolCall", id: "call_live", name: "read", arguments: { path: "a.ts" } },
				]),
			);
			return session;
		}

		it("keeps the history a compaction replaced, with the compaction where it fired", async () => {
			const session = await compactedSessionMidCall();
			expect(lines(session.buildTranscriptSessionContext().messages)).toEqual([
				"user: first question",
				"assistant: first answer",
				"user: second question",
				"assistant: second answer",
				"compactionSummary",
				"user: third question",
				`assistant: looking at ${EXPANSION}`,
			]);
		});

		it("drops the replaced history when asked to collapse it", async () => {
			const session = await compactedSessionMidCall();
			expect(lines(session.buildTranscriptSessionContext({ collapseCompactedHistory: true }).messages)).toEqual([
				"user: second question",
				"assistant: second answer",
				"compactionSummary",
				"user: third question",
				`assistant: looking at ${EXPANSION}`,
			]);
		});

		it("keeps the call still in flight when asked to", async () => {
			const session = await compactedSessionMidCall();
			const transcript = lines(session.buildTranscriptSessionContext({ keepDanglingToolCalls: true }).messages);
			expect(transcript.at(-1)).toBe(`assistant: looking at ${EXPANSION} [call call_live]`);
		});
	});
});
