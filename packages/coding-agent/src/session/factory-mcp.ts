import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { $env, errorMessage, logger, postmortem, setProfileEnv } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import { isMCPToolName } from "../discovery/tool-index";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import {
	discoverAndLoadMCPTools,
	type MCPDiscoverOptions,
	type MCPGetPromptResult,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	parseMCPToolName,
} from "../mcp";
import type { MCPEventOccurrence } from "../mcp/types";
import type { MCPWebhookControl } from "../mcp/events-webhook";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../mcp/startup-events";
import type { Tool } from "../tools";
import type { EventBus } from "../utils/event-bus";
import type { AgentSession } from "./agent-session";
import { sessionCpuExecHooks } from "./cpu-limit";
import type { McpEventBatchDetails, McpEventEntry, McpNotificationEntry } from "./factory-notices";
import { type CreateAgentSessionOptions, isInProcessChildSession } from "./factory-options";

export type DeferredMCPActivation = {
	mcpDiscoveryEnabled: boolean;
	explicitlyRequestedMCPToolNames: string[];
	activateAllMCPTools: boolean;
};
interface MCPEventsManagerTarget {
	setOnEvent(
		handler:
			| ((
					serverName: string,
					event: MCPEventOccurrence,
					subscriptionKey: string,
				) => void | "queued" | "duplicate" | Promise<void | "queued" | "duplicate">)
			| undefined,
	): void;
	setOnEventCursor?(
		handler: ((serverName: string, subscriptionKey: string, cursor: string | null) => void | Promise<void>) | undefined,
	): void;
	setEventCursorProvider?(
		provider: ((serverName: string, subscriptionKey: string) => string | null | undefined) | undefined,
	): void;
	setOnEventControl?(
		handler:
			| ((
					serverName: string,
					subscriptionKey: string,
					message: MCPWebhookControl,
				) => void | "queued" | "duplicate" | Promise<void | "queued" | "duplicate">)
			| undefined,
	): void;
	clearOnEvent?(): void;
	stopEvents?(): void | Promise<void>;
}

export function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write", // not-a-tool-name: approval tier
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

export function collectPendingMCPToolNames(
	explicitToolNames: readonly string[] | undefined,
	restoredSelectedToolNames: readonly string[],
): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	for (const name of restoredSelectedToolNames) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

export function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

export function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		setProfileEnv("EXA_API_KEY", result.exaApiKeys[0]);
	}
}

/** The per-server instruction length the system prompt renders; longer instructions are clipped. */
export const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;

/** Per-server instructions clipped to {@link MAX_MCP_INSTRUCTIONS_LENGTH}, the text the prompt renders. */
export function clipMCPServerInstructions(instructions: Map<string, string>): Map<string, string> {
	if (instructions.size === 0) return instructions;
	const clipped = new Map<string, string>();
	for (const [server, text] of instructions) {
		clipped.set(
			server,
			text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
		);
	}
	return clipped;
}

/** `key=value` command arguments as prompt arguments. An argument with no key before its `=` is dropped. */
function promptArguments(args: string[]): Record<string, string> {
	const promptArgs: Record<string, string> = {};
	for (const arg of args) {
		const eqIdx = arg.indexOf("=");
		if (eqIdx > 0) promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
	}
	return promptArgs;
}

/** The text and resource-text parts of a prompt's messages, in order, separated by a blank line. */
function promptResultText(result: MCPGetPromptResult): string {
	const parts: string[] = [];
	for (const message of result.messages) {
		for (const item of Array.isArray(message.content) ? message.content : [message.content]) {
			if (item.type === "text") parts.push(item.text);
			else if (item.type === "resource" && item.resource.text) parts.push(item.resource.text);
		}
	}
	return parts.join("\n\n");
}

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
export function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const result = await manager.executePrompt(serverName, prompt.name, promptArguments(args));
						return result ? promptResultText(result) : "";
					},
				},
			});
		}
	}
	return commands;
}

/**
 * Enable tool discovery for the session when `tools.discoveryMode: "auto"` crosses its threshold
 * once `tools` join the registry. Resolves true when discovery is on afterwards.
 */
export type EnableDiscoveryForMCPTools = (liveSession: AgentSession, tools: CustomTool[]) => Promise<boolean>;

/** Connect a deferred manager's servers once the session exists. */
export type StartDeferredMCPDiscovery = (
	liveSession: AgentSession,
	activation: DeferredMCPActivation,
	enableDiscoveryForTools: EnableDiscoveryForMCPTools,
) => void;

export interface SessionMCPStartupInputs {
	cwd: string;
	/** The profile whose `mcp.json` the session reads, matching its rules, commands and skills. */
	agentDir: string;
	settings: Settings;
	authStorage: AuthStorage;
	eventBus: EventBus;
	/** Emit connection progress on the event bus for a host to draw. */
	hasUI: boolean;
	/** Construct the manager now and connect after the session exists, so no server delays first paint. */
	deferred: boolean;
}

export interface SessionMCPStartup {
	manager: MCPManager;
	/** Tools connected before the session exists. Empty when discovery is deferred. */
	tools: CustomTool[];
	/** Present when discovery is deferred. */
	startDeferred?: StartDeferredMCPDiscovery;
}

/** Create the session's MCP manager, connecting its servers now or once the session exists. */
export async function startSessionMCP(inputs: SessionMCPStartupInputs): Promise<SessionMCPStartup> {
	const { settings } = inputs;
	const startupQuiet = settings.get("startup.quiet");
	const discoverOptions: MCPDiscoverOptions = {
		onStatus: event => {
			if (!inputs.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			inputs.eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		},
		// Always filter Exa - we have native integration
		filterExa: true,
		// Filter browser MCP servers when builtin browser tool is active
		filterBrowser: settings.get("browser.enabled") ?? false,
		agentDir: inputs.agentDir,
	};
	const cacheStorage = AgentStorage.forAgentDir(settings.getAgentDir());

	if (inputs.deferred) {
		const manager = new MCPManager(inputs.cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
		manager.setAuthStorage(inputs.authStorage);
		if (settings.get("mcp.notifications")) manager.setNotificationsEnabled(true);
		return {
			manager,
			tools: [],
			startDeferred: (liveSession, activation, enableDiscoveryForTools) => {
				void connectDeferredMCP(manager, discoverOptions, liveSession, activation, enableDiscoveryForTools);
			},
		};
	}

	const result = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, inputs.cwd, {
		...discoverOptions,
		cacheStorage,
		authStorage: inputs.authStorage,
	});
	if (settings.get("mcp.notifications")) result.manager.setNotificationsEnabled(true);
	applyMCPEnvironment(result);
	for (const { path, error } of result.errors) {
		logger.error("MCP tool load failed", { path, error });
	}
	return { manager: result.manager, tools: result.tools.map(loaded => loaded.tool) };
}

/** What {@link openSessionMCP} reads. */
export interface SessionMCPInputs extends Omit<SessionMCPStartupInputs, "deferred" | "hasUI"> {
	/**
	 * `mcpManager` is the manager of the session that created this one, used as given; `enableMCP: false`
	 * turns MCP off; `toolNames` are the requested tools, whose MCP members are pending while a deferred
	 * discovery connects. A top-level session installs its manager as the process-wide one; a spawned
	 * agent already has its parent's.
	 */
	options: Pick<CreateAgentSessionOptions, "mcpManager" | "enableMCP" | "hasUI" | "toolNames" | "parentTaskPrefix">;
	/** The MCP tool selection the restored session recorded, pending the same way. */
	restoredSelectedToolNames: readonly string[];
}

/** A session's MCP manager and what its startup produced. */
export interface SessionMCP {
	/** The handed-down manager, or one startup created. Undefined when MCP is off. */
	readonly manager: MCPManager | undefined;
	/** The manager startup created, which routes its change callbacks to the session. */
	readonly createdManager: MCPManager | undefined;
	/** Tools connected before the session exists. */
	readonly tools: CustomTool[];
	/** Whether discovery connects once the session exists. */
	readonly deferred: boolean;
	/** The MCP tool names registered as pending until a deferred discovery connects. */
	readonly pendingToolNames: string[];
	readonly startDeferred: StartDeferredMCPDiscovery | undefined;
	/** Reads the manager's per-server instructions as the prompt renders them. */
	readonly serverInstructions: (() => Map<string, string>) | undefined;
}

/**
 * The session's MCP manager: the handed-down one, else one created here. A session with a UI
 * creates its manager now and connects its servers once the session exists, so no server delays
 * first paint; any other session connects them now.
 */
export async function openSessionMCP(inputs: SessionMCPInputs): Promise<SessionMCP> {
	const { options } = inputs;
	let manager = options.mcpManager;
	let started: SessionMCPStartup | undefined;
	const hasUI = options.hasUI === true;
	const create = (options.enableMCP ?? true) && !manager;
	const deferred = create && hasUI;
	if (create) {
		started = await startSessionMCP({ ...inputs, hasUI, deferred });
		manager = started.manager;
	}
	if (manager && !isInProcessChildSession(options)) MCPManager.setInstance(manager);
	const instructionsOf = manager;
	return {
		manager,
		createdManager: started?.manager,
		tools: started?.tools ?? [],
		deferred,
		pendingToolNames: deferred ? collectPendingMCPToolNames(options.toolNames, inputs.restoredSelectedToolNames) : [],
		startDeferred: started?.startDeferred,
		serverInstructions: instructionsOf && (() => clipMCPServerInstructions(instructionsOf.getServerInstructions())),
	};
}

async function connectDeferredMCP(
	manager: MCPManager,
	discoverOptions: MCPDiscoverOptions,
	liveSession: AgentSession,
	activation: DeferredMCPActivation,
	enableDiscoveryForTools: EnableDiscoveryForMCPTools,
): Promise<void> {
	try {
		const result = await logger.time("discoverAndLoadMCPTools", () => manager.discoverAndConnect(discoverOptions));
		// The session can be torn down while servers are still connecting.
		// Don't resurrect tools on a disposed session, and don't leak the
		// transports/subprocesses the connect just spawned.
		if (liveSession.isDisposed) {
			await manager.disconnectAll();
			return;
		}
		applyMCPEnvironment(result);
		logMCPLoadErrors(result.errors);
		// `tools.discoveryMode: "auto"` was resolved before deferred MCP
		// tools existed. Reconcile again before refresh so a large toolset
		// cannot bypass discovery by arriving after first paint.
		let discoveryEnabled = activation.mcpDiscoveryEnabled;
		let activateAll = activation.activateAllMCPTools;
		if (!discoveryEnabled && (await enableDiscoveryForTools(liveSession, result.tools))) {
			discoveryEnabled = true;
			activateAll = false;
		}
		await liveSession.refreshMCPTools(result.tools, { activateAll });
		const requested = activation.explicitlyRequestedMCPToolNames;
		if (requested.length === 0) return;
		if (discoveryEnabled && !activation.mcpDiscoveryEnabled) {
			// Discovery flipped on mid-flight: route the explicit request
			// through discovery-aware activation so selection persists.
			await liveSession.activateDiscoveredMCPTools(requested);
		} else if (!discoveryEnabled && !activateAll) {
			await liveSession.setActiveToolsByName([...liveSession.getActiveToolNames(), ...requested]);
		}
	} catch (error) {
		logger.error("MCP tool load failed", { path: ".mcp.json", error: errorMessage(error) });
	}
}

export interface ReactiveMCPInputs {
	manager: MCPManager;
	session: AgentSession;
	settings: Settings;
	/** Apply a changed server tool set to the session. */
	refreshTools: (tools: CustomTool[]) => Promise<void>;
}

/**
 * Route the manager's change callbacks to the session that created it: tool list changes,
 * prompt changes (the MCP prompt slash commands) and debounced resource notifications. The
 * manager's stdio servers join the session's CPU budget group.
 */
export function wireReactiveMCPManager({ manager, session, settings, refreshTools }: ReactiveMCPInputs): void {
	// MCP stdio servers are session-spawned processes: they join the
	// session's CPU budget group when one is configured, and a saturated
	// or uncreated group refuses a new server the same way it refuses bash.
	const cpu = sessionCpuExecHooks(() => session.sessionManager.getSessionId() ?? null);
	manager.setSpawnAdoption(cpu.adoptPid);
	manager.setSpawnGate(cpu.gate);
	manager.setOnToolsChanged(tools => {
		refreshTools(tools).catch(error => {
			logger.warn("MCP tool refresh failed", { error: errorMessage(error) });
		});
	});
	manager.setOnPromptsChanged(serverName => {
		session.setMCPPromptCommands(buildMCPPromptCommands(manager));
		logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
	});
	const debounceTimers = new Map<string, Timer>();
	postmortem.register("mcp-notification-cleanup", () => {
		for (const timer of debounceTimers.values()) clearTimeout(timer);
		debounceTimers.clear();
	});
	manager.setOnResourcesChanged((serverName, uri) => {
		logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
		if (!settings.get("mcp.notifications")) return;
		const key = `${serverName}:${uri}`;
		clearTimeout(debounceTimers.get(key));
		debounceTimers.set(
			key,
			setTimeout(() => {
				debounceTimers.delete(key);
				// Re-check: user may have disabled notifications during the debounce window
				if (!settings.get("mcp.notifications")) return;
				session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
			}, settings.get("mcp.notificationDebounceMs")),
		);
	});
	// Route MCP event occurrences to the creating session's yield queue only.
	// Payloads remain untrusted data; teardown detaches callback on dispose or process exit.
	if ("setOnEvent" in manager && typeof manager.setOnEvent === "function") {
		const eventsManager = manager as unknown as MCPEventsManagerTarget;
		const seenEventIds = new Set<string>();
		const cursors = new Map<string, string | null>();
		const pendingToReplay = new Map<string, McpEventEntry>();
		const durableReceipts = new Set<string>();
		let persistenceChain: Promise<void> = Promise.resolve();
		const serializePersistence = <T>(operation: () => Promise<T>): Promise<T> => {
			const result = persistenceChain.then(operation);
			persistenceChain = result.then(() => undefined, () => undefined);
			return result;
		};
		const ensureDurableJournal = async (): Promise<void> => {
			if (!session.sessionManager.getSessionFile()) {
				throw new Error("MCP event delivery requires a persistent session journal");
			}
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.sync();
		};
		const scopedId = (subscriptionKey: string, id: string) => `${subscriptionKey}\0${id}`;
		const journal = session.sessionManager.getEntries();

		for (const entry of journal) {
			if (entry.type === "custom_message" && entry.customType === "mcp-event") {
				const receipts = (entry.details as Partial<McpEventBatchDetails> | undefined)?.receipts;
				if (Array.isArray(receipts)) {
					for (const receipt of receipts) {
						if (
							receipt !== null &&
							typeof receipt === "object" &&
							"subscriptionKey" in receipt &&
							typeof receipt.subscriptionKey === "string" &&
							"id" in receipt &&
							typeof receipt.id === "string"
						) {
							durableReceipts.add(scopedId(receipt.subscriptionKey, receipt.id));
						}
					}
				}
				continue;
			}
			if (entry.type !== "custom" || entry.customType !== "mcp-events-state" || !entry.data) continue;
			const state = entry.data as {
				serverName?: string;
				subscriptionKey?: string;
				cursor?: string | null;
				event?: MCPEventOccurrence;
				control?: MCPWebhookControl;
				eventId?: string;
			};
			if (!state.subscriptionKey) continue;
			if (state.cursor === null || typeof state.cursor === "string") cursors.set(state.subscriptionKey, state.cursor);
			const id = state.eventId ?? state.control?.messageId;
			if (!id) continue;
			seenEventIds.add(scopedId(state.subscriptionKey, id));
			const item = state.serverName && state.event
				? { serverName: state.serverName, subscriptionKey: state.subscriptionKey, event: state.event }
				: state.serverName && state.control
					? { serverName: state.serverName, subscriptionKey: state.subscriptionKey, control: state.control }
					: undefined;
			if (item) pendingToReplay.set(scopedId(state.subscriptionKey, id), item);
		}

		for (const receipt of durableReceipts) pendingToReplay.delete(receipt);
		for (const item of pendingToReplay.values()) {
			session.yieldQueue.enqueue<McpEventEntry>("mcp-event", item);
		}

		eventsManager.setEventCursorProvider?.((_serverName, subscriptionKey) => cursors.get(subscriptionKey) ?? null);
		eventsManager.setOnEventCursor?.((serverName, subscriptionKey, cursor) =>
			serializePersistence(async () => {
				if (session.isDisposed) throw new Error("MCP session is disposed");
				session.sessionManager.appendCustomEntry("mcp-events-state", {
					serverName,
					subscriptionKey,
					cursor,
				});
				await ensureDurableJournal();
				cursors.set(subscriptionKey, cursor);
			}),
		);

		const persistNotice = (
			serverName: string,
			subscriptionKey: string,
			item: McpEventEntry,
			id: string,
		): Promise<"queued" | "duplicate"> =>
			serializePersistence(async () => {
				if (session.isDisposed) throw new Error("MCP session is disposed");
				const key = scopedId(subscriptionKey, id);
				if (seenEventIds.has(key)) return "duplicate";
				const cursor = "event" in item ? item.event.cursor ?? null : undefined;
				session.sessionManager.appendCustomEntry("mcp-events-state", {
					serverName,
					subscriptionKey,
					cursor,
					eventId: id,
					event: "event" in item ? item.event : undefined,
					control: "control" in item ? item.control : undefined,
				});
				await ensureDurableJournal();
				if (session.isDisposed) throw new Error("MCP session is disposed");
				if (cursor !== undefined) cursors.set(subscriptionKey, cursor);
				seenEventIds.add(key);
				try {
					session.yieldQueue.enqueue<McpEventEntry>("mcp-event", item);
				} catch (error) {
					seenEventIds.delete(key);
					throw error;
				}
				return "queued";
			});

		eventsManager.setOnEvent(async (serverName, event, subscriptionKey) => {
			if (session.isDisposed) throw new Error("MCP session is disposed");
			return persistNotice(serverName, subscriptionKey, { serverName, subscriptionKey, event }, event.eventId);
		});
		eventsManager.setOnEventControl?.((serverName, subscriptionKey, control) => {
			if (session.isDisposed) throw new Error("MCP session is disposed");
			return persistNotice(serverName, subscriptionKey, { serverName, subscriptionKey, control }, control.messageId);
		});

		postmortem.register("mcp-event-cleanup", async () => {
			if (typeof eventsManager.stopEvents === "function") {
				await eventsManager.stopEvents();
			}
			eventsManager.setOnEvent(undefined);
			eventsManager.setOnEventCursor?.(undefined);
			eventsManager.setEventCursorProvider?.(undefined);
			eventsManager.setOnEventControl?.(undefined);
		});
	}
}
