import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

/** The `return` statement of a `session_before_compact` handler that commits a fixed summary over the prepared cut. */
export const SHORT_CIRCUIT_COMPACTION_RETURN = [
	"\t\treturn {",
	"\t\t\tcompaction: {",
	'\t\t\t\tsummary: "compacted",',
	"\t\t\t\tshortSummary: undefined,",
	"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
	"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
	"\t\t\t\tdetails: {},",
	"\t\t\t},",
	"\t\t};",
].join("\n");

/** An extension whose `session_before_compact` handler commits a fixed summary, so a pass makes no LLM call. */
const SHORT_CIRCUIT_COMPACTION_EXTENSION = [
	"export default function(pi) {",
	'\tpi.on("session_before_compact", async (event) => {',
	SHORT_CIRCUIT_COMPACTION_RETURN,
	"\t});",
	"}",
].join("\n");

export interface CompactionSessionOptions {
	/** Extension source loaded into the session. Defaults to the short-circuit summarizer. */
	extensionSource?: string;
	/** Settings of the session. Defaults to automatic continuation after compaction. */
	settings?: Partial<Record<SettingPath, unknown>>;
	/** Context window of the session model. Defaults to 200k. */
	contextWindow?: number;
}

export interface CompactionSession {
	tempDir: TempDir;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	session: AgentSession;
}

/**
 * A real `AgentSession` on `claude-sonnet-4-5` whose compaction summarizer is an extension, so a compaction pass runs
 * its production tail (events, progress guard, rescue tiers, continuation scheduling) without an LLM call.
 *
 * The window and output reservation are pinned (200k/64k by default) so usage figures tuned to the threshold do not
 * shift when the catalog is regenerated. The branch holds one user message, so `prepareCompaction` returns a preparation.
 */
export async function createCompactionSession(
	tempDirPrefix: string,
	options: CompactionSessionOptions = {},
): Promise<CompactionSession> {
	const tempDir = TempDir.createSync(tempDirPrefix);
	const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
	fs.mkdirSync(extensionsDir, { recursive: true });
	const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
	fs.writeFileSync(extensionPath, options.extensionSource ?? SHORT_CIRCUIT_COMPACTION_EXTENSION);

	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

	const extensionsResult = await loadExtensions([extensionPath], tempDir.path(), undefined, undefined, {
		configuredPaths: [extensionPath],
	});
	const extensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		tempDir.path(),
		sessionManager,
		modelRegistry,
	);

	const bundled = requireBundledModel("anthropic", "claude-sonnet-4-5");
	const model = { ...bundled, contextWindow: options.contextWindow ?? 200_000, maxTokens: 64_000 };
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });

	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(options.settings ?? { "compaction.autoContinue": true }),
		modelRegistry,
		extensionRunner,
	});
	return { tempDir, authStorage, modelRegistry, sessionManager, session };
}

/** An assistant turn billed at 191k tokens, which trips the compaction threshold of a 200k/64k model. */
export function highUsageAssistant() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		stopReason: "stop" as const,
		usage: { ...emptyUsage(), input: 190_000, output: 1_000, totalTokens: 191_000 },
		timestamp: Date.now(),
	};
}
