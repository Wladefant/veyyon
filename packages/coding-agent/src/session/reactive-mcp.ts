import { errorMessage, logger, postmortem } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { MCPGetPromptResult, MCPManager } from "../mcp";
import type { MCPWebhookControl } from "../mcp/events-webhook";
import type { MCPEventOccurrence } from "../mcp/types";
import type { AgentSession } from "./agent-session";
import { sessionCpuExecHooks } from "./cpu-limit";
import type { McpEventBatchDetails, McpEventEntry, McpNotificationEntry } from "./factory-notices";

type MCPEventsManagerTarget = Pick<MCPManager, "setOnEvent"> &
	Partial<Pick<MCPManager, "setOnEventCursor" | "setEventCursorProvider" | "setOnEventControl" | "stopEvents">>;

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
			persistenceChain = result.then(
				() => undefined,
				() => undefined,
			);
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
			if (state.cursor === null || typeof state.cursor === "string")
				cursors.set(state.subscriptionKey, state.cursor);
			const id = state.eventId ?? state.control?.messageId;
			if (!id) continue;
			seenEventIds.add(scopedId(state.subscriptionKey, id));
			const item =
				state.serverName && state.event
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
				session.sessionManager.appendCustomEntry("mcp-events-state", {
					serverName,
					subscriptionKey,
					eventId: id,
					event: "event" in item ? item.event : undefined,
					control: "control" in item ? item.control : undefined,
				});
				await ensureDurableJournal();
				if (session.isDisposed) throw new Error("MCP session is disposed");
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
