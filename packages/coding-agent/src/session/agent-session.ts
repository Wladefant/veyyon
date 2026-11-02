/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPromise } from "node:util/types";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentTurnEndContext,
	AppendOnlyContextManager,
	type AsideMessage,
	type StreamFn,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	type ThinkingLevel,
	ToolAdmissionFatalError,
	type ToolChoiceDirective,
} from "@veyyon/agent-core";
import {
	type CompactionResult,
	calculateContextTokens,
	compactionContextTokens,
	type SessionMessageEntry,
	type ShakeConfig,
	shouldCompact,
} from "@veyyon/agent-core/compaction";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	InstrumentationLevel,
	Message,
	Model,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	TextContent,
	ToolChoice,
	ToolResultMessage,
	UsageReport,
	VideoContent,
} from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { sessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { clearAnthropicFastModeFallback } from "@veyyon/ai/providers/anthropic-session-state";
import { streamSimple } from "@veyyon/ai/stream";
import { CheckpointClient } from "../checkpoints/cloud-checkpoints";
import { persistSessionResumeCapability, readSessionOwnershipMarker } from "../checkpoints/session-ownership-marker";
import { SynchronizedSession } from "../checkpoints/synchronized-session";
// Session initialization registers usage backends without loading the AI package barrel.
import "@veyyon/ai/usage/defaults";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import type { Effort } from "@veyyon/catalog/effort";
import { isFireworksFastModelId } from "@veyyon/catalog/fireworks-model-id";
import { modelsAreEqual } from "@veyyon/catalog/models";
import {
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
} from "@veyyon/catalog/provider-models/service-tier";
import type { InMemorySnapshotStore } from "@veyyon/hashline";
import {
	type CompactionCheckResult,
	declaredContextWindow,
} from "@veyyon/kernel/session/agent-session-compaction-policy";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import type { ClientBridge } from "@veyyon/kernel/session/client-bridge";
import {
	assistantRecordsToolCall,
	collectPendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
	sessionExitLogLevel,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@veyyon/kernel/session/exit-diagnostics";
import { OperatorNotices, stderrNoticeSink } from "@veyyon/kernel/session/operator-notices";
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import {
	type BuildSessionContextOptions,
	compactedHistoryEnd,
	contextCompaction,
	type SessionContext,
} from "@veyyon/kernel/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE, type NewSessionOptions } from "@veyyon/kernel/session/session-entries";
import { cleanupEmptyMoveSession, type SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	isAwaitingUserAnswer,
	mayContinueAtSettle,
	type SettleContinuationState,
} from "@veyyon/kernel/session/settle-continuation";
import type { ShakeMode, ShakeResult } from "@veyyon/kernel/session/shake-types";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { ToolChoiceQueue } from "@veyyon/kernel/session/tool-choice-queue";
import { YieldQueue } from "@veyyon/kernel/session/yield-queue";
import {
	attachTelegramTrace,
	errorMessage,
	getActiveAuthDbPath,
	isEnoent,
	logger,
	postmortem,
	prompt,
	Snowflake,
	type TelegramDeliveryTraceData,
	withTimeout,
} from "@veyyon/utils";
import { contentText } from "@veyyon/utils/content-text";
import { clearToolCallInFlight, markToolCallInFlight, reportAbandonedToolCalls } from "@veyyon/utils/inflight-marker";
import { localCalendarDate } from "@veyyon/utils/local-time";
import { type HeartbeatHandle, joinHeartbeat, reportSilentDeaths } from "@veyyon/utils/session-heartbeat";
import { startupMarker } from "@veyyon/utils/startup-marker";
import type { ArgotSession } from "argot";
import type { AdvisorConfig } from "../advisor";
import {
	ArgotStreamDisplayDecoder,
	expandAgentReturn,
	expandAssistantContent,
	expandSessionContext,
	expandSessionMessageEntries,
} from "../argot-wire";
import { type AsyncJob, AsyncJobManager } from "../async";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import { credentialRemedySentence, missingCredentialsMessage } from "../config/missing-credentials";
import { normalizeModelPatternList } from "../config/model-pattern-list";
import type { ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveModelSelectorValue,
} from "../config/model-resolver";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, PRIORITY_TIER_COMMAND_LABEL } from "../config/service-tier";
import { type Settings, type SkillsSettings, validateProviderMaxInFlightRequests } from "../config/settings";
import { onAppendOnlyModeChanged, onHelperModelsChanged } from "../config/settings-signals";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { resolveEffectiveToolDiscoveryMode } from "../discovery/mode";
import { type DiscoverableTool, type DiscoverableToolSearchIndex, isMCPToolName } from "../discovery/tool-index";
// The owning module, not the `../edit` barrel, which `export *`s the streaming applier, the hashline
// engine and the EditTool and pulls in 44 modules nothing else here reaches.
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import type { PythonResult } from "../eval/py/executor";
// The leaf, not `../eval/py`: that module declares the Python backend descriptor and reaches
// hundreds of modules, and all this needs is the id prefix.
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py/session-namespace";
import { defaultEvalSessionId } from "../eval/session-id";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands/types";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionRunner, SessionBeforeSwitchResult, SessionStopEventResult } from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { recordGoal } from "../goals/goal-record";
import { GoalRuntime } from "../goals/runtime";
import type { GoalAbortReason, GoalModeState, GoalTokenUsage } from "../goals/state";
// The owning module, not the `../internal-urls` barrel: the barrel re-exports every protocol
// handler and reaches several hundred modules, and both of these are declared in
// `local-protocol`, which reaches seven.
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import {
	ackSessionNotices,
	claimSessionNotices,
	formatNoticeMessage,
	registerSessionNoticeQueue,
	type SessionNotice,
} from "../launch/session-notices";
import { resolveMemoryBackend } from "../memory/backend";
import type { HindsightSessionState } from "../memory/hindsight/state";
import { getMnemopiSessionState, type MnemopiSessionState, setMnemopiSessionState } from "../memory/mnemopi/state";
import { resolvePlanFilePath } from "../plan-mode/plan-path";
import type { PlanModeState } from "../plan-mode/state";
import { goalsPrompts } from "../prompts/goals/rows";
import { sessionPrompts } from "../prompts/session/rows";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import { steeringPrompts } from "../prompts/steering/rows";
import { turnControlPrompts } from "../prompts/turn-control/rows";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { mapAssistantContentStrings, type SecretObfuscator } from "../secrets/obfuscator";
import {
	parseSlashCommand,
	unknownSlashCommandMessage,
	unresolvedSlashCommandName,
} from "../slash-commands/helpers/parse";
import { isLivePromptGate } from "../system-prompt-builder/gate-registry";
import { enabledAgentNames, resolveDelegation } from "../task/agent-settings";
import {
	HELPER_IDS,
	type HelperId,
	type HelperModelSelection,
	helperModelPatterns,
	resolveHelperModel,
} from "../task/helper-settings";
import {
	IrcBus,
	type IrcMessage,
	type IrcPersistedDeliveryFacts,
	type IrcPersistedDeliveryTelemetry,
	projectIrcDeliveryTelemetry,
} from "../task/irc-bus";
import type { YieldItem } from "../task/types";
import { arrayValuedLabels, assembleYieldResult } from "../task/yield-assembly";
import type { ConfiguredThinkingLevel } from "../thinking";
import { buildResolveReminderMessage } from "../tools/agent/resolve";
import type { TodoPhase } from "../tools/agent/todo";
import type { YieldDetails } from "../tools/agent/yield";
import { validateApprovalPolicySettings } from "../tools/core/approval";
import type { ApprovalMode, SessionToolApprovals } from "../tools/core/approval-modes";
import { TOOL } from "../tools/core/builtin-names";
import { reportLostOutputArtifact } from "../tools/core/output-artifact";
import { outputMeta } from "../tools/core/output-meta";
import { buildOutputValidator, summarizeValidationFailure } from "../tools/core/output-schema-validator";
import { shortenPath } from "../tools/core/render-utils";
import { clampTimeout } from "../tools/core/tool-timeouts";
import type { CheckpointState, CompletedRewindState } from "../tools/fs/checkpoint";
import type { BashExecutionMessage, PythonExecutionMessage } from "../tools/shell/execution-messages";
import { loadPythonExecutor } from "../tools/shell/manifest";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { normalizeModelContextImages } from "../utils/image-loading";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { normalizePromptPath } from "../utils/prompt-path";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import { formatAdvisorStatus } from "./advisor-stats";
import { throwIfExtensionCommand, tryExecuteCustomCommand, tryExecuteExtensionCommand } from "./agent-session-commands";
import { type EphemeralTurnArgs, type EphemeralTurnResult, runEphemeralTurn } from "./agent-session-ephemeral-turn";
import { findLastAssistantMessage, lastCopyCandidateAssistantMessage } from "./agent-session-message-shapes";
import { compactionModelCandidates, contextPromotionTarget } from "./agent-session-model-targets";
import {
	IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
	isAdvisorCard,
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isTerminalTextAssistantAnswer,
	isUserQueuedMessage,
	queueChipText,
	type RestoredQueuedMessage,
	toRestoredQueuedMessage,
} from "./agent-session-queue";
import { retryFallbackChainWarnings } from "./agent-session-retry-fallback";
import { buildGoalTodoContext, createMagicKeywordNotices, magicKeywordEnabled } from "./agent-session-turn-notices";
import {
	type AdvisorStats,
	type AgentContinueSkipReason,
	type AgentSessionConfig,
	type AgentSessionDisposeOptions,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type AsyncJobSnapshot,
	type AsyncResultEntry,
	type CommandMetadataChangedListener,
	type ContextUsageBreakdown,
	DISPOSE_AGENT_LOOP_SETTLE_MS,
	type FollowUpOptions,
	type FreshSessionResult,
	type HandoffResult,
	type ModelCycleResult,
	type Prewalk,
	type ProjectAdvisorScope,
	type PromptOptions,
	QUIESCENCE_RECHECK_MS,
	type ScheduledAgentContinueOptions,
	type SecretRuntimeLease,
	type SessionHandoffOptions,
	type SessionNameTrigger,
	type SessionSpend,
	type SessionStats,
	type SetSessionNameWithTrigger,
	type SteerOptions,
	TOOL_SHAPE_SETTING_PATHS,
} from "./agent-session-types";
// The accounting, not the drawing. It used to be imported from `modes/`, which put the terminal UI
// on the session engine's graph and cost the layering gate a standing exception.
import { computeStoredMessagesTokens } from "./context-usage";
import { initSessionCpuLimit, rekeySessionCpuLimit, sessionCpuLimit } from "./cpu-limit";
import { isClassifierRefusal } from "./failed-turn";
import {
	type CustomMessage,
	type CustomMessagePayload,
	convertToLlm,
	demoteInterruptedThinking,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
	isUserInterruptAbort,
	normalizeCustomMessagePayload,
	SILENT_ABORT_MARKER,
	SKILL_PROMPT_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { computeNonMessageBreakdown, computeNonMessageTokens, takeHeldAtRestReading } from "./non-message-tokens";
import { SESSION_STATE_MESSAGE_TYPE, SESSION_STOP_CONTINUATION_CAP } from "./nudges";
import { AdvisorRoster, type AdvisorRosterHost } from "./runtime/advisor-roster";
import { CheckpointRuntime } from "./runtime/checkpoint-runtime";
import { CompactionRuntime } from "./runtime/compaction-runtime";
import { readCompactionSpanBack } from "./runtime/compaction-summarizer";
import { ContextAccounting } from "./runtime/context-accounting";
import { ExtensionEventForwarder } from "./runtime/extension-event-forwarder";
import { FinalizeReminders } from "./runtime/finalize-reminders";
import { HistoryRewrites } from "./runtime/history-rewrites";
import { IrcContinuationOutbox, IrcInbox } from "./runtime/irc-inbox";
import { LoopGuards } from "./runtime/loop-guards";
import { MaxConcurrencyRuntime } from "./runtime/max-concurrency-runtime";
import { lastDeliveredBlock, MemoryContext } from "./runtime/memory-context";
import { MessagePersistence } from "./runtime/message-persistence";
import { ModelHandoff } from "./runtime/model-handoff";
import { PlanModeRuntime } from "./runtime/plan-mode-runtime";
import { PostPromptTasks } from "./runtime/post-prompt-tasks";
import { ProviderSessions } from "./runtime/provider-sessions";
import { ProviderUsage } from "./runtime/provider-usage";
import { ProviderWire } from "./runtime/provider-wire";
import { ReplanTitleRefresh } from "./runtime/replan-title-refresh";
import { RetryRuntime } from "./runtime/retry-runtime";
import { SessionApprovals } from "./runtime/session-approvals";
import { SessionBranch, type TreeNavigationResult } from "./runtime/session-branch";
import { SessionHandoff } from "./runtime/session-handoff";
import { SessionScope } from "./runtime/session-scope";
import { type SecretsRefreshOptions, SessionSecrets } from "./runtime/session-secrets";
import { SessionSwitch } from "./runtime/session-switch";
import { StopRetries } from "./runtime/stop-retries";
import { StreamingEditGuard } from "./runtime/streaming-edit-guard";
import { ThinkingRuntime } from "./runtime/thinking-runtime";
import { TodoRuntime } from "./runtime/todo-runtime";
import { ToolActivation } from "./runtime/tool-activation";
import { sameToolNames, ToolDiscovery } from "./runtime/tool-discovery";
import { TtsrRuntime } from "./runtime/ttsr-runtime";
import { removeAssistantMessageFromActiveContext, TurnContextCheck } from "./runtime/turn-context-check";
import { TurnsInFlight } from "./runtime/turns-in-flight";
import { UserExecutions } from "./runtime/user-executions";
import { isTerminalYieldToolResult, YieldTracker } from "./runtime/yield-tracker";
import { formatSessionDumpText } from "./session-dump-format";
import { SessionSpendLedger } from "./session-spend";
import { classifyUnexpectedStop } from "./unexpected-stop-classifier";
import type { VibeModeState } from "./vibe-runtime";

export class UnsupportedModelInputError extends Error {
	readonly modality: "video";
	readonly modelId: string;

	constructor(modelId: string, modality: "video" = "video") {
		super(`Model "${modelId}" does not support ${modality} input.`);
		this.name = "UnsupportedModelInputError";
		this.modality = modality;
		this.modelId = modelId;
	}
}

/** Abort reason recorded on a spawned agent stopped because its conversation was left by `/new`, `/resume` or a handoff. */
export const RESCOPE_TERMINATE_REASON = "Stopped: the conversation that spawned it ended";

/** Whether writing `path` must rebuild the prompt the model is holding. */
function rebuildsThePrompt(path: string): boolean {
	return isLivePromptGate(path) || TOOL_SHAPE_SETTING_PATHS[path] === true;
}

export type { ShakeMode, ShakeResult };

/**
 * Ask the active memory backend for an extra-context block to splice into
 * the compaction summary prompt. Both the manual and auto compaction paths
 * funnel through this helper so the behaviour stays identical.
 *
 * Failures are swallowed: a memory backend going sideways MUST NOT block
 * compaction (which is itself the recovery path for context overflow).
 */
async function collectMemoryBackendContext(
	session: AgentSession,
	preparation: { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[] },
): Promise<string | undefined> {
	const backend = await resolveMemoryBackend(session.settings);
	if (!backend.preCompactionContext) return undefined;
	await readCompactionSpanBack(preparation);
	const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
	try {
		return await backend.preCompactionContext(messages, session.settings, session);
	} catch (err) {
		logger.debug("Memory backend preCompactionContext failed", {
			backend: backend.id,
			error: errorMessage(err),
		});
		return undefined;
	}
}

/**
 * On a user-interrupted (`Esc`) abort, copy the trailing thinking run into a
 * hidden `display: false` continuity message for the next turn WITHOUT
 * mutating the assistant message. The original thinking stays on the message
 * so live render, reload, and Ctrl+L rebuilds keep showing it; `convertToLlm`
 * strips the run from the provider request (incomplete/unsigned thinking is
 * rejected on resend) when this continuity message follows the assistant turn.
 */
function demoteInterruptedThinkingOnUserInterrupt(
	message: AssistantMessage,
): CustomMessage<InterruptedThinkingDetails> | undefined {
	if (message.stopReason !== "aborted" || !isUserInterruptAbort(message)) return undefined;
	const demoted = demoteInterruptedThinking(message);
	if (!demoted) return undefined;
	const interruptedAt = Date.now();
	return {
		role: "custom",
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: prompt.render(turnControlPrompts["turn-control/interrupted-thinking"].text, {
			reasoning: demoted.reasoning,
		}),
		display: false,
		details: {
			interruptedAt,
			provider: message.provider,
			model: message.model,
			blockCount: demoted.blockCount,
		},
		attribution: "agent",
		timestamp: interruptedAt,
	};
}

function skipAgentContinue(reason: AgentContinueSkipReason, options: ScheduledAgentContinueOptions | undefined): void {
	logger.debug("agent.continue skipped after scheduling", { reason });
	options?.onSkip?.(reason);
}

function sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
	if (!result) return undefined;
	const additionalContext =
		typeof result.additionalContext === "string" && result.additionalContext.length > 0
			? result.additionalContext
			: undefined;
	const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
	if (result.decision === "block") {
		return (
			reason ??
			additionalContext ??
			"A session_stop handler blocked completion without a reason. Resolve the outstanding work before finishing."
		);
	}
	if (result.continue === true) {
		return additionalContext ?? reason;
	}
	return undefined;
}

function getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
	return contentText(message.content, { separator: "" });
}

/** Least time between two scans of the notice queue at step boundaries. */
const SESSION_NOTICE_SCAN_MS = 1000;
/** Notice ids a session remembers to drop a re-offered claim; older ones have long left `claimed/`. */
const MAX_SEEN_NOTICE_IDS = 512;
/** Interval between session heartbeat log lines while the session is alive. */
const SESSION_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Emit a warn-level log for a turn that ended in a provider error so recurring
 * stream failures are diagnosable from the main log alone. The `agent_end`
 * routing trace is debug-only and omits the error fields; without this a
 * session dying on provider errors leaves only `stopReason:"error"` debug lines
 * and the real cause lives solely in the session transcript (issue #6177).
 * No-op for any non-error stop reason.
 */
export function logProviderTurnError(msg: AssistantMessage): void {
	if (msg.stopReason !== "error") return;
	logger.warn("agent turn ended with provider error", {
		provider: msg.provider,
		model: msg.model,
		errorMessage: msg.errorMessage,
		errorStatus: msg.errorStatus,
		errorId: msg.errorId,
	});
}
/** The persisted form of a per-family tier map: `null` when no family carries a tier. */
function serviceTierEntry(byFamily: ServiceTierByFamily): ServiceTierByFamily | null {
	return Object.keys(byFamily).length > 0 ? byFamily : null;
}

/**
 * Warnings for hand-edited settings that resolve to a value other than the one written.
 *
 * Every configured value that does not match its declared type is reported with the file to edit,
 * and one the read path replaces also states what it reads as instead: a value of the wrong kind
 * reads as its default, and a misspelled `tools.approvalMode` reads as `ask`, its declared
 * fail-closed member. A malformed `tools.approval.<tool>` policy DENIES the tool (see
 * `normalizePolicy`), so its warning states which entry did it and the accepted values. Nothing
 * fires for a value that is not configured.
 */
function configWarningsFor(settings: Settings, modelRegistry: ModelRegistry): string[] {
	const warnings = retryFallbackChainWarnings(settings.get("retry.fallbackChains"), modelRegistry);
	for (const { path, file, reason, replaced } of settings.invalidValues) {
		const readsAs = replaced ? `; it reads as ${JSON.stringify(settings.get(path))}` : "";
		warnings.push(`${reason} in ${shortenPath(file)}${readsAs}`);
	}
	warnings.push(...validateApprovalPolicySettings(settings.get("tools.approval")));
	return warnings;
}

/**
 * Record the start of a tool execution in the session file.
 *
 * The arguments and intent are REDACTED, because `event.args` and the intent are post-expansion.
 * The assistant message holds the placeholder the model wrote; this event holds what the tool was
 * handed, which for `#GITHUB_TOKEN#` is the credential itself. The session file must never contain
 * it: the vault is encrypted at rest and this entry sits beside it in the same directory, and it
 * travels through `/share` and exports. The intent goes through the same redactor because the
 * model can quote an argument back into it.
 */
function recordToolExecutionStart(
	session: AgentSession,
	event: Extract<AgentEvent, { type: "tool_execution_start" }>,
): void {
	const sessionManager = session.sessionManager;
	// The entry's timestamp is the start time, so the marker includes none of its own.
	const data: ToolExecutionStartData = { toolCallId: event.toolCallId, toolName: event.toolName };
	const redact = (text: string): string => session.obfuscateProviderText(text);
	// The command/path projection the resume warning renders, written only when no assistant
	// message on the branch records the call yet: a Cursor server-side call, or a crash before the
	// assistant message reached the file. Otherwise the warning reads that message's arguments.
	const recorded = assistantRecordsToolCall(
		sessionManager.getLeafEntry(),
		id => sessionManager.getEntry(id),
		event.toolCallId,
	);
	const args = recorded ? undefined : summarizeToolArguments(event.args, redact);
	if (args) data.args = args;
	if (event.intent) data.intent = redact(event.intent);
	sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, data);
}

/**
 * The display copy of an event carrying a whole assistant message: secrets deobfuscated and
 * argot handles expanded. The LLM echoes back obfuscated placeholders and cheap handles, but
 * listeners (TUI, extensions, exporters) must see real values. The original message keeps both,
 * so the persistence path writes `#HASH#` tokens and handles to the session file and the next
 * turn's context stays cheap. `message_start`, `message_end` and `turn_end` all carry a whole
 * assistant message and a front end may render from any of them, so all three expand alike and
 * the same text never changes under the reader between two adjacent events.
 */
function expandAssistantEvent<E extends { message: AgentMessage }>(session: AgentSession, event: E): E {
	const message: AgentMessage = event.message;
	if (message.role !== "assistant") return event;
	const content = session.displayAssistantContent(message.content);
	return content === message.content ? event : { ...event, message: { ...message, content } };
}

/**
 * The closing event repeats the turn's messages, so it repeats every handle in them unless it is
 * expanded like the events it summarises. The array is copied only when a message changes.
 */
function expandAgentEndEvent(
	session: AgentSession,
	event: Extract<AgentEvent, { type: "agent_end" }>,
): Extract<AgentEvent, { type: "agent_end" }> {
	let messages: AgentMessage[] | undefined;
	for (let index = 0; index < event.messages.length; index++) {
		const message = event.messages[index]!;
		if (message.role !== "assistant") continue;
		const content = session.displayAssistantContent(message.content);
		if (content === message.content) continue;
		messages ??= event.messages.slice();
		messages[index] = { ...message, content };
	}
	return messages ? { ...event, messages } : event;
}

function localProtocolOptions(sessionManager: SessionManager): LocalProtocolOptions {
	return {
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getSessionId: () => sessionManager.getSessionId(),
	};
}

/**
 * Filesystem path of a plan reference, whichever spelling it carries. One
 * delegate to {@link resolvePlanFilePath} rather than a branch per reader:
 * a reference with no URL scheme used to throw `Invalid URL` out of the
 * prompt path while a sibling reader thirty lines away handled it.
 */
function resolvePlanPath(sessionManager: SessionManager, planFilePath: string): string {
	return resolvePlanFilePath(planFilePath, {
		localProtocol: localProtocolOptions(sessionManager),
		cwd: sessionManager.getCwd(),
	});
}

/**
 * Adopt a context window the provider reported on the wire.
 *
 * The catalog's window is static metadata, and for an agent gateway that
 * adds models continuously it is a guess: discovery has no window field to
 * read and substitutes a default. That guess is the denominator of both the
 * context gauge and the compaction threshold, so when it is far below the
 * real window the gauge pins at "0% left" and auto-compaction fires every
 * turn on a conversation the provider considers barely used.
 *
 * Both the live model object and the registry are corrected: the session
 * holds its model by reference, so fixing only the registry would leave this
 * turn's math wrong, and fixing only the reference would let the next
 * discovery reload restore the guess.
 */
function applyProviderReportedContextWindow(
	agent: Agent,
	modelRegistry: ModelRegistry,
	message: AssistantMessage,
): void {
	const reported = message.providerContextWindow;
	if (reported === undefined || !Number.isFinite(reported) || reported <= 0) return;
	const model = agent.state.model;
	if (!model) return;
	const changed = modelRegistry.recordProviderReportedContextWindow(model.provider, model.id, reported);
	if (model.contextWindow === reported) return;
	logger.debug("Adopting provider-reported context window", {
		model: `${model.provider}/${model.id}`,
		was: model.contextWindow,
		now: reported,
		registryUpdated: changed,
	});
	agent.state.model = { ...model, contextWindow: reported };
}

function resolveActiveEditMode(settings: Settings, model: Model | undefined): EditMode {
	return resolveEditMode({
		settings,
		getActiveModelString: () => (model ? formatModelString(model) : undefined),
	});
}

/** Deliver a built mode-context message with its attribution; a `null` message (mode off) sends nothing. */
async function sendModeContext(
	session: AgentSession,
	message: CustomMessage | null,
	options: { deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
): Promise<void> {
	if (!message) return;
	await session.sendCustomMessage(
		{
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution,
		},
		options ? { deliverAs: options.deliverAs } : undefined,
	);
}

async function normalizeMessageContentImages(
	content: string | (TextContent | ImageContent)[],
	model: Model | undefined,
): Promise<string | (TextContent | ImageContent)[]> {
	if (typeof content === "string") return content;
	const images = content.filter((part): part is ImageContent => part.type === "image");
	if (images.length === 0) return content;
	const normalizedImages = await normalizeModelContextImages(images, { model });
	if (!normalizedImages) return content;
	let imageIndex = 0;
	return content.map(part => (part.type === "image" ? normalizedImages[imageIndex++]! : part));
}

async function normalizeAgentMessageImages<T extends AgentMessage>(message: T, model: Model | undefined): Promise<T> {
	if (!("content" in message)) return message;
	const content = message.content;
	if (typeof content !== "string" && !Array.isArray(content)) return message;
	const normalized = await normalizeMessageContentImages(content as string | (TextContent | ImageContent)[], model);
	if (normalized === content) return message;
	return { ...message, content: normalized } as T;
}

async function saveBashOriginalArtifact(
	sessionManager: SessionManager,
	originalText: string,
): Promise<string | undefined> {
	try {
		return await sessionManager.saveArtifact(originalText, "bash-original");
	} catch (err) {
		// The executor only appends the `artifact://<id>` footer when an id comes back, so undefined has to
		// stay the answer here: the minimized output is still correct, it cannot be expanded. The loss
		// is reported through the same owner the tool spill path uses, so both report the same thing.
		reportLostOutputArtifact("bash-original", err);
		return undefined;
	}
}

/**
 * `details` with the text the queue chip shows for a queued custom message. Details that are not an
 * object are replaced, since the chip text needs a record to ride on.
 */
function withQueueChipText<T>(details: T | undefined, queueChipText: string): T {
	const base = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
	return { ...base, __queueChipText: queueChipText } as T;
}

/** Queue a custom message without starting a turn, matching steer/follow-up delivery. */
async function queueCustomMessage<T = unknown>(
	session: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	deliverAs: "steer" | "followUp",
	queueChipText?: string,
): Promise<void> {
	const details = queueChipText !== undefined ? withQueueChipText(message.details, queueChipText) : message.details;
	const appMessage: CustomMessage<T> = {
		role: "custom",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details,
		attribution: message.attribution ?? "agent",
		timestamp: Date.now(),
	};
	const normalizedAppMessage = await normalizeAgentMessageImages(appMessage, session.model);
	if (deliverAs === "followUp") {
		session.agent.followUp(normalizedAppMessage);
	} else {
		session.agent.steer(normalizedAppMessage);
	}
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly yieldQueue: YieldQueue;
	#cloudOwnership?: SynchronizedSession;
	fileSnapshotStore?: InMemorySnapshotStore;
	readonly #approvals: SessionApprovals;
	/**
	 * What the caller configured this session with. A host callback or flag the session only reads is
	 * read from here rather than copied into a field of its own.
	 */
	readonly #config: AgentSessionConfig;

	get modelPatternFallbackKey(): string | undefined {
		return this.#config.modelPatternFallbackKey;
	}

	readonly configWarnings: string[] = [];

	#scopedModels: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}>;
	#handoff: ModelHandoff;

	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#cancelExitRecorder?: () => void;
	#exitRecorded = false;
	/** Session ids can change on fork/compaction; cleanup must use the id recorded at start. */
	#toolMarkerSessions = new Map<string, string>();
	/** In-flight tool names keyed by toolCallId for heartbeat phase reporting. */
	readonly #inFlightToolNames = new Map<string, string>();
	/** 60-second periodic heartbeat log interval while the session is alive. */
	#heartbeatLogInterval?: NodeJS.Timeout;
	/** This session's share of the process heartbeat; left when the exit is recorded. */
	#heartbeat?: HeartbeatHandle;
	/** Unsubscribers for the process-wide and settings listeners, released at the end of dispose. */
	readonly #listenerReleases: Array<() => void> = [];
	#promptRefresh: Promise<void> = Promise.resolve();
	/**
	 * Startup work that finishes behind the first frame and gates the first turn.
	 *
	 * A session's own construction is on the boot path, so anything it awaits there is time before the
	 * user sees anything. Work whose result no frame reads — a memory backend opening its database and
	 * installing this session's state — is handed to {@link deferStartupWork} instead and awaited at
	 * the one place that needs it, the start of a turn. Every tool call and every agent spawn
	 * happens inside a turn, so one await covers all of them.
	 */
	#startupHydration: Promise<void> = Promise.resolve();
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];

	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;
	/** Plan mode state, the approved-plan reference, and the decision ladder. */
	readonly #planMode: PlanModeRuntime;
	#vibeModeState: VibeModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	/** The advisors watching this session's turns; see {@link AdvisorRoster}. */
	readonly #advisorRoster: AdvisorRoster;
	/** Async lifecycle handlers for visible advisor cards emitted outside the primary loop. */
	#pendingAdvisorCardEvents = new Set<Promise<void>>();
	#goalTurnCounter = 0;
	/** Spend over the summarized prefix, tallied once per compaction boundary. */
	readonly #spendLedger = new SessionSpendLedger();
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;
	/** Session file created by this session's `/move`; removed on dispose if it stayed empty. */
	#movedFromEmptySessionFile?: string;

	readonly #compaction = new CompactionRuntime(this, {
		emitSessionEvent: event => this.#emitSessionEvent(event),
		promptGeneration: () => this.#promptGeneration,
		scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
		scheduleAutoContinuePrompt: generation => this.#scheduleAutoContinuePrompt(generation),
		secrets: () => this.#secrets,
		convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
		providerSessionState: () => this.#providerSessions.states,
		effectiveServiceTier: model => this.#effectiveServiceTier(model),
		baseSystemPrompt: () => this.#toolActivation.baseSystemPrompt,
		nonMessageTokens: () => computeNonMessageTokens(this),
		nonMessageBreakdown: () => computeNonMessageBreakdown(this),
		estimateStoredContextTokens: () => this.#context.estimateStoredTokens(),
		memoryBackendContext: preparation => collectMemoryBackendContext(this, preparation),
		withPlanProtection: config => this.#planMode.withProtection(config),
		offloadAndApplyShakeRegions: regions => this.#rewrites.offloadAndApply(regions),
		rebasePendingContextSnapshotAfterHistoryRewrite: () => this.#context.rebaseAfterHistoryRewrite(),
		resetAllAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
		afterHistoryCompacted: () => {
			// Compaction discarded the conversation history that carried the approved
			// plan reference; the next turn re-reads the plan from disk (issue #1246).
			this.#planMode.invalidateReference();
			this.#resetAllAdvisorRuntimes();
			this.#todo.syncFromBranch();
		},
		closeCodexProviderSessionsForHistoryRewrite: () => this.#providerSessions.closeCodexForHistoryRewrite(this.model),
		whileDisconnectedFromAgent: run => this.#whileDisconnectedFromAgent(run),
		phaseChanged: () => this.#heartbeat?.update(),
	});

	#lastLaneHandoffSessionId: string | undefined;

	/** The end-of-turn context check and the recovery each of its cases runs. */
	readonly #contextCheck = new TurnContextCheck(this, {
		promptGeneration: () => this.#promptGeneration,
		goalMode: () => this.#goalModeState,
		predatesLatestCompaction: message => this.#persistence.assistantPredatesLatestCompaction(message),
		waitForPersisted: message => this.#persistence.waitFor(message),
		discardAssistantTurn: message => this.#discardAssistantTurn(message),
		removeAssistantFromActiveContext: message => removeAssistantMessageFromActiveContext(this.agent, message),
		promoteContextModel: () => this.#promoteContextModel(),
		scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
		runAutoCompaction: (reason, willRetry, options) => this.#compaction.runAutoCompaction(reason, willRetry, options),
		noticeCompactionThresholdClamp: (contextWindow, settings) =>
			this.#compaction.noticeCompactionThresholdClamp(contextWindow, settings),
		pruneStale: () => this.#rewrites.pruneStale(),
		pruneOverflow: () => this.#rewrites.pruneOverflow(),
		estimateStoredContextTokens: () => this.#context.estimateStoredTokens(),
	});

	readonly #retry = new RetryRuntime(this, {
		emitSessionEvent: event => this.#emitSessionEvent(event),
		promptGeneration: () => this.#promptGeneration,
		scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
		abortIsDeliberate: message =>
			this.#deliberateAborts.has(message) ||
			this.#abortInProgress ||
			this.#isDisposed ||
			this.#streamingEdit.abortTriggered,
		setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
		resetCurrentResponsesProviderSession: reason => this.#providerSessions.resetResponses(this.model, reason),
		maybeAutoRedeemCodexReset: () => this.#usage.maybeAutoRedeemCodexReset(),
		removeAssistantMessageFromActiveContext: (message, reason) =>
			removeAssistantMessageFromActiveContext(this.agent, message, reason),
		persistLifecycleErrorMessage: async message => {
			await this.#persistTerminalEmptyErrorTurn(message);
		},
		resetSessionStopContinuationState: () => {
			this.#sessionStopContinuationCount = 0;
		},
	});
	/**
	 * The title refresh a re-plan starts, and the TITLE_SYSTEM.md override every automatic title
	 * request uses. Refresh the override via {@link AgentSession.setTitleSystemPrompt} when the
	 * session cwd changes.
	 */
	readonly #replanTitle: ReplanTitleRefresh;
	#toolChoiceQueue = new ToolChoiceQueue();
	/** The evidence ledger and the rewind, verification and review reminders a settling turn is sent. */
	readonly #finalize: FinalizeReminders;

	/** Running user shell commands and eval runs, and the results recorded while a turn streamed. */
	readonly #executions = new UserExecutions({
		isStreaming: () => this.isStreaming,
		append: message => {
			this.agent.appendMessage(message);
			this.sessionManager.appendMessage(message);
		},
	});

	// Python execution state
	#evalKernelOwnerId: string;
	#parentEvalSessionId: string | undefined;
	/**
	 * AsyncJobManager owned by this session (top-level only). Spawned agents leave
	 * this undefined and **MUST NOT** dispose the global instance on teardown.
	 */
	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;
	/** Whether another session in this process spawned this one. */
	readonly #isSpawned: boolean;
	readonly #taskDepth: number;
	readonly #parentTaskPrefix: string | undefined;
	/**
	 * AsyncJobManager scoped to this session for introspection/cancellation.
	 *
	 * This differs from `config.ownedAsyncJobManager`: agents can inherit a parent
	 * manager for their own owner id, while secondary top-level sessions are left
	 * undefined to avoid reading the primary's jobs.
	 */
	readonly #asyncJobManager: AsyncJobManager | undefined;

	// Incoming IRC records received while a turn was streaming. Parent IRCs enter the steering
	// queue; peer IRCs wait here as interrupts and drain as asides at the next boundary.
	readonly #ircInbox = new IrcInbox();
	#lastNoticeScanAt = 0;
	/** Notice ids waiting in the inbox for their turn, and ids already in a turn; repeats of a re-offered claim are dropped by these. */
	readonly #noticesInInbox = new Set<string>();
	readonly #noticesSeen = new Set<string>();
	/** Provider session ids, the inherited prompt cache key, and the transport state they route. */
	readonly #providerSessions: ProviderSessions;
	#isDisposed = false;
	/** Session events forwarded to extensions, in order, with the run's turn index. */
	readonly #extensionEvents: ExtensionEventForwarder;
	readonly #persistence: MessagePersistence;

	#skills: Skill[];
	readonly #operatorNotices: OperatorNotices;

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	// Tool registry and prompt builder for extensions
	#toolRegistry: Map<string, AgentTool>;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	/** Per-request provider shaping every request of this session goes out through. */
	readonly #wire: ProviderWire;
	/**
	 * The cwd/rescope/switch transaction queue and the directory last re-scoped. Work is appended
	 * synchronously, so commits and rollbacks occur in monotonic initiation order.
	 */
	readonly #scope: SessionScope;
	/** Loads another transcript into this session, and rolls back a load that fails part way. */
	readonly #sessionSwitch: SessionSwitch;
	readonly #sessionBranch: SessionBranch;
	readonly #sessionHandoff: SessionHandoff;
	/**
	 * The stream function every side request runs on, fixed when the session is built:
	 * `config.sideStreamFn`, or the `streamSimple` export as it stood at construction.
	 */
	readonly #sideStreamFn: StreamFn;
	/**
	 * The transport every SIDE request shares, in the `completeImpl` shape
	 * `compact()`, the handoff and the branch summary all take. A side request is
	 * one the session makes for itself rather than for the conversation: a
	 * summarization, a handoff, a tree navigation summary.
	 *
	 * Routing through {@link #sideStreamFn} is what puts the operator's provider
	 * settings on such a request (the stream idle and first-event watchdogs, the
	 * in-flight cap, `providers.openrouterVariant`, the loop guard) and what
	 * brackets it with the provider-concurrency limiter. The default inside
	 * `compact()` is a bare `completeSimple`, which reads no settings at all, so a
	 * site that builds its own options and omits this runs unwatched: a
	 * summarization whose provider goes silent has no deadline to end it. Every
	 * site names this field instead of writing the adapter again, so a new one
	 * cannot forget it by construction.
	 */
	#sideCompleteImpl = async <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const stream = await this.#sideStreamFn(model, ctx, options);
		return stream.result();
	};
	/**
	 * The side transport, for a subsystem outside this class that makes a request
	 * on the session's behalf: the first-input title, a spawned agent's label.
	 * Handing this over is what gives such a request the same watchdogs, in-flight
	 * cap and provider-concurrency bracket every summarization already has.
	 */
	get sideComplete(): SideCompleteImpl {
		return this.#sideCompleteImpl;
	}
	/** The active tool set and the base system prompt rendered for it. */
	readonly #toolActivation: ToolActivation;
	/** Which registered tools the model can discover and which it selected. Owns all discovery state. */
	readonly #discovery: ToolDiscovery;

	/** Time-Traveling Stream Rules: match rules against a streaming turn and
	 *  deliver matched bodies back to the model. Owns all TTSR state. */
	#ttsr: TtsrRuntime;
	/** The todo board plus the eager prelude, mid-run nudge and stop-time
	 *  reminder that keep it honest. Owns all todo state. */
	#todo: TodoRuntime;
	/** How hard the model thinks and who decided: the session override, the
	 *  selector pin, the saved default, and `auto`. Owns all thinking state. */
	#thinking: ThinkingRuntime;
	#maxConcurrency: MaxConcurrencyRuntime;
	/** Stops a turn while an `edit` call streams into an auto-generated file or a
	 *  patch that cannot apply. Owns all streaming-edit check state. */
	readonly #streamingEdit: StreamingEditGuard;
	/** One-shot flag for expected internal plan-mode aborts. Approval actions may
	 *  abort the post-`resolve` continuation before compaction, execution, or
	 *  manual refinement. Consumed inside `#handleAgentEvent` for the matching
	 *  `message_end` + `stopReason: "aborted"`; callers clear it in `finally` so
	 *  it cannot leak into later unrelated aborts. */
	#planInternalAbortPending = false;
	#pendingAbortErrorId?: number;

	/** Work a turn left behind after `prompt()` returned; see {@link PostPromptTasks}. */
	readonly #postPrompt = new PostPromptTasks({ promptGeneration: () => this.#promptGeneration });

	/** Prompts in flight and the power assertion held while any runs. */
	readonly #inFlight: TurnsInFlight;
	#abortInProgress = false;
	/**
	 * Turns that ended while `abort()` was running. `abort()` clears `#abortInProgress` once the agent
	 * loop is idle, which is before the turn's settle reads it, so the settle reads this instead.
	 */
	readonly #deliberateAborts = new WeakSet<AssistantMessage>();
	/** The empty-stop and unexpected-stop retry cycles, their reminders and the terminal empty-stop flag. */
	readonly #stopRetries: StopRetries;
	/** Usage headers and turn cost recording, usage reports, saved-reset redeems and Codex auto-redeem. */
	readonly #usage: ProviderUsage;
	/** Stale-result and overflow prunes, image drops, shake and dedup of the recorded history. */
	readonly #rewrites: HistoryRewrites;
	#promptGeneration = 0;
	#activeAgentPromptGeneration = this.#promptGeneration;
	/**
	 * Prompts refused as busy and waiting for the agent to go idle. Each is a
	 * turn already committed to, held by nothing the queues can see: the hidden
	 * next-turn message was pulled from its queue the moment it was scheduled.
	 * Counted as queued work so an `agent_end` handler asking whether anything
	 * is coming reads the turn that is.
	 */
	#promptsWaitingOnIdle = 0;
	// Wire-level agent_end emission deferred until no prompt is in flight.
	// Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
	// checks in #handleAgentEvent) still fire on the original schedule — only the
	// `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
	// Cursor exec, TUI listeners) is held back. Without this, a client that resumes
	// on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
	// block unwinds, into a session that still reports `isStreaming`.
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	/** Context usage: the prompt snapshot of the run in flight and the usage anchors it reads. */
	readonly #context: ContextAccounting;
	/** The memory backend's session state, and the recalled block delivered or waiting at the tail. */
	readonly #memory: MemoryContext<AgentSession>;
	/**
	 * `session_stop` continuations queued in a row. Nonzero is the `stop_hook_active` flag the next
	 * `session_stop` handler reads.
	 */
	#sessionStopContinuationCount = 0;
	/** Secret obfuscator, runtime lease, provider redaction and display expansion. */
	readonly #secrets: SessionSecrets;
	/** Per-streaming-message argot display decoder (seam 3); reset on each assistant message_start. */
	#argotStreamDisplay: ArgotStreamDisplayDecoder | undefined;
	/** Resolves the active model's inline-descriptor policy for session dumps. */
	#resolvePruneToolDescriptions: (model: Model) => boolean = () => false;
	/** The open checkpoint, its pending rewind report and the last completed rewind. */
	readonly #checkpoint = new CheckpointRuntime();
	/** The `yield` call that ended the run and whether the run is terminal. */
	readonly #yields = new YieldTracker();
	#ircContinuations: IrcContinuationOutbox | undefined;
	#ircActivePhase: string | undefined;
	#ircWakeSettled: Promise<void> | undefined;
	/**
	 * Recent raw SSE traffic for the debug viewer and the report bundle, which read the session the
	 * terminal displays. Undefined on a spawned agent's session unless the caller passes a buffer:
	 * the displayed session is always a top-level one, so a spawned agent's capture has no reader.
	 */
	readonly rawSseDebugBuffer: RawSseDebugBuffer | undefined;

	#resetPromptMaintenanceState(): void {
		this.#stopRetries.resetForPrompt();
		this.#yields.resetForPrompt();
		this.#retry.resetForPrompt();
	}

	/**
	 * End one in-flight prompt, or every one when `all` is set (the abort path). Once none is left,
	 * emit the deferred `agent_end`, drain what stranded, and drop the turn's agent grants.
	 */
	#endInFlight(all = false): void {
		if (!this.#inFlight.end(all)) return;
		const pendingAgentEnd = this.#pendingAgentEndEmit;
		if (pendingAgentEnd) {
			this.#pendingAgentEndEmit = undefined;
			this.#emit(pendingAgentEnd);
		}
		this.#drainStrandedQueuedMessages();
		this.#grantedAgents.clear();
		this.#heartbeat?.update();
	}

	/** A steer/follow-up can land after the agent loop's final queue poll, or
	 *  after an abort stops an auto-continued queued turn. In both cases the
	 *  agent-core queue still holds the message, but no loop is left to poll it.
	 *  Runs whenever the session settles; the guard makes it a no-op when the
	 *  queue was consumed normally or a new turn already started. */
	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;
		// A concern steered into a resumed streaming run after a user interrupt can
		// strand at the turn tail (steered past the loop's final boundary poll). While
		// that interrupt's suppression is still in effect, reclaim such advisor steers
		// as visible advice once idle — mirroring abort's advisor-card extraction —
		// so they neither auto-resume the run the user stopped (a non-empty steer queue
		// otherwise bypasses the latch in #canAutoContinueForFollowUp) nor linger to
		// flush at the next prompt. Real user steers/follow-ups are left untouched.
		if (this.#advisorRoster.autoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#advisorRoster.extractQueuedCards()) {
				this.#advisorRoster.preserveCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	/** IRC records that arrive after the loop's final aside poll — or while an abort skipped that
	 *  poll — land in pending IRC queues with no loop left to drain them; the queued-message drain's
	 *  gate (agent.hasQueuedMessages()) does not count peer IRC interrupts. Once idle, wake a turn so
	 *  the agent responds to the peer. Skip only when a queued steer/follow-up will itself drive a
	 *  resume turn whose aside poll already consumes these (no double-wake). */
	#resumeStrandedIrcAsides(): void {
		if (this.#isDisposed || this.isStreaming) return;
		if (this.#ircInbox.isEmpty) return;
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const completionWake = this.#ircInbox.completionWake;
		const records = this.#takeIrcRecords();
		if (completionWake) records.push(completionWake);
		if (this.#planMode.enabled) {
			// Plan mode: fold stranded IRC asides into context without waking an
			// autonomous turn. Convergence to ask/resolve stays user-driven.
			for (const record of records) {
				if (record.customType !== "task:continuation") this.#appendCustomMessageToContext(record);
			}
			return;
		}
		void this.#wakeForIrc(records).catch(error =>
			logger.warn("Persisting an IRC wake failed", { error: errorMessage(error) }),
		);
	}

	/** Fire-and-forget wake turn for incoming IRC — idle delivery and stranded-aside resume both
	 *  route here. Wrapped in a begin/#endInFlight pair so the turn is tracked and its settle
	 *  re-drains anything that stranded during it. A user interrupt may have intentionally left a
	 *  follow-up queued behind an invalid tail (seam #5); the wake turn's loop would otherwise drain
	 *  it, so park the follow-up queue across the wake and restore it after. It stays queued post-wake
	 *  because #canAutoContinueForFollowUp suppresses follow-up auto-resume while a user interrupt is
	 *  in effect, even though the wake left a provider-valid tail. */
	#wakeForIrc(records: CustomMessage[], recovering = false): Promise<void> {
		const selfId = this.#config.agentId;
		const parentRecord = records.find(
			record =>
				record.customType === "task:continuation" ||
				(record.customType === "irc:incoming" && Reflect.get(record.details ?? {}, "relation") === "parent"),
		);
		const completionId =
			parentRecord?.customType === "task:continuation"
				? Reflect.get(parentRecord.details ?? {}, "completionId")
				: undefined;
		const phaseId =
			typeof completionId === "string"
				? `completion:${completionId}`
				: parentRecord
					? Reflect.get(parentRecord.details ?? {}, "id")
					: undefined;
		const parentId =
			parentRecord?.customType === "task:continuation" && selfId
				? AgentRegistry.global().actorContext(selfId).parentId
				: parentRecord
					? Reflect.get(parentRecord.details ?? {}, "from")
					: undefined;
		if (!this.#ircContinuations) {
			this.#ircContinuations = new IrcContinuationOutbox(this.sessionManager);
		}
		const outbox = this.#ircContinuations;
		if (typeof phaseId === "string" && selfId) {
			if (this.#ircActivePhase === phaseId) return Promise.resolve();
			if (!recovering && typeof parentId === "string" && !outbox.begin(phaseId, parentRecord))
				return Promise.resolve();
			this.#ircActivePhase = phaseId;
		}
		const yields: YieldItem[] = [];
		let terminal = false;
		let published = false;
		let phaseEnd: number | undefined;
		const unsubscribe = this.subscribe(event => {
			if (event.type !== "tool_execution_end" || event.toolName !== "yield" || event.isError) return;
			const details = event.result?.details as YieldDetails | undefined;
			if (!details || (details.status !== "success" && details.status !== "aborted")) return;
			yields.push(details);
			terminal ||= isTerminalYieldToolResult(event);
		});
		const publish = async (failure?: unknown): Promise<void> => {
			if (!selfId || typeof parentId !== "string" || typeof phaseId !== "string") return;
			const last = yields.at(-1);
			let lastAssistantText: string | undefined;
			for (
				let index = Math.min(this.agent.state.messages.length, phaseEnd ?? this.agent.state.messages.length) - 1;
				index >= phaseStart;
				index--
			) {
				const message = this.agent.state.messages[index];
				if (message?.role !== "assistant") continue;
				const text = contentText(message.content, { separator: "" });
				if (text.trim()) {
					lastAssistantText = text;
					break;
				}
			}
			const init = this.sessionManager.getEntries().findLast(entry => entry.type === "session_init");
			const assembled =
				terminal && last?.status !== "aborted"
					? assembleYieldResult(
							yields,
							lastAssistantText,
							init?.outputSchema === undefined ? undefined : arrayValuedLabels(init.outputSchema),
						)
					: undefined;
			let resultSource: "agent" | "harness" =
				failure !== undefined || !terminal || (!assembled && last?.status !== "aborted") || assembled?.missingData
					? "harness"
					: "agent";
			let output =
				failure !== undefined || !terminal
					? JSON.stringify({
							error: failure === undefined ? "Phase ended without a terminal yield" : errorMessage(failure),
							source: "harness",
						})
					: last?.status === "aborted"
						? JSON.stringify({ error: last.error ?? "Agent ended the phase without success", source: "agent" })
						: !assembled || assembled.missingData
							? JSON.stringify({ error: "Phase yielded no result data", source: "harness" })
							: assembled.rawText
								? String(assembled.data)
								: JSON.stringify(assembled.data);
			if (
				terminal &&
				failure === undefined &&
				last?.status !== "aborted" &&
				assembled &&
				!assembled.missingData &&
				init?.outputSchema !== undefined
			) {
				const { validator, error } = buildOutputValidator(init.outputSchema);
				const validation = validator?.validate(assembled.data);
				if (error) {
					output = JSON.stringify({ error, source: "harness" });
					resultSource = "harness";
				} else if (validator && validation && !validation.success) {
					resultSource = "harness";
					output = JSON.stringify({
						error: "schema_violation",
						source: "harness",
						...summarizeValidationFailure(validation, assembled.data, validator.requiredFields),
					});
				}
			}
			await outbox.complete(
				selfId,
				parentId,
				phaseId,
				expandAgentReturn(this.getArgotSession(), output),
				resultSource,
			);
			await this.replayIrcContinuations();
		};
		// Park only a *blocked* follow-up (one a user interrupt is intentionally holding); an
		// already-resumable follow-up can ride the wake turn normally without reordering.
		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? this.agent.peekFollowUpQueue().slice()
				: [];
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues(this.agent.peekSteeringQueue().slice(), []);
		}
		this.#resetPromptMaintenanceState();
		this.#inFlight.begin();
		const retainedIndex = parentRecord
			? this.agent.state.messages.findIndex(
					message =>
						message.role === "custom" &&
						message.customType === parentRecord.customType &&
						Reflect.get(message.details ?? {}, "id") === Reflect.get(parentRecord.details ?? {}, "id"),
				)
			: -1;
		const phaseStart = retainedIndex >= 0 ? retainedIndex + 1 : this.agent.state.messages.length;
		if (retainedIndex >= 0) {
			// A crash after native yield persistence must publish B, not execute the phase again.
			for (let index = retainedIndex + 1; index < this.agent.state.messages.length; index++) {
				const message = this.agent.state.messages[index]!;
				if (
					message.role === "custom" &&
					(message.customType === "task:continuation" ||
						(message.customType === "irc:incoming" &&
							Reflect.get(message.details ?? {}, "relation") === "parent"))
				) {
					phaseEnd = index;
					break;
				}
				if (message.role !== "toolResult" || message.toolName !== "yield" || message.isError) continue;
				const details = message.details as YieldDetails | undefined;
				if (!details || (details.status !== "success" && details.status !== "aborted")) continue;
				yields.push(details);
				terminal ||= isTerminalYieldToolResult({ toolName: "yield", result: { details } });
				if (terminal) {
					phaseEnd = index + 1;
					break;
				}
			}
		}
		const ready =
			this.#ircActivePhase === phaseId && typeof phaseId === "string"
				? this.sessionManager.ensureOnDisk().then(() => this.sessionManager.sync())
				: Promise.resolve();
		const settled = ready
			.then(() =>
				terminal
					? undefined
					: records.length > 0 && retainedIndex < 0
						? this.agent.prompt(records)
						: this.agent.continue(),
			)
			.then(
				() => publish(),
				error => publish(error),
			)
			.then(async () => {
				if (typeof completionId === "string") {
					this.sessionManager.appendCustomEntry("irc:completion-consumed", completionId);
					this.sessionManager.flushSync();
					await this.sessionManager.sync();
				}
				published = true;
			})
			.catch(error => {
				logger.warn("Publishing an IRC continuation failed; retained phase will recover on activation", {
					error: errorMessage(error),
				});
			})
			.finally(async () => {
				unsubscribe();
				if (this.#ircActivePhase === phaseId) this.#ircActivePhase = undefined;
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						this.agent.peekSteeringQueue().slice(),
						parkedFollowUps.concat(this.agent.peekFollowUpQueue()),
					);
				}
				// Claim the next retained phase before dropping this turn's idle accounting.
				if (published) {
					await this.replayIrcContinuations(true).catch(error =>
						logger.warn("Recovering the next IRC phase failed", { error: errorMessage(error) }),
					);
				}
				this.#endInFlight();
			});
		this.#ircWakeSettled = settled;
		void settled.finally(() => {
			if (this.#ircWakeSettled === settled) this.#ircWakeSettled = undefined;
		});
		return ready;
	}

	/**
	 * Agent types a `/` command declared for the turn it just started.
	 *
	 * Granted from the command's static `spawnsAgents` list, never from anything a handler computed
	 * while running, so "which commands can reach a disabled agent" is answerable by reading the
	 * command definitions. Empty except between a command returning a prompt and that prompt's run
	 * settling: cleared on BOTH settle paths, the normal one and the reset an abort takes, because a
	 * grant that survived an aborted turn would leave a disabled agent open to the model's next
	 * unrelated spawn. See {@link agentGrantedThisTurn}.
	 */
	readonly #grantedAgents = new Set<string>();

	/**
	 * Whether a `/` command has granted this agent type for the turn in flight.
	 *
	 * `agent.agents.<name>.enabled` governs what the MODEL may choose. It does
	 * not govern the person typing: `/review` names `reviewer` outright, and someone
	 * running `/review` is asking for a review rather than asking the model whether
	 * to review. The command declares the agents its prompt names, that declaration
	 * is granted for exactly that turn, and the task tool and the eval `agent()`
	 * bridge both consult it.
	 */
	agentGrantedThisTurn(agentName: string): boolean {
		return this.#grantedAgents.has(agentName);
	}

	/**
	 * Arm prewalk outside the normal startup path (the `/prewalk` slash command). See
	 * {@link ModelHandoff.armPrewalk}.
	 */
	armPrewalk(target: Model, thinkingLevel?: ConfiguredThinkingLevel): void {
		this.#handoff.armPrewalk(target, thinkingLevel);
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#config = config;
		// Power assertions are taken per turn; nothing acquired here.
		this.#inFlight = new TurnsInFlight(this.settings);
		this.#extensionEvents = new ExtensionEventForwarder(config.extensionRunner);
		this.#scope = new SessionScope({
			sessionStore: this.sessionManager,
			settings: this.settings,
			agent: this.agent,
			isSpawned: config.isSpawned === true,
			refreshSecrets: () => this.#secrets.refresh({ refreshPrompt: false }),
			refreshSshTool: () => this.refreshSshTool({ activateIfAvailable: true }),
			refreshBaseSystemPrompt: async () => {
				await this.refreshBaseSystemPrompt("cwd-change");
			},
			rootWireAt: cwd => this.#wire.rootAt(cwd),
			emitCwdChanged: (previous, cwd) => this.#emit({ type: "cwd_changed", previous, cwd }),
		});
		this.#context = new ContextAccounting({
			sessionStore: this.sessionManager,
			model: () => this.model,
			messages: () => this.messages,
			instrumentationLevel: () => this.settings.get("session.instrumentation"),
			nonMessageTokens: () => computeNonMessageTokens(this),
			nonMessageBreakdown: () => computeNonMessageBreakdown(this),
			storedMessagesTokens: () => computeStoredMessagesTokens(this, { excludeEncryptedReasoning: true }),
		});
		this.#memory = new MemoryContext<AgentSession>({
			session: this,
			backend: () => resolveMemoryBackend(this.settings),
			backendId: () => this.settings.get("memory.backend"),
			sessionId: () => this.agent.sessionId,
			mnemopiState: () => getMnemopiSessionState(this),
			messages: () => this.agent.state.messages,
		});
		this.#providerSessions = new ProviderSessions(
			{
				agent: this.agent,
				sessionStore: this.sessionManager,
				authStorage: () => this.#config.modelRegistry.authStorage,
			},
			{
				configuredId: config.providerSessionId,
				inheritedCacheKey: config.providerPromptCacheKeySource === "fork" ? this.agent.promptCacheKey : undefined,
			},
		);
		this.#persistence = new MessagePersistence({
			sessionStore: this.sessionManager,
			instrumentationLevel: () => this.settings.get("session.instrumentation"),
			pendingContextSnapshot: () => this.#context.pending,
			nonMessageTokens: () => computeNonMessageTokens(this),
			consumeRewoundResult: toolCallId => this.#checkpoint.consumeRewoundResult(toolCallId),
			onTtsrInjectionPersisted: details => this.#ttsr.onInjectionPersisted(details),
		});
		this.#secrets = new SessionSecrets(config, {
			sessionId: () => this.sessionManager.getSessionId(),
			cwd: () => this.sessionManager.getCwd(),
			awaitScopeTransitionReady: () => this.awaitScopeTransitionReady(),
			queueRefresh: options => this.refreshSecrets(options),
			refreshSystemPrompt: async () => {
				await this.refreshBaseSystemPrompt("secrets-refresh");
			},
		});
		this.#approvals = new SessionApprovals(
			{
				settings: this.settings,
				clientBridge: () => this.#clientBridge,
				cwd: () => this.sessionManager.getCwd(),
				planModeActive: () => this.getPlanModeState()?.enabled === true,
			},
			config,
		);
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#parentEvalSessionId = config.parentEvalSessionId;
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#isSpawned = config.isSpawned === true;
		this.#taskDepth = config.taskDepth ?? 0;
		this.#parentTaskPrefix = config.parentTaskPrefix;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		this.#scopedModels = config.scopedModels ?? [];
		this.#thinking = new ThinkingRuntime({
			agent: this.agent,
			sessionStore: this.sessionManager,
			settings: this.settings,
			model: () => this.model,
			modelRegistry: () => this.#config.modelRegistry,
			sessionId: () => this.sessionId,
			obfuscateProviderText: text => this.obfuscateProviderText(text),
			sideComplete: () => this.#sideCompleteImpl,
			promptGeneration: () => this.#promptGeneration,
			magicKeywordEnabled: keyword => magicKeywordEnabled(this.settings, keyword),
			clearInheritedProviderPromptCacheKey: reason => this.#providerSessions.clearInheritedCacheKey(reason),
			emitSessionEvent: event => this.#emit(event),
		});
		this.#thinking.seedFromConfig(config.thinkingLevel, config.thinkingSource);
		this.#handoff = new ModelHandoff(
			{
				agent: this.agent,
				model: () => this.model,
				setModelTemporary: (model, thinkingLevel) =>
					this.setModelTemporary(model, thinkingLevel, { ephemeral: true }),
				emitNotice: (level, message, source) => this.emitNotice(level, message, source),
				waitForPersistence: message => this.#persistence.waitFor(message),
				todoGateOpen: toolResults => {
					if (toolResults.some(result => result.toolName === TOOL.todo)) this.#todo.noteTodoToolResult();
					return this.#todo.sawTodoTool || !this.#toolRegistry.has(TOOL.todo);
				},
				getActiveToolNames: () => this.getActiveToolNames(),
				hasBuiltInTool: name => this.hasBuiltInTool(name),
				setActiveToolsByName: toolNames => this.setActiveToolsByName(toolNames),
				getPlanModeState: () => this.getPlanModeState(),
				setPlanModeState: state => this.setPlanModeState(state),
				getPlanReferencePath: () => this.getPlanReferencePath(),
				setStandingResolveHandler: handler => this.setStandingResolveHandler(handler),
				resolvePlanPath: planFilePath => resolvePlanPath(this.sessionManager, planFilePath),
				localRootPath: () => resolveLocalUrlToPath("local://", localProtocolOptions(this.sessionManager)),
			},
			{ prewalk: config.prewalk, planYolo: config.planYolo },
		);
		this.#planMode = new PlanModeRuntime({
			agent: this.agent,
			sessionStore: this.sessionManager,
			toolChoices: this.#toolChoiceQueue,
			lastAssistantMessage: () => findLastAssistantMessage(this.agent.state.messages),
			hasTool: name => this.#toolRegistry.has(name),
			taskTool: () => this.#toolRegistry.get(TOOL.task),
			resolvePlanPath: planFilePath => resolvePlanPath(this.sessionManager, planFilePath),
			localProtocolOptions: () => localProtocolOptions(this.sessionManager),
			activeEditMode: () => resolveActiveEditMode(this.settings, this.model),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			promptGeneration: () => this.#promptGeneration,
		});

		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#skills = config.skills ?? [];
		this.#operatorNotices = config.operatorNotices ?? new OperatorNotices(stderrNoticeSink);
		// Per-session CPU budget. Probed once per process, registered always
		// (even at 0 cores) so a mid-session change to session.cpuLimitCores
		// activates enforcement, and warned about here when a configured limit
		// cannot be enforced on this host. Cleanup rides the "session"-scoped
		// owned-resource disposers in dispose().
		let cpuLimitSessionId = this.sessionManager.getSessionId();
		if (cpuLimitSessionId) {
			void initSessionCpuLimit({
				sessionId: cpuLimitSessionId,
				cores: this.settings.get("session.cpuLimitCores"),
				kill: this.settings.get("session.cpuLimitKill"),
				onNotice: text => this.#operatorNotices.warn("cpu", text),
			}).catch(error => logger.warn("CPU limit init failed", { error: errorMessage(error) }));
		}
		// `/new`, `/resume`, a fork and a branch mint a fresh id on this same live
		// process. Spawn sites resolve the limiter by the current id, so without
		// this the budget stays registered under the conversation the operator
		// just left and the one they are in now spawns unlimited.
		this.sessionManager.onSessionIdChanged(nextSessionId => {
			if (!nextSessionId) return;
			const previous = cpuLimitSessionId;
			cpuLimitSessionId = nextSessionId;
			if (previous && rekeySessionCpuLimit(previous, nextSessionId)) return;
			void initSessionCpuLimit({
				sessionId: nextSessionId,
				cores: this.settings.get("session.cpuLimitCores"),
				kill: this.settings.get("session.cpuLimitKill"),
				onNotice: text => this.#operatorNotices.warn("cpu", text),
			}).catch(error => logger.warn("CPU limit re-init failed", { error: errorMessage(error) }));
		});
		this.#customCommands = config.customCommands ?? [];
		// Resolve the wire service-tier per request so the Fireworks Priority
		// toggle scopes priority to Fireworks alone, without mutating the shared
		// session `serviceTier` that drives `/fast` and OpenAI/Anthropic priority.
		this.agent.serviceTierResolver = model => this.#effectiveServiceTier(model);
		// Prompt-cache enforcement, from the two operator settings. Reporting is on
		// by default and blocking is opt-in, so the common case warns; a `false`
		// report setting silences the check entirely, which is what `off` means to
		// the provider. Read once here because both settings are session-level; a
		// change takes effect on the next session, matching the other agent-level
		// wiring in this constructor.
		//
		// Compared against `true` rather than used for truthiness, because a config
		// file is not type-checked: a hand-edited `blockOnRejection: "false"`
		// arrives as the STRING "false", which is truthy, and would have turned
		// hard blocking on for an operator whose config says it is off. The
		// settings conditions in `settings-defs.ts` read booleans the same way.
		this.agent.cacheEnforcement =
			this.settings.get("cache.reportRejection") === true
				? this.settings.get("cache.blockOnRejection") === true
					? "error"
					: "warn"
				: "off";
		this.#serviceTierByFamily = config.serviceTierByFamily ?? {};
		this.#replanTitle = new ReplanTitleRefresh(
			{
				agent: this.agent,
				sessionStore: this.sessionManager,
				settings: this.settings,
				modelRegistry: config.modelRegistry,
				model: () => this.model,
				obfuscateProviderText: text => this.obfuscateProviderText(text),
				sideComplete: this.#sideCompleteImpl,
			},
			config.titleSystemPrompt,
		);
		this.#resolvePruneToolDescriptions =
			typeof config.pruneToolDescriptions === "function"
				? config.pruneToolDescriptions
				: () => config.pruneToolDescriptions === true;
		for (const warning of configWarningsFor(this.settings, config.modelRegistry)) {
			logger.warn(warning);
			this.configWarnings.push(warning);
		}
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#wire = new ProviderWire({
			settings: this.settings,
			cwd: this.sessionManager.getCwd(),
			upstream: config.transformProviderContext,
			secrets: this.#secrets,
		});
		// Agent was constructed before AgentSession; install the wire so the main loop, side
		// requests and advisors share one session-local tool-call id map.
		this.agent.setTransformProviderContext(this.#wire.transform);
		this.#sideStreamFn = config.sideStreamFn ?? streamSimple;
		const rawSse = config.rawSseDebugBuffer ?? (config.isSpawned === true ? undefined : new RawSseDebugBuffer());
		this.rawSseDebugBuffer = rawSse;
		// Avoid wrapping in an `async` closure when no user callback is configured: the
		// outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
		// and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
		// shows up as ~3.5% self time in streaming profiles.
		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					rawSse?.recordResponse(response, model);
					this.#usage.ingestHeaders(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					rawSse?.recordResponse(response, model);
					this.#usage.ingestHeaders(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		// With no buffer and no caller hook the provider gets no observer, so it neither builds the
		// per-event record nor resolves an OpenAI event name for one.
		this.#onSseEvent = !rawSse
			? configuredOnSseEvent
			: configuredOnSseEvent
				? (event, model) => {
						rawSse.recordEvent(event, model);
						configuredOnSseEvent(event, model);
					}
				: (event, model) => {
						rawSse.recordEvent(event, model);
					};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		const loopGuards = new LoopGuards({
			agent: this.agent,
			sessionStore: this.sessionManager,
			settings: this.settings,
			model: () => this.model,
			promptGeneration: () => this.#promptGeneration,
			isDisposed: () => this.#isDisposed,
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			schedulePostPromptTask: task => this.#postPrompt.schedule(task),
			discardAssistantTurn: message => this.#discardAssistantTurn(message),
		});
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			const rewindReport = this.#checkpoint.takeReport(messages);
			if (rewindReport) {
				await this.#applyRewind(rewindReport, messages);
			}
			if (context?.message.role === "assistant") {
				loopGuards.onTurnEnd(messages, { message: context.message, toolResults: context.toolResults });
			}
			await this.#handoff.advancePrewalk(messages, context);
			await this.#advisorRoster.onPrimaryTurnEnd(messages, context?.willContinue, signal);
			await this.#maintainContextMidRun(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
				if (messages.some(message => message.role === "custom" && message.customType === "mcp-event")) {
					let persisted = false;
					let lastError: unknown;
					for (let attempt = 0; attempt < 2 && !persisted; attempt++) {
						try {
							await this.sessionManager.ensureOnDisk();
							await this.sessionManager.sync();
							persisted = true;
						} catch (error) {
							lastError = error;
						}
					}
					if (!persisted) {
						logger.warn(
							"MCP event receipt sync failed after prompt delivery; event was delivered to the active session, but on-disk journal could not be synced and process restart may duplicate the event",
							{
								error: errorMessage(lastError),
							},
						);
					}
				}
			},
			scheduleIdleFlush: run => {
				this.#postPrompt.schedule(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});
		// Background-job completions / late diagnostics are pulled into the run at
		// each step boundary as non-interrupting asides. Peer IRCs share the aside
		// injection boundary, but also expose a non-consuming interrupt peek so
		// `job poll` / `irc wait` can return early before the boundary drains them.
		this.agent.hasIrcInterrupts = () => this.#ircInbox.hasInterrupts;
		this.agent.setAsideMessageProvider(() => {
			this.#pullSessionNotices(false);
			const pendingIrc = this.#takeIrcRecords();
			const thunks: AsideMessage[] = pendingIrc.map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());
			// Mid-run todo reconciliation — evaluated at injection time so a turn
			// that flips a todo just before this poll suppresses the nudge.
			thunks.push(() => this.#todo.takeMidRunNudge());
			// Memory context published mid-run (a recall on `agent_start`, a
			// mental-model reload) rides in here instead of rewriting the system
			// prompt, which would cost a full uncached re-read of the conversation.
			thunks.push(() => this.#memory.takePending());
			// Tool-scoped TTSR reminders. An aside rather than a steer: a steer
			// aborts the tool batch still in flight, and a reminder about a call
			// that already finished has no business cutting its siblings short.
			thunks.push(() => this.#ttsr.takePendingToolReminders());
			return thunks;
		});
		// A tool the agent started with is protected, except one the session file restored through
		// discovery: the SDK puts the restored selection into the agent's initial tools, and
		// protecting those would make every reloaded discovered tool immune to the cap and to pruning.
		const restoredByDiscovery = new Set(config.initialSelectedMCPToolNames ?? []);
		const requestedNames = new Set(config.requestedToolNames ?? []);
		const protectedToolNames =
			config.protectedToolNames ??
			new Set(
				[...requestedNames, ...this.agent.state.tools.map(t => t.name)].filter(
					name => !isMCPToolName(name) && (requestedNames.has(name) || !restoredByDiscovery.has(name)),
				),
			);
		this.#discovery = new ToolDiscovery(
			{
				registry: this.#toolRegistry,
				activeToolNames: () => this.getActiveToolNames(),
				discoveryModeFor: toolCount => resolveEffectiveToolDiscoveryMode(this.settings, toolCount),
				maxDiscoveredTools: () => this.settings.get("tools.maxDiscoveredTools"),
				sessionMessages: () => this.messages,
			},
			{
				...config,
				protectedToolNames,
			},
		);
		if (this.#discovery.restoredCapDrops.size > 0) {
			this.agent.setTools(this.agent.state.tools.filter(tool => !this.#discovery.restoredCapDrops.has(tool.name)));
		}
		this.#toolActivation = new ToolActivation(this, {
			registry: this.#toolRegistry,
			discovery: this.#discovery,
			approvals: this.#approvals,
			providerSessions: this.#providerSessions,
			config,
			customToolContext: () => this.#customToolContext(),
		});
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (this.#discovery.mcpEnabled && (persistInitialMCPToolSelection || this.#discovery.restoredCapDrops.size > 0)) {
			const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
			if (!sameToolNames(this.sessionManager.getMCPToolSelection() ?? [], currentSelectedMCPToolNames)) {
				this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
			}
		}
		this.#discovery.rememberSessionDefaults(this.sessionManager.getSessionFile());
		this.#streamingEdit = new StreamingEditGuard({
			abortTurn: () => this.agent.abort(),
			streamingAbortEnabled: () => this.settings.get("edit.streamingAbort"),
			blockAutoGenerated: () => this.settings.get("edit.blockAutoGenerated"),
			fuzzyMatch: () => ({
				allowFuzzy: this.settings.get("edit.fuzzyMatch"),
				fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
			}),
			cwd: () => this.sessionManager.getCwd(),
			localProtocol: () => localProtocolOptions(this.sessionManager),
			expandSecretsForDiskComparison: text => this.#secrets.expandForDiskComparison(text),
			redactForLog: text => this.#secrets.redactForLog(text),
		});
		this.#stopRetries = new StopRetries({
			agent: this.agent,
			sessionStore: this.sessionManager,
			unexpectedStopDetection: () => this.settings.get("features.unexpectedStopDetection") === true,
			classifyUnexpectedStop: (text, signal) =>
				classifyUnexpectedStop(text, {
					settings: this.settings,
					registry: this.#config.modelRegistry,
					model: this.model ?? undefined,
					sessionId: this.sessionId,
					metadataResolver: provider => this.agent.metadataForProvider(provider),
					signal,
					obfuscateProviderText: providerText => this.obfuscateProviderText(providerText),
					completeImpl: this.#sideCompleteImpl,
				}),
			promptGeneration: () => this.#promptGeneration,
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			discardAssistantTurn: message => this.#discardAssistantTurn(message),
			dropPersistedAssistantTurn: async message => {
				await this.#persistence.waitFor(message);
				this.#discardAssistantTurn(message);
			},
			removeAssistantFromActiveContext: (message, reason) =>
				removeAssistantMessageFromActiveContext(this.agent, message, reason),
			endAnnouncedContinuationWait: finalError => this.#retry.endAnnouncedContinuationWait(finalError),
			failAtEmptyStopCap: (attempts, finalError) => this.#retry.failAtEmptyStopCap(attempts, finalError),
		});
		this.#usage = new ProviderUsage({
			authStorage: () => this.#config.modelRegistry.authStorage,
			providerBaseUrl: provider => this.#config.modelRegistry.getProviderBaseUrl?.(provider),
			settings: this.settings,
			sessionId: () => this.#providerSessions.activeId(),
			agentSessionId: () => this.agent.sessionId,
			model: () => this.model ?? undefined,
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			ui: () => (this.#config.extensionRunner?.hasUI() ? this.#config.extensionRunner.getUIContext() : undefined),
		});
		this.#rewrites = new HistoryRewrites({
			sessionStore: this.sessionManager,
			agent: this.agent,
			settings: this.settings,
			withPlanProtection: config => this.#planMode.withProtection(config),
			model: () => this.model,
			keepBoundaryId: branch => contextCompaction(branch, this.model?.provider)?.firstKeptEntryId,
			rebuiltMessages: () => this.buildDisplaySessionContext().messages,
			resetAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
			closeCodexSessions: () => this.#providerSessions.closeCodexForHistoryRewrite(this.model),
			markHistoryRewritten: () => this.#context.markHistoryRewritten(),
			syncTodos: () => this.#todo.syncFromBranch(),
		});
		this.#finalize = new FinalizeReminders({
			agent: this.agent,
			sessionStore: this.sessionManager,
			settings: this.settings,
			isSpawned: () => config.isSpawned === true,
			awaitingRewind: () => this.#checkpoint.awaitingRewind,
			scheduleContinue: () => this.#scheduleAgentContinue({ generation: this.#promptGeneration }),
			activeToolNames: () => this.getActiveToolNames(),
		});
		this.#ttsr = new TtsrRuntime(
			{
				agent: this.agent,
				sessionStore: this.sessionManager,
				argotEnabled: () => this.settings.get("argot.enabled") === true,
				argotLoaded: () => this.#config.argot?.loaded === true,
				promptGeneration: () => this.#promptGeneration,
				emitSessionEventDetached: (event, context) => this.#emitSessionEventDetached(event, context),
				scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
				schedulePostPromptTask: (task, options) => this.#postPrompt.schedule(task, options),
			},
			config.ttsrManager,
		);
		this.#todo = new TodoRuntime({
			agent: this.agent,
			sessionStore: this.sessionManager,
			todoSettings: () => ({
				enabled: this.settings.get("todo.enabled"),
				reminders: this.settings.get("todo.reminders"),
				remindersMax: this.settings.get("todo.reminderLimit"),
				eager: this.settings.get("todo.eager"),
			}),
			model: () => this.model,
			planModeEnabled: () => this.#planMode.enabled,
			goalModeActive: () => this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active",
			activeToolNames: () => this.getActiveToolNames(),
			eagerPreludeContext: () => this.#buildEagerPreludeContext(),
			consumeLastServedToolChoiceLabel: () => this.#toolChoiceQueue.consumeLastServedLabel(),
			hasPendingAsyncWake: () => this.#hasPendingAsyncWake(),
			emitSessionEvent: event => this.#emitSessionEvent(event),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			promptGeneration: () => this.#promptGeneration,
		});
		this.#maxConcurrency = new MaxConcurrencyRuntime(this);
		// Runs synchronously on the stream, ahead of the queued `message_update`, so a guard abort
		// lands on the delta that earned it.
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			this.#streamingEdit.observe(message, assistantMessageEvent);
			loopGuards.observe(message, assistantMessageEvent);
		});
		// The tool-result hook is the single site for synchronous post-tool actions that must affect the current loop.
		this.agent.afterToolCall = ctx => this.#afterToolCall(ctx);
		this.agent.providerSessionState = this.#providerSessions.states;
		this.#providerSessions.sync();
		this.#todo.syncFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			budgetsEnabled: () => this.settings.get("goal.modelBudgetsEnabled"),
			getCurrentUsage: () => this.#goalUsage(),
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => recordGoal(this.sessionManager, mode, state),
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});
		// The counterpart of the exit recorder below: a death that never reached
		// JavaScript wrote no `session_exit` entry and no error line, so the only
		// account of it is what its process left on disk — the in-flight marker of
		// a tool call, and the heartbeat naming the phase it was in. Sweep those
		// into the log before this session starts writing its own.
		reportAbandonedToolCalls();
		reportSilentDeaths();
		this.#heartbeat = joinHeartbeat({
			spawned: this.#isSpawned,
			sessionId: () => this.sessionManager.getSessionId(),
			phase: () =>
				this.isCompacting
					? "compaction"
					: this.#toolMarkerSessions.size > 0
						? "tool"
						: this.isStreaming
							? "provider"
							: "idle",
		});
		this.#cancelExitRecorder = postmortem.register(`agent-session:${this.sessionManager.getSessionId()}`, reason => {
			this.#recordSessionExit(reason);
		});
		this.#heartbeatLogInterval = setInterval(() => this.#logHeartbeat(), SESSION_HEARTBEAT_INTERVAL_MS);
		this.#heartbeatLogInterval.unref?.();

		this.#advisorRoster = this.#createAdvisorRoster(config);
		this.#advisorRoster.enableFromSettings();
		this.#sessionSwitch = this.#createSessionSwitch();
		this.#sessionBranch = this.#createSessionBranch();
		this.#sessionHandoff = this.#createSessionHandoff();

		this.#checkpoint.rehydrate(this.sessionManager.getBranch());

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#listenerReleases.push(
			onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model)),
			onHelperModelsChanged(() => this.#advisorRoster.onHelperModelsChanged()),
		);
		const unsubscribePromptSettings = this.settings.onEffectiveSettingChanged((path, value) => {
			if (this.#isDisposed) return;
			// Disabling either half of the todo-reminder feature is an explicit
			// lifecycle boundary. Reset synchronously with the effective setting
			// write rather than waiting for a later agent_end: there may be no stop
			// while disabled, and a stale self-continuation latch would otherwise
			// survive disable/re-enable and silence the fresh runway.
			if ((path === "todo.reminders" || path === "todo.enabled") && value === false) {
				this.#todo.onRemindersDisabled();
			}
			// The limiter used to learn about a changed budget only when the bash
			// or launch tool next ran, because those two are the only spawn paths
			// that call `update()` themselves. Everything else (eval kernels, MCP
			// servers, hook and custom-tool `exec`) adopts into the group without
			// touching the quota, so lowering the limit did nothing to work
			// already running and `/cpu-limit remove` did not lift a live cap
			// until the operator happened to run a command.
			if (path === "session.cpuLimitCores" || path === "session.cpuLimitKill") {
				const limiter = sessionCpuLimit(this.sessionManager.getSessionId());
				void limiter
					?.update(this.settings.get("session.cpuLimitCores"), this.settings.get("session.cpuLimitKill"))
					.catch(error => logger.warn("CPU limit update failed", { error: errorMessage(error) }));
			}
			if (path === "agent.maxConcurrency") {
				this.#maxConcurrency.onSettingChanged();
			}
			if (!rebuildsThePrompt(path)) return;
			this.#promptRefresh = this.#promptRefresh
				.then(async () => {
					if (!this.#isDisposed) await this.refreshBaseSystemPrompt(`setting:${path}`);
				})
				.catch(error => {
					// `warn`, not `debug`: this is the only report a failed rebuild gets
					// now that the trigger lives here rather than in the settings UI, and
					// the session it leaves behind is describing a configuration the
					// operator has already changed.
					logger.warn("System prompt refresh after setting change failed", {
						path,
						error: errorMessage(error),
					});
				});
		});
		this.#listenerReleases.push(unsubscribePromptSettings);
	}

	/** The advisor roster, reaching this session only through the host it declares. */
	#createAdvisorRoster(config: AgentSessionConfig): AdvisorRoster {
		const host: AdvisorRosterHost = {
			agent: this.agent,
			yieldQueue: this.yieldQueue,
			settings: this.settings,
			modelRegistry: this.#config.modelRegistry,
			providerSessionState: this.#providerSessions.states,
			sideComplete: this.#sideCompleteImpl,
			agentKind: config.agentKind ?? "main",
			provider: {
				streamFn: config.advisorStreamFn,
				preferWebsockets: config.preferWebsockets,
				payloadHook: config.payloadHook,
				onResponse: this.#onResponse,
				onSseEvent: this.#onSseEvent,
				transformProviderContext: this.#wire.transform,
				resolveSecretRuntimeLeaseForContext: this.#secrets.resolveLeaseForContext,
			},
			sessionFile: () => this.sessionManager.getSessionFile(),
			cwd: () => this.sessionManager.getCwd(),
			sessionId: () => this.sessionId,
			isDisposed: () => this.#isDisposed,
			abortInProgress: () => this.#abortInProgress,
			isStreaming: () => this.isStreaming,
			planModeEnabled: () => this.#planMode.enabled,
			hasTerminalTextAnswerWithoutQueuedWork: () => this.hasTerminalTextAnswerWithoutQueuedWork(),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			steerAdvice: async (content, details) => {
				if (!this.isStreaming) {
					await this.sendCustomMessage(
						{ customType: "advisor", content, display: true, attribution: "agent", details },
						{ deliverAs: "nextTurn", triggerTurn: false },
					);
					return;
				}
				await this.sendCustomMessage(
					{ customType: "advisor", content, display: true, attribution: "agent", details },
					{ deliverAs: "steer", triggerTurn: false },
				);
			},
			parkForNextTurn: card => {
				this.#pendingNextTurnMessages.push(card);
			},
			dropParkedAdvisorCards: () => {
				if (this.#pendingNextTurnMessages.some(isAdvisorCard)) {
					this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
				}
			},
			leaseSecretRuntime: () => this.leaseSecretRuntime(),
			providerRedactor: () => this.providerRedactor,
			effectiveServiceTier: model => this.#effectiveServiceTier(model),
			primaryPromptCacheKey: () => this.agent.promptCacheKey,
			resolveContextPromotionTarget: (model, contextWindow) =>
				this.#resolveContextPromotionTarget(model, contextWindow),
			convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
			primaryContextBudget: () => ({
				nonMessageTokens: computeNonMessageTokens(this),
				contextWindow: declaredContextWindow(this.model),
			}),
			saveArtifact: (content, toolType) => this.sessionManager.saveArtifact(content, toolType),
		};
		return new AdvisorRoster(host, config.loadAdvisorTools, config);
	}

	/** Branching and tree navigation, reaching this session only through the host it declares. */
	#createSessionBranch(): SessionBranch {
		return new SessionBranch(this, {
			checkpoint: this.#checkpoint,
			todo: this.#todo,
			providerSessions: this.#providerSessions,
			memory: this.#memory,
			advisorRoster: this.#advisorRoster,
			secrets: this.#secrets,
			extensionRunner: () => this.#config.extensionRunner,
			modelRegistry: () => this.#config.modelRegistry,
			payloadHook: () => this.#config.payloadHook?.(),
			sideComplete: this.#sideCompleteImpl,
			effectiveServiceTier: model => this.#effectiveServiceTier(model),
			clearNextTurnMessages: () => {
				this.#pendingNextTurnMessages = [];
				this.#scheduledHiddenNextTurnGeneration = undefined;
			},
			cancelOwnAsyncJobs: () => this.#cancelOwnAsyncJobs(),
			cancelPostPromptTasks: () => this.#cancelPostPromptTasks(),
			resetMemoryContextForNewTranscript: () => this.#resetMemoryContextForNewTranscript(),
			restoreMCPSelectionsForSessionContext: sessionContext =>
				this.#toolActivation.restoreMCPSelections(sessionContext),
		});
	}

	/** The handoff, reaching this session only through the host it declares. */
	#createSessionHandoff(): SessionHandoff {
		return new SessionHandoff(this, {
			checkpoint: this.#checkpoint,
			todo: this.#todo,
			providerSessions: this.#providerSessions,
			memory: this.#memory,
			secrets: this.#secrets,
			sideComplete: this.#sideCompleteImpl,
			extensionRunner: () => this.#config.extensionRunner,
			modelRegistry: () => this.#config.modelRegistry,
			baseSystemPrompt: () => this.#toolActivation.baseSystemPrompt,
			effectiveServiceTier: model => this.#effectiveServiceTier(model),
			clearNextTurnMessages: () => {
				this.#pendingNextTurnMessages = [];
				this.#scheduledHiddenNextTurnGeneration = undefined;
			},
			cancelOwnAsyncJobs: () => this.#cancelOwnAsyncJobs(),
			endConversation: () => this.#endConversation(),
			resetMemoryContextForNewTranscript: () => this.#resetMemoryContextForNewTranscript(),
			resetAllAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
		});
	}

	/** The session switch, reaching this session only through the host it declares. */
	#createSessionSwitch(): SessionSwitch {
		return new SessionSwitch(this, {
			scope: this.#scope,
			wire: this.#wire,
			providerSessions: this.#providerSessions,
			memory: this.#memory,
			discovery: this.#discovery,
			checkpoint: this.#checkpoint,
			thinking: this.#thinking,
			todo: this.#todo,
			advisorRoster: this.#advisorRoster,
			extensionRunner: () => this.#config.extensionRunner,
			modelRegistry: () => this.#config.modelRegistry,
			whileDisconnectedFromAgent: run => this.#whileDisconnectedFromAgent(run),
			reconcileAfterSwitch: () => this.#sessionSwitchReconciler?.(),
			captureFields: () => ({
				pendingNextTurnMessages: [...this.#pendingNextTurnMessages],
				scheduledHiddenNextTurnGeneration: this.#scheduledHiddenNextTurnGeneration,
				baseSystemPrompt: this.#toolActivation.baseSystemPrompt,
				serviceTierByFamily: this.#serviceTierByFamily,
			}),
			restoreFields: fields => {
				this.#pendingNextTurnMessages = fields.pendingNextTurnMessages;
				this.#scheduledHiddenNextTurnGeneration = fields.scheduledHiddenNextTurnGeneration;
				this.#toolActivation.baseSystemPrompt = fields.baseSystemPrompt;
				this.#serviceTierByFamily = fields.serviceTierByFamily;
			},
			clearNextTurnMessages: () => {
				this.#pendingNextTurnMessages = [];
				this.#scheduledHiddenNextTurnGeneration = undefined;
			},
			setServiceTierByFamily: byFamily => {
				this.#serviceTierByFamily = byFamily;
			},
			restoreMCPSelectionsForSessionContext: (sessionContext, options) =>
				this.#toolActivation.restoreMCPSelections(sessionContext, options),
			setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
			resetMemoryContextForNewTranscript: () => this.#resetMemoryContextForNewTranscript(),
			endConversation: () => this.#endConversation(),
			resetAllAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
		});
	}

	/**
	 * Whether the conversation is resting on an answer: the last turn ended on its own with text
	 * for the user, and nothing is queued behind it. Advisor routing asks so a note can be kept as
	 * a card rather than waking a duplicate completion turn, and `/rephrase` asks so it only
	 * submits when there is something to rephrase — mid-turn the reply is still arriving, a turn
	 * that ended in tool calls or an error said nothing, and a queued message means the answer on
	 * screen is already superseded. Trailing advisor cards are not answers and do not count.
	 */
	hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.agent.hasQueuedMessages() || this.#pendingNextTurnMessages.length > 0) return false;
		const messages = this.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	/** Re-prime every advisor's transcript view and TTSR's after a transcript rewrite
	 *  (compaction/shake/rewind), without the session-level latch reset
	 *  {@link AdvisorRoster.resetSessionState} performs. */
	#resetAllAdvisorRuntimes(): void {
		this.#advisorRoster.resetRuntimes();
		this.#ttsr.onCompaction();
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#config.modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#config.agentId;
	}

	/** Dequeue the next HARD forced tool choice for the upcoming LLM call, dropping
	 *  (and rejecting) one whose named tool is no longer active. */
	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

	/**
	 * The per-turn tool-choice directive for the agent loop's `getToolChoice`. Priority:
	 *   1. a HARD forced choice from the queue (genuine forces: user-force, eager-todo, …) —
	 *      consuming (advances the queue generator);
	 *   2. else, when a non-forcing preview is pending, a {@link SoftToolRequirement} — a
	 *      PEEK (advances/pops nothing), so the agent-loop injects the reminder once per head
	 *      and escalates to a forced `resolve` only if the model declines. A compliant turn
	 *      pays ZERO tool_choice change (no prompt-cache messages-cache invalidation);
	 *   3. else undefined.
	 */
	nextToolChoiceDirective(): ToolChoiceDirective | undefined {
		const hard = this.#nextHardToolChoice();
		if (hard !== undefined) return hard;
		const head = this.#toolChoiceQueue.peekPendingHead();
		if (head !== undefined) {
			return {
				soft: true,
				id: head.id,
				toolName: "resolve",
				reminder: [buildResolveReminderMessage(head.sourceToolName)],
			};
		}
		return undefined;
	}

	/** Peek the head non-forcing pending preview invoker, for the `resolve` tool's dispatch. */
	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	/** Clear stale non-forcing pending preview invokers after `resolve` proves none can run. */
	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for use by the resolve tool. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Standing (long-lived) handler the `resolve` tool falls back to when no
	 *  queue invoker is in flight. Used by plan mode so the agent can submit
	 *  approval via `resolve` without forcing the tool choice every turn. */
	#standingResolveHandler: ((input: unknown) => Promise<unknown> | unknown) | undefined;

	peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#standingResolveHandler;
	}

	setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {
		this.#standingResolveHandler = handler ?? undefined;
	}

	#sessionSwitchReconciler: (() => Promise<void>) | undefined;

	setSessionSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		this.#sessionSwitchReconciler = reconciler ?? undefined;
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessions.states;
	}

	/** Hint forwarded to provider calls that support websocket transport. */
	get preferWebsockets(): boolean | undefined {
		return this.#config.preferWebsockets;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#memory.hindsight;
	}

	/**
	 * This session's Argot codec, or `undefined` when the feature is off. Exposed
	 * so a spawning parent can hand a spawned agent a fork of it (the `inherit`
	 * agent mode); the fork is detached, so the child never mutates the parent.
	 */
	getArgotSession(): ArgotSession | undefined {
		return this.#config.argot;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		return this.#memory.swapHindsight(state);
	}

	getMnemopiSessionState(): MnemopiSessionState | undefined {
		return getMnemopiSessionState(this);
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsr.manager;
	}

	/** Secret obfuscator, when secrets are configured; /share redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#secrets.expansionObfuscator;
	}

	/** Whether the authoritative live runtime currently has secret protection enabled. */
	get secretsEnabled(): boolean {
		return this.#secrets.expansionObfuscator !== undefined;
	}

	/** Live session-lifetime provider redactor, including disable/move tombstones. */
	obfuscateProviderText(text: string): string {
		return this.#secrets.obfuscateProviderText(text);
	}

	/**
	 * The live redaction authority, for a consumer that must hold the object.
	 * Read this, not `obfuscator`, on any path that hides a value; see
	 * {@link SessionSecrets.providerRedactor}.
	 */
	get providerRedactor(): SecretObfuscator | undefined {
		return this.#secrets.providerRedactor;
	}

	/**
	 * Install the SDK coordinator's winning snapshot in the session view.
	 *
	 * This method is synchronous on purpose: the coordinator updates its closure
	 * authority and this view in the same commit turn.
	 */
	installSecretRuntime(runtime: SecretRuntimeLease): void {
		this.#secrets.install(runtime);
	}

	/** Wait until every scope transition initiated before this call has settled. */
	async awaitScopeTransitionReady(): Promise<void> {
		await this.#scope.ready();
	}

	/** Admit one immutable request runtime after the winning scope is ready. */
	leaseSecretRuntime(): Promise<SecretRuntimeLease> {
		return this.#secrets.lease();
	}

	/** Reload config/env/vault state in monotonic lifecycle initiation order. */
	refreshSecrets(options?: SecretsRefreshOptions): Promise<void> {
		return this.#scope.run(() => this.#secrets.refresh(options));
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsr.isAbortPending;
	}

	/** Whether an expected internal plan-mode abort is pending. Consumed by
	 *  `#handleAgentEvent` to stamp `SILENT_ABORT_MARKER` on the next aborted
	 *  assistant message_end; callers clear it in `finally`. */
	get isPlanInternalAbortPending(): boolean {
		return this.#planInternalAbortPending;
	}

	/** Arm the silent-abort marker for the next aborted assistant message_end.
	 *  Caller MUST clear via `clearPlanInternalAbortPending()` in a `finally`
	 *  to guarantee no leak. */
	markPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = true;
	}

	/** Unconditionally clear the silent-abort flag. Idempotent: safe when the
	 *  flag was never set OR was already consumed by `#handleAgentEvent`. */
	clearPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = false;
	}

	/**
	 * Deliver a finished async job's result to the conversation.
	 *
	 * When the job names the tool call that started it and that call is still
	 * pending in the current context — its `toolCall` block has no `toolResult`
	 * because a continuation, abort or crash split the pair — the result
	 * attaches to the original call and no model turn is enqueued: the loop
	 * does not need to reason over an arrival the transcript can simply record.
	 * When the call is answered already, or no longer present (the session
	 * branched away from it), the result takes the ordinary async-result
	 * follow-up, which re-wakes the loop; a request that then replays the
	 * unanswered call keeps the provider-side orphan-placeholder repair.
	 */
	deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): "attached" | "queued" {
		const toolCallId = job?.toolCallId;
		if (toolCallId && this.#attachLateToolResult(toolCallId, text, job)) {
			return "attached";
		}
		this.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
			jobId,
			result: text,
			job,
			durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
		});
		return "queued";
	}

	/**
	 * Append a `toolResult` for a call the current context left unanswered.
	 * Returns false — caller falls back to the async-result follow-up — when
	 * the call is not in the message list at all (branched away, compacted
	 * out) or already has its result.
	 */
	#attachLateToolResult(toolCallId: string, text: string, job: AsyncJob | undefined): boolean {
		const messages = this.agent.state.messages;
		let callIndex = -1;
		let toolName: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const block = message.content.find(part => part.type === "toolCall" && part.id === toolCallId);
			if (block && block.type === "toolCall") {
				callIndex = i;
				toolName = block.name;
				break;
			}
		}
		if (callIndex < 0) return false;
		for (let i = callIndex + 1; i < messages.length; i++) {
			const message = messages[i];
			if (message.role === "toolResult" && message.toolCallId === toolCallId) return false;
		}
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: toolName ?? job?.type ?? "tool",
			content: [{ type: "text", text }],
			details: job
				? { async: { state: job.status === "failed" ? "failed" : "completed", jobId: job.id } }
				: undefined,
			isError: job?.status === "failed",
			timestamp: Date.now(),
		};
		this.agent.appendMessage(toolResultMessage);
		this.#persistence.persistIfMissing(toolResultMessage);
		this.#emitSessionEventDetached({ type: "message_start", message: toolResultMessage }, "late tool result");
		this.#emitSessionEventDetached({ type: "message_end", message: toolResultMessage }, "late tool result");
		return true;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = this.#asyncJobManager;
		if (!manager) return null;
		const ownerFilter = this.#config.agentId ? { ownerId: this.#config.agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	/**
	 * Cancel async jobs registered by this agent and by every agent it spawned.
	 * Used by lifecycle transitions (newSession, switchSession, handoff, dispose)
	 * so a session cleans up its own background work without touching its
	 * parent's or a sibling's jobs.
	 *
	 * DOWN the spawn tree, never up or sideways. A spawned agent exists to serve the
	 * agent that spawned it, so once this session is being torn down or moved to a
	 * new session, a grandchild's background job has nobody left to deliver to: it
	 * would keep running, keep spending, and report to a session that is gone.
	 * Cancelling only `ownerId` left exactly that orphan whenever a spawned agent had
	 * itself delegated. Reaching UP would be the old bug this scoping fixed (issue
	 * #1923): a secondary in-process session must never tear down the primary's
	 * work.
	 *
	 * Cancellation runs against this session's scoped manager. Spawned agents have
	 * unique agent ids and inherit the parent's manager to clean up their own
	 * jobs. A secondary in-process top-level session gets no scoped manager,
	 * because it defaults to `MAIN_AGENT_ID`; reaching through the global
	 * singleton would tear down the owning primary session's bash/task jobs at
	 * dispose time (issue #1923).
	 *
	 * No-op when no manager is reachable or this session has no agent id.
	 */
	#cancelOwnAsyncJobs(): void {
		if (!this.#config.agentId) return;
		const manager = this.#asyncJobManager;
		if (!manager) return;
		manager.cancelAll({ ownerId: this.#config.agentId });
		for (const descendant of AgentRegistry.global().descendantsOf(this.#config.agentId)) {
			manager.cancelAll({ ownerId: descendant });
		}
	}

	/**
	 * Release what the conversation this session just left holds: its spawned agents and registry
	 * scope, then its eval kernels.
	 *
	 * A kernel is keyed by the transcript's eval session id, so no cell of the next conversation
	 * reaches the previous one's kernel, and it kept its interpreter's memory until the session
	 * ended: a window open for days held one kernel per conversation. The release runs the
	 * registry `dispose` uses, so every eval language goes with it; a kernel a spawned agent still
	 * shares stays alive for that agent. A cell still running in a released kernel ends cancelled:
	 * the pool no longer holds its session, so it is not retried into a fresh kernel. A release that
	 * fails is logged and does not fail the switch.
	 */
	async #endConversation(): Promise<void> {
		await this.#rescopeAgentRegistry();
		try {
			await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		} catch (error) {
			logger.warn("Some eval kernels of the previous conversation failed to release", {
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Re-root this session in the agent registry after it has moved to a
	 * different transcript, and release the spawned agents of the conversation it
	 * left.
	 *
	 * The registry is process-global and, until this existed, nothing ever told
	 * it that a conversation had ended. `/new` and `/resume` swap the transcript
	 * under the same `AgentSession`, so every spawned agent of the previous
	 * conversation stayed registered: the agent dashboard listed them, `irc
	 * list` offered them as peers, and messaging one woke an agent whose replies
	 * were written into a transcript the operator had already left. That is the
	 * "agents from other sessions" symptom, and it is a leak as much as a
	 * display bug — a parked ref holds its session file, and a live one holds a
	 * whole `AgentSession`.
	 *
	 * Order matters. Terminate the descendants BEFORE the re-scope, so they are
	 * reached while they still resolve as this agent's subtree; re-scoping first
	 * would leave them parented to a scope nothing walks. Their async jobs are
	 * already cancelled by the caller's `#cancelOwnAsyncJobs`, which walks the
	 * same subtree.
	 *
	 * Terminate, not release. Release disposes the session, and dispose stops the
	 * agent loop but leaves the agent's bash, eval, handoff and advisor work
	 * running and its scheduled continuations armed. `terminate` aborts a running
	 * agent first, deepest generation first, which is the kill the dashboard and
	 * `job cancel` use. It is called on each direct child; the child's own
	 * subtree is terminated inside that call.
	 *
	 * A termination that throws is logged and skipped rather than failing the
	 * session switch: a spawned agent that cannot be stopped must not strand the
	 * operator between two conversations. The wait lasts as long as the child's
	 * abort, the same wait this session's own abort imposes at the start of `/new`.
	 */
	async #rescopeAgentRegistry(): Promise<void> {
		const id = this.#config.agentId;
		if (!id) return;
		const registry = AgentRegistry.global();
		const self = registry.get(id);
		if (!self) return;
		const endingScope = self.scope;
		const descendants = registry.descendantsOf(id);
		await this.terminateSpawnedAgents(RESCOPE_TERMINATE_REASON);
		// The traffic goes whether or not anything was still registered to release.
		// Guarding this on `descendants.length` was wrong in the COMMON case: a
		// agent that finished and aged out, or was disposed, is already
		// unregistered by the time the operator types `/new`, so the walk returns
		// nothing and the entire previous conversation's log survived in the
		// process-global bus. The new session's Comms pane then opened on the old
		// one's chatter, because every one of those lines has this still-in-scope
		// agent at one end.
		//
		// Forget this agent's own legs too. `forgetAgents` drops a line when
		// EITHER endpoint is named, and every line of the conversation that just
		// ended has either a released child or this agent on it. Bounded by the
		// ENDING scope so the purge cannot reach a line another conversation in
		// this process recorded under a recycled agent name.
		IrcBus.global().forgetAgents(descendants.concat([id]), endingScope);
		// Standing approval grants die with the conversation they were given in.
		// "Allow bash for this session" is an answer about the work in front of
		// you, and `/new` or `/resume` replaces that work entirely; carrying the
		// grant across meant a permission granted for one task silently governed
		// the next one, on a store that is deliberately never persisted precisely
		// so it cannot outlive its context.
		this.#approvals.forgetToolDecisions();
		registry.rescope(id, this.sessionManager.getSessionId?.() ?? undefined);
		logger.debug("Re-rooted the agent registry for a new conversation", {
			agentId: id,
			from: endingScope,
			to: registry.get(id)?.scope,
			released: descendants.length,
		});
	}

	/**
	 * Terminate every agent this session spawned, each direct child with its own
	 * subtree, deepest generation first. A termination that throws is logged and
	 * skipped. Used when this conversation ends while the process keeps running:
	 * a `/new` or `/resume` in place, and the disposal of a top-level session
	 * that is not the last one in the process.
	 */
	async terminateSpawnedAgents(reason: string): Promise<void> {
		const id = this.#config.agentId;
		if (!id) return;
		const registry = AgentRegistry.global();
		const children = registry.descendantsOf(id).filter(descendant => registry.get(descendant)?.parentId === id);
		if (children.length === 0) return;
		const lifecycle = AgentLifecycleManager.global();
		await Promise.all(
			children.map(async child => {
				try {
					await lifecycle.terminate(child, reason);
				} catch (error) {
					logger.warn("Failed to terminate a spawned agent of an ending conversation", {
						agentId: child,
						error: errorMessage(error),
					});
				}
			}),
		);
	}

	/**
	 * True when a background async job owned by this agent is still running with
	 * an unsuppressed delivery, or a finished job's delivery is still queued or
	 * in flight. Either way the async-result follow-up will re-wake the loop, so
	 * a settle observed now is a scheduling pause rather than a terminal stop:
	 * stop-time passes (todo reminder, session_stop hooks) defer to the settle
	 * reached once the session is fully idle. Suppressed deliveries
	 * (acknowledged, or watched by an in-flight `job` poll) never wake the loop,
	 * so they don't count.
	 */
	#hasPendingAsyncWake(): boolean {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#config.agentId ? { ownerId: this.#config.agentId } : undefined;
		return (
			manager.getRunningJobs(ownerFilter).some(job => !manager.isDeliverySuppressed(job.id)) ||
			manager.hasPendingDeliveries(ownerFilter)
		);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration.
		const listeners = this.#eventListeners.slice();
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;
				// Listener may be an async function whose returned Promise we don't await;
				// attach a catch so a rejection does not become an unhandled rejection.
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", {
							error: errorMessage(err),
						});
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", {
					error: errorMessage(err),
				});
			}
		}
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	/** The current turn phase or tool name in flight for heartbeat logging, or empty string when none. */
	get heartbeatPhase(): string {
		if (this.#inFlightToolNames.size > 0) {
			return Array.from(this.#inFlightToolNames.values()).join(",");
		}
		if (this.#toolMarkerSessions.size > 0) {
			return "tool";
		}
		if (this.isCompacting) {
			return "compaction";
		}
		if (this.isStreaming) {
			return "provider";
		}
		return "";
	}

	#logHeartbeat(): void {
		try {
			logger.info("Session heartbeat", {
				pid: process.pid,
				sessionId: this.sessionManager.getSessionId(),
				phase: this.heartbeatPhase,
			});
		} catch {
			// Heartbeat logging must never break the session.
		}
	}

	#recordSessionExit(reason: postmortem.Reason | "dispose"): void {
		if (this.#exitRecorded) return;
		this.#exitRecorded = true;
		if (this.#heartbeatLogInterval !== undefined) {
			clearInterval(this.#heartbeatLogInterval);
			this.#heartbeatLogInterval = undefined;
		}
		this.#inFlightToolNames.clear();
		// Same reason as the markers below: this exit reaches JavaScript, so the
		// log accounts for it and the heartbeat must not report it as silent.
		this.#heartbeat?.leave();
		// This exit reached JavaScript, so the log will carry an account of it
		// either way. Leaving the marker behind would report the next launch a
		// crash that did not happen.
		for (const [toolCallId, sessionId] of this.#toolMarkerSessions) {
			clearToolCallInFlight(sessionId, toolCallId);
		}
		this.#toolMarkerSessions.clear();
		const pendingToolCalls = collectPendingToolCalls(this.sessionManager.getBranch());
		if (
			pendingToolCalls.length === 0 &&
			!this.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			return;
		}
		const kind: SessionExitData["kind"] =
			reason === "dispose" || reason === postmortem.Reason.MANUAL
				? "normal"
				: reason === postmortem.Reason.UNCAUGHT_EXCEPTION || reason === postmortem.Reason.UNHANDLED_REJECTION
					? "fatal"
					: reason === postmortem.Reason.EXIT
						? "process_exit"
						: "signal";
		const data: SessionExitData = {
			reason,
			kind,
			recordedAt: new Date().toISOString(),
		};
		if (pendingToolCalls.length > 0) data.pendingToolCalls = pendingToolCalls;
		try {
			this.sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, data);
			this.sessionManager.flushSync();
			// Looked up on `logger` at call time, not captured in a table: the level is the
			// method name, and a captured function would also detach the spy a test installs.
			logger[sessionExitLogLevel(kind, pendingToolCalls.length)]("Session exit recorded", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				kind,
				pendingToolCalls: pendingToolCalls.length,
			});
		} catch (error) {
			logger.error("Failed to record session exit", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Emit a session event without waiting for it, when the caller genuinely cannot wait.
	 *
	 * The TTSR paths use this: the abort has to happen immediately and must not be gated on extension
	 * callbacks. But the failure still matters. `#emitSessionEvent` runs the extension handlers AND the
	 * wire-level `#emit` to subscribers, so an extension that throws stops the event reaching subscribers
	 * altogether -- the TTSR notification silently stops working, with the rule still applied and nothing
	 * saying why the client never heard about it. So the emit is detached, and the failure is reported.
	 */
	#emitSessionEventDetached(event: AgentSessionEvent, context: string): void {
		void this.#emitSessionEvent(event).catch((error: unknown) => {
			logger.warn("session event emit failed", { context, event: event.type, error: errorMessage(error) });
		});
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#extensionEvents.enqueue(event);
			return;
		}
		await this.#extensionEvents.forward(event);
		// Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
		// (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
		// emitting while a prompt is in flight lets a client fire its next
		// `prompt` into a session that still reports isStreaming === true. Flush
		// happens in #endInFlight. A later agent_end (e.g. from
		// an auto-compaction turn that starts before the original prompt unwinds)
		// supersedes the pending one, which is what subscribers want — they only
		// care about the final settle.
		if (event.type === "agent_end" && this.#inFlight.active) {
			this.#pendingAgentEndEmit = event;
			return;
		}
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect.
	 *
	 * `agent_end` handling schedules post-prompt recovery work such as context
	 * promotion continuations. It is invoked fire-and-forget by the agent's
	 * synchronous `#emit`, and only reaches the context check after several
	 * internal awaits. `prompt()` runs `#waitForPostPromptRecovery()` the instant
	 * `agent.prompt()` resolves, which can land before the handler registers its
	 * tasks. Tracking the `agent_end` handler as a post-prompt task synchronously
	 * closes that window, so the recovery wait always sees the in-flight handler
	 * and blocks until it and everything it schedules settles.
	 */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type !== "agent_end") {
			const processing = this.#processAgentEvent(event);
			if ((event.type === "message_start" || event.type === "message_end") && isAdvisorCard(event.message)) {
				this.#pendingAdvisorCardEvents.add(processing);
				void processing
					.finally(() => this.#pendingAdvisorCardEvents.delete(processing))
					.catch(error => {
						logger.debug("Advisor card event processing failed", { error });
					});
			}
			return processing;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPrompt.track(promise);
		try {
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	/**
	 * Assistant message content in display form: secrets deobfuscated and argot
	 * handles expanded, composed in that order. Stored messages keep the
	 * obfuscated placeholders and cheap handles (the token win and the persistence
	 * contract); any surface that shows content to a person — the streamed
	 * `message_end` display event, and headless `--print`, which reads the stored
	 * message directly — must route it through here first so operators never see a
	 * raw `#HASH#` secret token or a bare `§handle`. Returns the same content
	 * reference when neither transform applies.
	 */
	displayAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		// DISPLAY PATH: the streamed `message_end` display event, the interactive
		// event fan-out, and `--print`. Degrades per string; never throws.
		const expand = this.#secrets.displayExpander();
		let out =
			expand === undefined ? content : mapAssistantContentStrings(content, expand, { includeToolMetadata: true });
		if (this.#config.argot?.loaded) {
			out = expandAssistantContent(this.#config.argot, out);
		}
		return out;
	}

	/**
	 * A tool call's intent in display form, through the same two transforms as its
	 * content.
	 *
	 * The intent is a sentence the MODEL wrote about what it is doing, and the
	 * interactive working line puts it on screen the moment the call starts. That
	 * makes it a display surface with the same obligation as any other: a person
	 * reads "Reading src/db.ts to check the schema", never "Reading §db …".
	 *
	 * It needs its own pass because it does not travel with the arguments. The
	 * intent is lifted out of the arguments before the argument transform runs, so
	 * the expansion applied to every argument reaches everything except this one
	 * field, and the `tool_execution_start` event carries it verbatim.
	 */
	displayToolIntent(intent: string | undefined): string | undefined {
		if (intent === undefined || intent === "") return intent;
		// DISPLAY PATH: the working line puts this on screen the moment a tool call
		// starts, so it degrades to the literal placeholder and never throws.
		let out = this.#secrets.expandForDisplay(intent);
		if (this.#config.argot?.loaded) {
			out = this.#config.argot.expand(out);
		}
		return out;
	}

	/**
	 * Every agent event, one route per type. The state a later event reads (the settle's last
	 * assistant message, the mid-run todo counter, the streaming-edit reset) is applied before the
	 * first await: agent-core dispatches these handlers fire-and-forget, so `agent_end` can run
	 * before its `message_end` handler resumes.
	 */
	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "agent_start") this.#activeAgentPromptGeneration = this.#promptGeneration;
		// Paired with the mark in `#recordToolExecutionStart`, and cleared before the
		// awaited subscribers below: a listener that throws would otherwise leave this
		// process looking like it died inside a call that had already returned.
		if (event.type === "tool_execution_end") {
			this.#inFlightToolNames.delete(event.toolCallId);
			const markerSessionId = this.#toolMarkerSessions.get(event.toolCallId);
			if (markerSessionId !== undefined) {
				clearToolCallInFlight(markerSessionId, event.toolCallId);
				this.#toolMarkerSessions.delete(event.toolCallId);
			}
		}
		// Every lifecycle event can move the phase: a tool starting or returning, a
		// run starting or settling. Stream deltas cannot, and are the hot path. A tool
		// start refreshes it itself, once its in-flight marker is recorded.
		if (event.type !== "message_update" && event.type !== "tool_execution_start") this.#heartbeat?.update();
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					// Start a fresh per-message argot stream decoder (seam 3): the live
					// preview re-renders the accumulated partial, and a handle can split
					// across deltas, so text/thinking blocks render only decoder-proved text.
					this.#argotStreamDisplay = new ArgotStreamDisplayDecoder(this.#config.argot);
				}
				await this.#emitSessionEvent(expandAssistantEvent(this, event));
				return;
			case "message_update":
				await this.#emitSessionEvent(this.#decodeStreamUpdate(event));
				// A TTSR rule matching a stream delta may abort the turn to inject its body;
				// the retry it scheduled carries the rest.
				await this.#ttsr.observeStreamDelta(event.message, event.assistantMessageEvent);
				return;
			case "message_end":
				await this.#processMessageEnd(event);
				return;
			case "turn_start":
				// The streaming-edit guard's checks run in the stream interceptor, ahead of this
				// handler, so a reset parked behind an await could clear a verdict the new turn has
				// already reached.
				this.#streamingEdit.resetForTurn();
				this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`);
				await this.#emitSessionEvent(event);
				this.#ttsr.onTurnStart();
				return;
			case "turn_end":
				await this.#emitSessionEvent(expandAssistantEvent(this, event));
				this.#ttsr.onTurnEnd();
				this.#settleInFlightToolChoice(event.message);
				return;
			case "tool_execution_start": {
				this.#finalize.evidence.recordToolStart(event);
				// The intent rides on the execution events rather than in the message
				// content, so the content-level expansion never reaches it. Without
				// this the working line announces a call in raw handle form while the
				// transcript right beneath it shows the same call expanded.
				const intent = this.displayToolIntent(event.intent);
				recordToolExecutionStart(this, event);
				const markerSessionId = this.sessionManager.getSessionId();
				this.#toolMarkerSessions.set(event.toolCallId, markerSessionId);
				this.#inFlightToolNames.set(event.toolCallId, event.toolName);
				markToolCallInFlight({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					sessionId: markerSessionId,
				});
				this.#heartbeat?.update();
				await this.#emitSessionEvent(intent === event.intent ? event : { ...event, intent });
				return;
			}
			case "tool_execution_end":
				this.#finalize.evidence.recordToolEnd(event);
				await this.#emitSessionEvent(event);
				await this.#onToolExecutionEnd(event);
				return;
			case "agent_end": {
				await this.#emitSessionEvent(expandAgentEndEvent(this, event));
				const settledMessages = this.agent.state.messages;
				await this.#goalRuntime.onAgentEnd();
				await this.#runAgentEndMaintenance(settledMessages);
				await this.#extensionEvents.agentEnd(settledMessages);
				return;
			}
			default:
				await this.#emitSessionEvent(event);
		}
	};

	/**
	 * The display copy of a streamed assistant delta. The whole stream event is decoded, not only the
	 * accumulated content: a machine consumer that reconstructs text from the delta stream alone
	 * (print `--mode json`) must never see a raw §handle, and neither must one reading the event's
	 * own `partial`, `content` or `toolCall` payload. The decoded increments sum to the same decoded
	 * content `decodeContent` exposes, so every view agrees and reconciles with the wholesale-expanded
	 * `message_end` message.
	 */
	#decodeStreamUpdate(
		event: Extract<AgentEvent, { type: "message_update" }>,
	): Extract<AgentEvent, { type: "message_update" }> {
		const decoder = this.#argotStreamDisplay;
		if (decoder === undefined || event.message.role !== "assistant") return event;
		const streamEvent = event.assistantMessageEvent;
		const assistantMessageEvent = decoder.decodeStreamEvent(streamEvent);
		const streamedContent = decoder.decodeContent(event.message.content);
		const contentChanged = streamedContent !== event.message.content;
		if (!contentChanged && assistantMessageEvent === streamEvent) return event;
		return {
			...event,
			message: contentChanged ? { ...event.message, content: streamedContent } : event.message,
			assistantMessageEvent,
		};
	}

	/**
	 * A finished message: the state later events read is applied, the display copy is emitted, and
	 * the message is persisted before its settle-time effects run.
	 */
	async #processMessageEnd(event: Extract<AgentEvent, { type: "message_end" }>): Promise<void> {
		const { message } = event;
		let interruptedThinkingMessage: CustomMessage<InterruptedThinkingDetails> | undefined;
		if (message.role === "toolResult") {
			// Step the mid-run todo counter before any await: the agent loop's next-turn
			// `getAsideMessages` poll can run before queued microtasks drain, so
			// `TodoRuntime.takeMidRunNudge` MUST see the freshest counter (issue #3651). Keyed on
			// toolResult (not the assistant toolCall turn) so planned-but-aborted or
			// permission-denied calls never count, and only successful mutating tools tick.
			this.#todo.onToolResultLanded(message.toolName, message.isError);
		} else if (message.role === "assistant") {
			// Recorded before any await: `agent_end` is dispatched immediately after its
			// `message_end`, so an assignment parked behind the persistence await lets the settle
			// read the PREVIOUS assistant message, and a tool-use turn followed by a text-only stop
			// settles as if it still carried tool calls.
			this.#lastAssistantMessage = message;
			if (message.stopReason === "aborted") this.#stampAbortedAssistant(message);
			if (this.#abortInProgress) this.#deliberateAborts.add(message);
			interruptedThinkingMessage = demoteInterruptedThinkingOnUserInterrupt(message);
			// Make the hidden continuity turn visible to the next prompt before any awaited
			// extension delivery or persistence can stall this handler.
			if (interruptedThinkingMessage) this.agent.appendMessage(interruptedThinkingMessage);
		}
		const persistence = this.#persistence.openSlot(message);
		// The finished message expands wholesale; drop the stream state.
		this.#argotStreamDisplay?.flush();
		this.#argotStreamDisplay = undefined;
		let displayEvent = event;
		if (message.role === "assistant") {
			applyProviderReportedContextWindow(this.agent, this.modelRegistry, message);
			displayEvent = expandAssistantEvent(this, event);
		} else if (message.role === "toolResult") {
			this.#applyToolResultState(message);
		}
		try {
			await this.#emitSessionEvent(displayEvent);
		} catch (error) {
			persistence?.release();
			throw error;
		}
		await this.#persistence.persistMessageEnd(message, persistence, interruptedThinkingMessage);
		if (message.role === "assistant") {
			await this.#onAssistantMessageEnd(message);
		} else if (message.role === "toolResult") {
			await this.#onToolResultMessageEnd(message);
		}
	}

	/**
	 * Plan-mode internal transition: stamp `SILENT_ABORT_MARKER` on the persisted message before the
	 * display copy is made, so the copy (a spread) and the persisted message (mutated in place) both
	 * carry the marker and streaming render and history replay branch identically. The one-shot flag
	 * is consumed here, scoped to this aborted `message_end`; callers still clear it in `finally` so a
	 * leaked flag cannot silence a later unrelated abort.
	 */
	#stampAbortedAssistant(message: AssistantMessage): void {
		if (this.#planInternalAbortPending) {
			message.errorMessage = SILENT_ABORT_MARKER;
			message.errorId = AIError.create(AIError.Flag.SilentAbort);
			this.#planInternalAbortPending = false;
		} else if (this.#pendingAbortErrorId) {
			message.errorId = this.#pendingAbortErrorId;
			this.#pendingAbortErrorId = undefined;
		}
	}

	/**
	 * Apply state-bearing tool results before the first awaited subscriber. Agent events are
	 * delivered independently, so a later `agent_end` may otherwise evaluate stale todo state while a
	 * slow `message_end` extension is still running.
	 */
	#applyToolResultState(message: AgentMessage): void {
		const { toolName, toolCallId, details, isError } = message as {
			toolCallId?: string;
			toolName?: string;
			details?: { op?: string; path?: string; phases?: TodoPhase[] };
			isError?: boolean;
		};
		this.#todo.noteToolProgress();
		if (toolName === TOOL.edit && details?.path) {
			this.#streamingEdit.invalidate(details.path);
		}
		if (toolName === TOOL.todo && !isError && Array.isArray(details?.phases)) {
			this.setTodoPhases(details.phases);
			if (this.#todo.isInitResult(details, toolCallId)) {
				this.#replanTitle.schedule();
			}
		}
	}

	/** Settle-time effects of a persisted assistant message. */
	async #onAssistantMessageEnd(message: AssistantMessage): Promise<void> {
		// Fold this turn's timing into per-model perf aggregates (drives the /models TPS/TTFT
		// display). Errored turns measure nothing; aborted turns with reported usage are still valid
		// throughput samples.
		if (message.stopReason !== "error" && message.duration !== undefined) {
			AgentStorage.forAgentDir(this.settings.getAgentDir())?.recordModelPerf(
				`${message.provider}/${message.model}`,
				{
					outputTokens: message.usage.output,
					durationMs: message.duration,
					ttftMs: message.ttft,
				},
			);
		}
		if (message.disabledFeatures?.includes("priority") && this.#serviceTierByFamily.anthropic === "priority") {
			this.setServiceTierFamily("anthropic", undefined);
			this.emitNotice(
				"warning",
				`${PRIORITY_TIER_COMMAND_LABEL} rejected for this model; retried without it. It is now off.`,
				"priority",
			);
		}
		this.#ttsr.onAssistantSettled(message);
		this.#sessionHandoff.noteAssistantSettled(message);
		await this.#retry.closeRecovered(message);
	}

	/** Settle-time effects of a persisted tool result: todo write outcome and checkpoint/rewind state. */
	async #onToolResultMessageEnd(message: AgentMessage): Promise<void> {
		const { toolName, details, isError, content } = message as {
			toolName?: string;
			details?: {
				op?: string;
				path?: string;
				phases?: TodoPhase[];
				report?: string;
				startedAt?: string;
				__synthetic?: true;
				__skipped?: true;
			};
			isError?: boolean;
			content?: Array<TextContent | ImageContent>;
		};
		// A call the batch never dispatched, and a call an interrupt cut short, both arrive here
		// carrying isError. Neither is a verdict on the payload: the board is stale because the write
		// never landed, not because it was refused, and two interrupts in a row would read as one
		// failure repeating and retire todo for the rest of the turn. Leave the failure memory
		// untouched rather than clearing it: a skip is not a landed write either.
		const todoCallDidNotFail = details?.__synthetic === true || details?.__skipped === true;
		if (toolName === TOOL.todo && !todoCallDidNotFail) {
			const errorText = isError ? (content?.find(part => part.type === "text")?.text ?? "") : undefined;
			const reminderText = this.#todo.recordWriteOutcome(errorText);
			if (reminderText !== undefined) {
				await this.sendCustomMessage(
					{
						customType: "todo-error-reminder",
						content: reminderText,
						display: false,
						details: { toolName, errorText },
					},
					{ deliverAs: "nextTurn" },
				);
			}
		}
		if (toolName === TOOL.checkpoint && !isError) {
			this.#checkpoint.begin({
				checkpointMessageCount: this.agent.state.messages.length,
				checkpointEntryId: this.sessionManager.getEntries().at(-1)?.id ?? null,
				startedAt: details?.startedAt ?? new Date().toISOString(),
			});
		}
		if (toolName === TOOL.rewind && !isError) {
			this.#checkpoint.recordRewindResult(details, content);
		}
	}

	/**
	 * Finalize the tool-choice queue's in-flight yield after tools have executed. This runs at
	 * `turn_end`, not `message_end`, because onInvoked handlers run during tool execution, which
	 * happens between the two.
	 */
	#settleInFlightToolChoice(message: AgentMessage): void {
		if (!this.#toolChoiceQueue.hasInFlight) return;
		const { stopReason } = message as AssistantMessage;
		if (stopReason === "aborted" || stopReason === "error") {
			this.#toolChoiceQueue.reject(stopReason);
		} else {
			this.#toolChoiceQueue.resolve();
		}
	}

	async #onToolExecutionEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (event.toolName === TOOL.goal) {
			await this.#goalRuntime.onGoalToolCompleted();
		} else {
			await this.#goalRuntime.onToolCompleted(event.toolName);
		}
		this.#planMode.noteToolCompleted(event.toolName);
		if (this.#yields.noteExecutionEnd(event)) this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
	}

	#logMaintenanceRoute(
		msg: AssistantMessage,
		successfulYield: boolean,
		route: string,
		extra?: Record<string, unknown>,
	): void {
		logger.debug("agent_end maintenance routing", {
			route,
			stopReason: msg.stopReason,
			provider: msg.provider,
			model: msg.model,
			contentBlocks: msg.content.length,
			hasToolCalls: msg.content.some(content => content.type === "toolCall"),
			hasText: msg.content.some(content => content.type === "text"),
			goalModeEnabled: this.#goalModeState?.enabled === true,
			goalStatus: this.#goalModeState?.goal.status,
			successfulYield,
			...extra,
		});
	}

	/** Run the compaction check as a tracked post-prompt task, so the recovery wait sees it. */
	#trackedCompactionCheck(msg: AssistantMessage): Promise<CompactionCheckResult> {
		const task = this.#contextCheck.check(msg);
		this.#postPrompt.track(task);
		return task;
	}

	/** Drop GitHub Copilot credentials on an auth failure so the next request does not reuse a stale token. */
	async #invalidateCopilotOnAuthFailure(msg: AssistantMessage): Promise<void> {
		if (
			msg.stopReason === "error" &&
			msg.provider === "github-copilot" &&
			AIError.is(AIError.classifyMessage(msg), AIError.Flag.AuthFailed)
		) {
			await this.#config.modelRegistry.authStorage.remove("github-copilot");
		}
	}

	/**
	 * Post-run maintenance: retry, compaction and the stop-time continuation passes. The caller emits
	 * the `agent_end` notification after it on every route.
	 */
	async #runAgentEndMaintenance(settledMessages: AgentMessage[]): Promise<void> {
		const msg =
			this.#lastAssistantMessage ??
			settledMessages.findLast((message): message is AssistantMessage => message.role === "assistant");
		this.#lastAssistantMessage = undefined;
		if (!msg) {
			this.#yields.clear();
			logger.debug("agent_end maintenance routing", {
				reason: "no-assistant-message",
				goalModeEnabled: this.#goalModeState?.enabled === true,
				goalStatus: this.#goalModeState?.goal.status,
			});
			return;
		}
		// The identity of the settling message is read above, before its persistence slot drains; the
		// passes below append to the branch, so wait for the entry to exist or a continuation reminder
		// lands ahead of the reply it answers. Resolved already whenever the slot drained first.
		await this.#persistence.waitFor(msg);

		const successfulYieldMessage = this.#yields.findYieldMessage(settledMessages);
		const yieldOnThisMessage = this.#yields.endedWithYield(msg);
		const route = (name: string, extra?: Record<string, unknown>) =>
			this.#logMaintenanceRoute(msg, successfulYieldMessage !== undefined, name, extra);
		route("entered");

		// Surface provider stream failures in the main log. The routing trace
		// above is debug-only and drops the error fields, so a session dying
		// repeatedly on provider errors otherwise leaves no actionable trace
		// outside the session transcript (issue #6177).
		logProviderTurnError(msg);

		await this.#invalidateCopilotOnAuthFailure(msg);

		if (this.#sessionHandoff.takeMaintenanceSkip(msg.timestamp)) {
			this.#yields.clear();
			route("skip-post-turn-maintenance");
			return;
		}

		const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
		// A successful `yield` in this run is terminal for execution purposes. Suppress empty-stop
		// retry, unexpected-stop retry, queued-message drain, and compaction-driven continuations for
		// the rest of this prompt cycle: the executor consumed the yield as the terminal result, so a
		// trailing empty/aborted assistant stop must NOT revive the agent loop. The
		// pending termination clears on the next `prompt()`.
		if (successfulYieldMessage || this.#yields.terminationPending) {
			this.#yields.clear();
			if (!successfulYieldMessage) {
				route("post-yield-trailing-stop-suppressed");
			} else if (!activeGoal) {
				route("successful-yield-no-active-goal");
			} else {
				route(
					yieldOnThisMessage
						? "successful-yield-active-goal-checkCompaction"
						: "post-yield-trailing-stop-active-goal-checkCompaction",
				);
				await this.#trackedCompactionCheck(successfulYieldMessage);
			}
			return;
		}
		this.#yields.clear();
		await this.#settleStop(msg, settledMessages, activeGoal, route);
	}

	/** Route a stop that no `yield` ended: empty-stop and failure recovery, compaction, then `session_stop`. */
	async #settleStop(
		msg: AssistantMessage,
		settledMessages: AgentMessage[],
		activeGoal: boolean,
		route: (name: string, extra?: Record<string, unknown>) => void,
	): Promise<void> {
		// One reading of "this reply is waiting on the user", shared by every route below and read
		// before the first guard runs, so the retry guards that settle earliest see the same answer as
		// the passes that settle last.
		const settleState: SettleContinuationState = { awaitingUserAnswer: isAwaitingUserAnswer(msg) };
		// Empty-stop cleanup MUST run before any compaction continuation: an empty toolUse stop must
		// be stripped from active context + session history before another turn is scheduled,
		// otherwise the next Anthropic turn carries a tool_use block with no matching tool_result and
		// corrupts message history. The handler also schedules its own retry, so a real empty stop
		// never needs the active-goal threshold pre-empt below.
		if (await this.#stopRetries.onEmptyStop(msg)) {
			route("empty-stop-handled");
			return;
		}

		let compactionResult: CompactionCheckResult | undefined;
		if (activeGoal) {
			route("active-goal-pre-empt-checkCompaction");
			compactionResult = await this.#trackedCompactionCheck(msg);
			if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) {
				route("active-goal-pre-empt-compaction-handled", {
					continuationScheduled: compactionResult.continuationScheduled,
					automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
				});
				this.#retry.resolve();
				return;
			}
		}

		if (await this.#stopRetries.onUnexpectedStop(msg, settleState)) {
			route("unexpected-stop-handled");
			return;
		}
		if (await this.#retry.recoverFailedTurn(msg)) return;
		// Classifier refusals are persisted-skipped above; also prune the trailing stub from active
		// context so the next turn's prompt does not replay it. Fall through to the standard error
		// tail so `session_stop` hooks (block, continue, telemetry) still fire.
		if (isClassifierRefusal(msg)) {
			removeAssistantMessageFromActiveContext(this.agent, msg);
		} else {
			// No retry, fallback, or compaction continuation fired: this errored
			// turn ends the run. #persistSessionMessageIfMissing dropped it as an
			// empty error turn, so record it here — otherwise the JSONL stops at
			// the last tool result and the provider's errorMessage is lost (#6249).
			// Idempotent and a no-op for non-empty turns.
			await this.#persistTerminalEmptyErrorTurn(msg);
		}
		this.#retry.resolve();

		if (!compactionResult) {
			route("bottom-checkCompaction");
			compactionResult = await this.#trackedCompactionCheck(msg);
		}
		if (await this.#continueAtSettle(msg, settleState, compactionResult)) return;
		await this.#emitSessionStopEvent(settledMessages, msg);
	}

	/**
	 * The stop-time passes that may continue a settled turn instead of ending it. True when one
	 * scheduled a continuation, or the turn is not a final stop, so `session_stop` must not fire.
	 */
	async #continueAtSettle(
		msg: AssistantMessage,
		settleState: SettleContinuationState,
		compactionResult: CompactionCheckResult,
	): Promise<boolean> {
		// Stop-time todo reconciliation only fires at a text-only final stop. A run that ends still
		// mid-tool-use (deadline hit, context full, etc.) skips the reminder so a follow-up does not
		// pile onto an already in-flight turn. Mid-run sync is TodoRuntime.takeMidRunNudge (#3651).
		if (msg.content.some(content => content.type === "toolCall")) return true;
		// When compaction queued recovery or hit a deliberate dead-end, skip the rewind/todo/
		// session_stop passes: a reminder or hook continuation appended here would race the retry,
		// auto-continue prompt, queued-message drain, or the pause preventing a compaction loop.
		if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) return true;
		const stopped = msg.stopReason !== "error";
		if (stopped && mayContinueAtSettle("rewind-checkpoint", settleState) && this.#finalize.rewindBeforeYield()) {
			return true;
		}
		if (
			stopped &&
			mayContinueAtSettle("plan-mode-decision", settleState) &&
			(await this.#planMode.enforceDecisionAtSettle())
		) {
			return true;
		}
		// Called unconditionally at a stop: its first statement consumes the served tool-choice label,
		// and skipping that leaks a `user-force` label onto the next turn. The hold is a parameter.
		if (stopped && (await this.#todo.checkCompletionAtSettle(settleState))) return true;
		// A pending async wake means this settle is a scheduling pause, not the terminal stop: the
		// async-result delivery continues the loop and the real stop settles later, so the
		// session_stop hook pass waits until the session is fully idle.
		if (this.#hasPendingAsyncWake()) return true;
		// Gated BEFORE the enforcer runs: it drains the ledger's one reminder as it reads it, so
		// deferring from inside would spend the reminder it meant to keep.
		if (mayContinueAtSettle("verification-evidence", settleState) && this.#finalize.verificationBeforeFinalize()) {
			return true;
		}
		if (mayContinueAtSettle("code-review", settleState) && this.#finalize.codeReviewBeforeFinalize()) return true;
		return false;
	}

	async #maybeHandoffExpensiveAgent(activeMessages?: AgentMessage[]): Promise<boolean> {
		const agentId = this.#config.agentId;
		const threshold = this.settings.get("compaction.laneHandoffThresholdTokens");
		const model = this.model;
		if (
			!this.#isSpawned ||
			!agentId ||
			AgentRegistry.global().get(agentId)?.kind !== "sub" ||
			this.#lastLaneHandoffSessionId === this.sessionId ||
			threshold <= 0 ||
			!model ||
			!/(?:^|[-/:])(?:sol|opus|sonnet|astra)(?:$|[-/:])/i.test(model.id)
		) {
			return false;
		}
		const contextTokens = this.getContextBreakdown()?.usedTokens ?? 0;
		if (contextTokens < threshold) return false;
		const summaryModel = compactionModelCandidates(this.settings, model, this.modelRegistry.getAvailable()).find(
			candidate =>
				candidate.contextWindow !== null &&
				candidate.maxTokens !== null &&
				candidate.contextWindow >= contextTokens + 8_000 + candidate.maxTokens &&
				this.modelRegistry.hasConfiguredAuth(candidate),
		);
		if (!summaryModel) return false;
		this.#lastLaneHandoffSessionId = this.sessionId;
		try {
			const result = await this.handoff(
				"Write a compact 3,000-token maximum successor brief. Include the assignment goal, current state, open steps, worktree, branch, source-observed HEAD, last test command and pass/fail counts, and important file paths. Do not invent repository metadata or test counts; say unknown when absent. Do not reproduce the source transcript.",
				{ autoTriggered: true, compactSummary: true, preserveAgentLineage: true, summaryModel },
			);
			if (!result) return false;
			if (activeMessages) activeMessages.splice(0, activeMessages.length, ...this.agent.state.messages);
			return true;
		} catch (error) {
			logger.warn("Automatic expensive-agent handoff failed; retaining the current transcript", {
				agentId,
				error: errorMessage(error),
			});
			return false;
		}
	}

	#scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void {
		this.#postPrompt.schedule(
			async signal => {
				// Defense in depth: do not start a fresh streaming turn while any
				// context maintenance or explicit handoff is already active.
				if (signal.aborted || this.#isDisposed || this.isCompacting || this.isGeneratingHandoff) {
					skipAgentContinue("session-unavailable", options);
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					skipAgentContinue("should-continue-false", options);
					return;
				}
				this.#inFlight.begin();
				try {
					await this.#retry.maybeRestoreFallbackPrimary();
					if (signal.aborted || this.#isDisposed) {
						skipAgentContinue("post-restore-unavailable", options);
						return;
					}
					// Another start (a queued-message drain, a second continuation scheduled at the same
					// settle) can begin a run during the restore above. That run reads the state this
					// continuation was scheduled for and polls the same queues, so yield to it rather than
					// call continue() on a busy agent.
					if (this.agent.state.isStreaming) {
						skipAgentContinue("agent-busy", options);
						return;
					}
					await this.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: errorMessage(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					options?.onError?.(error);
				} finally {
					this.#endInFlight();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: reason => skipAgentContinue(reason, options),
			},
		);
	}

	#scheduleAutoContinuePrompt(generation: number): void {
		const continuePrompt = async () => {
			// Compaction summarizes away the first-message eager preludes, so re-assert the
			// delegate-via-tasks / phased-todo reminders on this auto-resumed turn. This runs
			// at invocation (past the abort check below), so an aborted continuation queues
			// nothing; scoped to this request via prependMessages, never the shared queue.
			const eagerNudges = this.#buildPostCompactionEagerNudges();
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: turnControlPrompts["turn-control/auto-continue"].text }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				turnControlPrompts["turn-control/auto-continue"].text,
				{
					skipPostPromptRecoveryWait: true,
					prependMessages: eagerNudges.length > 0 ? eagerNudges : undefined,
				},
			);
		};
		this.#postPrompt.schedule(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				await continuePrompt();
			},
			{ generation },
		);
	}

	/** Skip scheduled post-prompt work, release the TTSR resume gate, and wait for started work. */
	#cancelPostPromptTasks(): Promise<void> {
		const drain = this.#postPrompt.cancel();
		this.#ttsr.resolveResume();
		return drain;
	}
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			// An abort bumps #promptGeneration. When this wait runs on behalf of a
			// specific prompt turn, stop as soon as that turn has been superseded:
			// its promise must resolve on the abort, not block on a queued
			// steer/follow-up that the post-abort drain starts as a fresh turn.
			if (generation !== undefined && this.#promptGeneration !== generation) return;
			const retryGate = this.#retry.gate;
			if (retryGate) {
				await retryGate;
				continue;
			}
			const ttsrResume = this.#ttsr.resumePromise;
			if (ttsrResume) {
				await ttsrResume;
				continue;
			}
			const postPromptDrained = this.#postPrompt.drained;
			if (postPromptDrained) {
				await postPromptDrained;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#afterToolCall(
		ctx: AfterToolCallContext,
	): Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined {
		if (
			this.#yields.noteAfterToolCall(ctx.toolCall.id, {
				toolName: ctx.toolCall.name,
				isError: ctx.isError,
				result: ctx.result,
			})
		) {
			this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		}
		return this.#ttsr.afterToolCall(ctx);
	}

	/**
	 * How many assistant turns this session has produced.
	 *
	 * The count of assistant messages is the turn index: each one is a request
	 * that re-read the whole context. Used to price how long a tool result
	 * arriving now will be re-read for. See `inlineCapForTurn`.
	 */
	getTurnIndex(): number {
		let turns = 0;
		for (const message of this.agent.state.messages) {
			if (message.role === "assistant") turns++;
		}
		return turns;
	}

	async #emitSessionStopEvent(
		messages: AgentMessage[],
		lastAssistantMessage = this.getLastAssistantMessage(),
	): Promise<void> {
		if (this.#abortInProgress || this.#isDisposed || this.#activeAgentPromptGeneration !== this.#promptGeneration) {
			this.#sessionStopContinuationCount = 0;
			return;
		}
		if (this.#config.agentKind === "sub" || !this.#config.extensionRunner?.hasHandlers("session_stop")) return;
		const generation = this.#promptGeneration;
		const result = await this.#config.extensionRunner.emitSessionStop({
			messages,
			turn_id: Math.max(0, this.#extensionEvents.turnIndex - 1),
			last_assistant_message: lastAssistantMessage,
			session_id: this.sessionId,
			session_file: this.sessionFile,
			stop_hook_active: this.#sessionStopContinuationCount > 0,
		});
		if (this.#promptGeneration !== generation || this.#abortInProgress || this.#isDisposed) {
			this.#sessionStopContinuationCount = 0;
			return;
		}
		const additionalContext = sessionStopContinuationContext(result);
		if (!additionalContext) {
			this.#sessionStopContinuationCount = 0;
			return;
		}
		if (result?.decision !== "block" && this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: this.sessionId,
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#sessionStopContinuationCount = 0;
			return;
		}
		if (result?.decision !== "block") this.#sessionStopContinuationCount++;
		this.#queueHiddenNextTurnMessage(
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: additionalContext,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			true,
		);
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */

	/**
	 * Re-read everything that depends on the session's working directory: settings, process-global
	 * provider and capability state, secrets, the SSH tool and the base system prompt, in that order.
	 * Every mode reaches this, not only the TUI's `cwd_changed` handler. A spawned agent re-roots
	 * itself and leaves the process-global state of its parent and siblings where it is. Repeating
	 * the last directory re-scoped is a no-op. See {@link SessionScope.rescope}.
	 */
	rescopeToCwd(cwd: string): Promise<void> {
		return this.#scope.run(() => this.#scope.rescope(cwd));
	}

	/** Re-read rule files and skills through the same discovery path as a working-directory move. */
	reloadRules(): Promise<string[]> {
		return this.#scope.run(async () => {
			if (!this.#config.reloadProjectInputs) {
				return ["Rule discovery is not configured for this session."];
			}
			const lines = await this.#config.reloadProjectInputs();
			await this.refreshBaseSystemPrompt("rules-reload");
			return lines;
		});
	}

	/**
	 * Re-root the live session working directory for this session only.
	 * Updates SessionManager cwd + header, aligns process project dir, re-scopes
	 * settings/capabilities/plugins/prompt via {@link AgentSession.rescopeToCwd},
	 * emits `cwd_changed`, and injects a visible/context system note. Never writes
	 * profile `session.workdir` or other persisted settings.
	 */
	setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		return this.#scope.setCwd(newCwd, options);
	}

	/**
	 * Atomically relocate session storage/artifacts and the complete cwd-derived
	 * runtime. A failed re-scope moves storage back before exposing the error.
	 */
	moveToCwd(newCwd: string, targetSessionDir?: string): Promise<string> {
		return this.#scope.moveTo(newCwd, targetSessionDir);
	}

	/** Cumulative outbound bytes elided by wire path relativization (TW-10). */
	get wirePathBytesSaved(): number {
		return this.#wire.pathBytesSaved;
	}

	/**
	 * Cumulative outbound characters elided by the Gemini thought-signature
	 * retention window, across every request this session has made.
	 *
	 * Zero when the window is Keep All, which is the default. A large number here
	 * is the setting working: signatures are re-sent on every turn, so what a
	 * single trimmed turn saves is paid again on the next one and the next.
	 */
	get thoughtSignatureBytesSaved(): number {
		return this.#wire.thoughtSignatureBytesSaved;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#commandMetadataChangedListeners.push(listener);
		return () => {
			const index = this.#commandMetadataChangedListeners.indexOf(listener);
			if (index !== -1) {
				this.#commandMetadataChangedListeners.splice(index, 1);
			}
		};
	}

	#notifyCommandMetadataChanged(): void {
		const listeners = this.#commandMetadataChangedListeners.slice();
		for (const listener of listeners) {
			// `CommandMetadataChangedListener` is `() => void | Promise<void>`, so
			// the published contract INVITES an async listener, but a `catch`
			// only ever observes a SYNCHRONOUS throw. The old `void listener()`
			// discarded the promise, so a rejecting async subscriber walked past
			// the handler three lines below and reached postmortem's global
			// `unhandledRejection` hook, which prints a crash report and calls
			// `process.exit(1)`. `setMCPPromptCommands` runs on every MCP prompt
			// (re)load, reconnects included, so one bad subscriber killed a
			// working session at a moment the user did not act. Both arms now
			// land in the SAME sink with the SAME message: to an operator a
			// rejection and a throw are one greppable failure.
			try {
				// `unknown` so `instanceof` narrows cleanly off the `void` arm.
				// Only a listener that actually returned a promise allocates.
				const result: unknown = listener();
				if (result instanceof Promise) {
					result.catch((err: unknown) => {
						logger.error("Command metadata listener threw", { err });
					});
				}
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}

	/** Detach from agent events for good. Dispose is the only caller; a transition uses {@link #whileDisconnectedFromAgent}. */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Runs `run` with agent events detached and reattaches them when it settles, resolved or
	 * rejected. The handler is the only path that persists a turn and forwards its events to
	 * listeners, so a transition that fails part-way must not leave every later turn unwritten and
	 * unseen. Listeners are preserved throughout.
	 */
	async #whileDisconnectedFromAgent<T>(run: () => Promise<T>): Promise<T> {
		this.#disconnectFromAgent();
		try {
			return await run();
		} finally {
			if (!this.#unsubscribeAgent) {
				this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
			}
		}
	}

	/** Every provider cache-key discard this session paid for, in order, by reason. */
	providerCacheKeyDiscards(): readonly string[] {
		return this.#providerSessions.cacheKeyDiscards();
	}

	/**
	 * Forget what the previous conversation was told, on every path that starts a new one
	 * (`/new`, `/clear`, a session switch, a resume onto a different transcript): the memory
	 * backend's tracking and delivered block (see {@link MemoryContext.resetForNewTranscript}), and
	 * the session-state block. A fork or a switch lands on a transcript that already states the date
	 * and working directory, `/new` does not, so the delivered block is read from the messages.
	 */
	#resetMemoryContextForNewTranscript(): void {
		this.#memory.resetForNewTranscript();
		this.#deliveredSessionState = lastDeliveredBlock(this.agent.state.messages, SESSION_STATE_MESSAGE_TYPE);
	}

	/** True once dispose() has begun; deferred background work (e.g. the deferred
	 *  MCP discovery task in sdk.ts) must not touch the session past this point. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = path.resolve(sessionFile);
	}

	/**
	 * Synchronously mark the session as disposing so new work is rejected
	 * immediately: eval starts throw, queued asides are dropped, and the
	 * aside provider is detached. Idempotent; `dispose()` runs it first.
	 *
	 * Wrappers that await other teardown before delegating to `dispose()` MUST
	 * call this before their first await — otherwise work started in that async
	 * gap slips past the disposal guards.
	 */
	beginDispose(): void {
		this.#isDisposed = true;
		this.#flushPendingIrcAsides();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#advisorRoster.stop();
		this.#executions.stopEval();
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 *
	 * Idempotent: concurrent or repeated calls share one settled promise. The
	 * keypress `InteractiveMode.shutdown()` path and the postmortem
	 * `SIGTERM`/`SIGHUP`/`uncaughtException` callback can both target this
	 * method, so a second invocation must never re-emit `session_shutdown` or
	 * double-drain the owned `AsyncJobManager` (issue #4080).
	 */
	#disposeCall?: Promise<void>;
	dispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		if (!this.#disposeCall) this.#disposeCall = this.#doDispose(options);
		return this.#disposeCall;
	}

	async #doDispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		this.beginDispose();
		this.#recordSessionExit(options.reason ?? "dispose");
		if (this.#heartbeatLogInterval !== undefined) {
			clearInterval(this.#heartbeatLogInterval);
			this.#heartbeatLogInterval = undefined;
		}
		this.#inFlightToolNames.clear();
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
		try {
			if (this.#config.extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#config.extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: errorMessage(error) });
		}
		// Abort maintenance controllers before draining post-prompt work. Otherwise
		// an in-flight compaction, explicit handoff, or scheduled continuation can
		// keep awaiting a live model stream while #cancelPostPromptTasks waits for
		// its wrappers to settle. The post-prompt task's AbortSignal does not
		// propagate into the inner controllers, so abort them explicitly. Abort the
		// agent as well in case a scheduled continuation already started streaming.
		//
		// Tool work (bash/eval/python) is NOT aborted here — those have their own
		// dispose paths and shared kernels are contractually allowed to survive a
		// session's dispose.
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;
		// The aborted loop is still unwinding: a tool that ignores its signal keeps it
		// running, and the teardown below releases the kernels, tabs and transcript it
		// may still be using. Wait for it, bounded so such a tool cannot hang shutdown.
		const loopSettleMs = options.agentLoopSettleTimeoutMs ?? DISPOSE_AGENT_LOOP_SETTLE_MS;
		try {
			await withTimeout(this.agent.waitForIdle(), loopSettleMs, "Agent loop did not settle after abort");
		} catch (error) {
			logger.warn("Disposing while the aborted agent loop is still running", {
				timeoutMs: loopSettleMs,
				error: errorMessage(error),
			});
		}
		// Cancel jobs this agent registered so a spawned agent's teardown doesn't
		// leak its background bash/task work into the parent's manager. Only
		// the session that owns the manager goes on to dispose it (which itself
		// nukes any leftover jobs and pending deliveries).
		this.#cancelOwnAsyncJobs();
		const ownedAsyncManager = this.#config.ownedAsyncJobManager;
		if (ownedAsyncManager) {
			const drained = await ownedAsyncManager.dispose({ timeoutMs: 3_000 });
			const deliveryState = ownedAsyncManager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
			if (AsyncJobManager.instance() === ownedAsyncManager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
		const evalExecutionsSettled = await this.#executions.settleEvalForDispose();
		if (!evalExecutionsSettled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}
		// Every owner-scoped subsystem that registered a disposer: the Python, Ruby and Julia
		// kernels, and the JS eval contexts, which are owner-scoped like the kernels and leaked the
		// eval subprocess across sessions for the life of the parent before they were reaped
		// (GRAN-11). This used to be four `await`s naming those four functions, which meant the
		// first one to throw skipped the rest AND the browser-tab release below. The registry runs
		// all of them and reports the failures together; see `session/owned-resources.ts`.
		try {
			await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		} catch (error) {
			logger.warn("Some owner-scoped resources failed to release during dispose", { error: errorMessage(error) });
		}
		// Everything keyed by the SESSION id rather than the eval-kernel owner id. Today that is the
		// browser tool's headless / spawned Chromium and worker tabs: its `tabs`/`browsers` maps are
		// module-global, shared with spawned agents and future sessions, so release walks by
		// `ownerSessionId` (stamped at `acquireTab` creation, never on reuse) and touches only what
		// THIS session created. The registry carries the 3s bound that keeps a broken CDP close from
		// stalling `/exit` (issue #3963).
		const browserOwnerId = this.sessionManager.getSessionId();
		if (browserOwnerId) {
			try {
				await disposeOwnedResources("session", browserOwnerId);
			} catch (error) {
				logger.warn("Some session-scoped resources failed to release during dispose", {
					error: errorMessage(error),
				});
			}
		}
		this.#inFlight.releasePowerAssertion();
		// Clean up an empty session created by this session's /move so it doesn't accumulate.
		await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
		this.#movedFromEmptySessionFile = undefined;
		let persistenceFailed = false;
		let persistenceError: unknown;
		try {
			await this.sessionManager.close();
		} catch (error) {
			persistenceFailed = true;
			persistenceError = error;
		}
		try {
			// beginDispose() stopped the advisor and captured its recorder close; await
			// it so the final advisor turn is flushed before the process may exit.
			await this.#advisorRoster.whenRecordersClosed();
			this.#providerSessions.closeAll("dispose");
			// Release this session's hold on the MCP manager. The last top-level holder
			// disconnects it, so its stdio servers are not orphaned at exit and a
			// conversation that outlives this one keeps them. Best-effort: a failure
			// here must never throw out of dispose. Spawned agents reuse a parent's
			// manager without a hold and omit this callback.
			//
			// BOUNDED: the manager may hold an HTTP/SSE server whose session-
			// termination DELETE blocks up to the MCP request timeout (30s default,
			// unbounded when VEYYON_MCP_TIMEOUT_MS=0), so awaiting `disconnectAll()`
			// unbounded would stall /exit and print-mode shutdown on a broken remote
			// endpoint. Race it against a short deadline — stdio close (the subprocess
			// reap this targets) completes well within the bound; a slow transport
			// close is left to finish detached. Mirrors the bounded async-job teardown.
			const releaseMcpManager = this.#config.releaseMcpManager;
			if (releaseMcpManager) {
				try {
					await withTimeout(releaseMcpManager(), 3_000, "Timed out releasing the MCP manager during dispose");
				} catch (error) {
					logger.warn("Failed to release the MCP manager during dispose", { error: errorMessage(error) });
				}
			}
			// Flush the retain queue BEFORE clearing the session's pointer so
			// `HindsightRetainQueue.#doFlush` still sees `session.getHindsightSessionState() === state`.
			// Reversed, the spliced batch survives just long enough to fail the
			// identity check and get dropped with a `session vanished` warning.
			const hindsightState = this.getHindsightSessionState();
			await hindsightState?.flushRetainQueue();
			this.setHindsightSessionState(undefined);
			hindsightState?.dispose();
			const mnemopiState = setMnemopiSessionState(this, undefined);
			await mnemopiState?.dispose({ timeoutMs: options.mnemopiConsolidateTimeoutMs });
			this.#disconnectFromAgent();
			for (const release of this.#listenerReleases.splice(0)) release();
			this.#eventListeners = [];
		} catch (error) {
			if (!persistenceFailed) throw error;
		}
		// Preserve the original persistence rejection after resource cleanup.
		if (persistenceFailed) throw persistenceError;
	}

	freshSession(): FreshSessionResult | undefined {
		if (this.isStreaming) return undefined;
		const previousSessionId = this.sessionId;
		const closedProviderSessions = this.#providerSessions.states.size;
		this.#providerSessions.closeAll("fresh session");
		this.#providerSessions.freshId = Bun.randomUUIDv7();
		this.#providerSessions.sync();
		this.#memory.rekey();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		return {
			previousSessionId,
			sessionId: this.sessionId,
			closedProviderSessions,
		};
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	#serviceTierByFamily: ServiceTierByFamily = {};

	/** Live per-family service tiers (OpenAI / Anthropic / Google). */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/**
	 * The thinking surface, delegated to {@link ThinkingRuntime}. These eight
	 * members are the session's public effort API — the facade, rpc mode, the SDK
	 * and `/effort` all reach them here — so they stay on the class while the
	 * state and the resolution rules live with the collaborator.
	 */

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinking.level;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#thinking.configuredLevel();
	}

	/** Session-only effort choice, excluding selector and saved per-model defaults. */
	get sessionThinkingOverride(): ConfiguredThinkingLevel | undefined {
		return this.#thinking.sessionOverride;
	}

	/** True when `auto` thinking mode is active. */
	get isAutoThinking(): boolean {
		return this.#thinking.isAuto;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#thinking.autoResolvedLevel();
	}

	/**
	 * Set the thinking level. Public calls create a session override; internal
	 * model routing passes `resolved` so per-model defaults remain eligible on
	 * the next switch. `auto` resolves to a concrete effort for each turn.
	 */
	setThinkingLevel(
		level: ConfiguredThinkingLevel | undefined,
		persist: boolean = false,
		source: "session" | "resolved" = "session",
	): void {
		this.#thinking.set(level, persist, source);
	}

	/** Cycle through the active model's named effort variants. */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#thinking.cycle();
	}

	/** Effort variants the active model accepts. */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		return this.#thinking.availableLevels();
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#inFlight.active;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
		while (this.#ircWakeSettled) {
			await this.#ircWakeSettled;
			await this.agent.waitForIdle();
			await this.#waitForPostPromptRecovery();
		}
	}

	/**
	 * Wait until this conversation has nothing left to run: the loop and its post-prompt recovery
	 * are idle, and no background job this agent owns will wake the loop again. A job completion
	 * that starts another turn is waited out in turn. Returns once `signal` aborts.
	 */
	async waitForQuiescence(signal?: AbortSignal): Promise<void> {
		while (!signal?.aborted) {
			await this.waitForIdle();
			if (signal?.aborted || !this.#hasPendingAsyncWake()) return;
			await this.#nextAsyncWakeChange(signal);
		}
	}

	/**
	 * Resolve on the first event that can change {@link #hasPendingAsyncWake}: an owned job
	 * settling, a turn starting, `signal` aborting, or {@link QUIESCENCE_RECHECK_MS} passing.
	 */
	async #nextAsyncWakeChange(signal: AbortSignal | undefined): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => resolve();
		const timer = setTimeout(wake, QUIESCENCE_RECHECK_MS);
		const unsubscribe = this.subscribe(event => {
			if (event.type === "agent_start") wake();
		});
		signal?.addEventListener("abort", wake, { once: true });
		const ownerFilter = this.#config.agentId ? { ownerId: this.#config.agentId } : undefined;
		for (const job of this.#asyncJobManager?.getRunningJobs(ownerFilter) ?? []) {
			job.promise.then(wake, wake);
		}
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", wake);
		}
	}

	/**
	 * Prevent advisor notes from starting hidden primary turns while a headless
	 * caller prints and drains the final primary response.
	 */
	prepareForHeadlessAdvisorDrain(): void {
		this.#advisorRoster.prepareForHeadlessDrain();
	}

	async #waitForPendingAdvisorCardEvents(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (this.#pendingAdvisorCardEvents.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = Promise.allSettled([...this.#pendingAdvisorCardEvents]).then(() => true as const);
			const { promise: timedOut, resolve } = Promise.withResolvers<false>();
			const timer = setTimeout(() => resolve(false), remainingMs);
			try {
				if (!(await Promise.race([settled, timedOut]))) return false;
			} finally {
				clearTimeout(timer);
			}
		}
		return true;
	}

	/**
	 * Wait for active advisor reviews and their emitted card events before a
	 * headless caller disposes the session. Returns `false` and logs work disposal
	 * will abandon when the shared deadline expires or an advisor fails.
	 */
	async waitForAdvisorCatchup(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const { abandoned } = await this.#advisorRoster.waitForCatchup(timeoutMs);
		const cardEventsCaughtUp = await this.#waitForPendingAdvisorCardEvents(Math.max(0, deadline - Date.now()));
		if (abandoned.length > 0 || !cardEventsCaughtUp) {
			logger.warn("advisor shutdown drain incomplete; disposal will abandon reviews or cards", {
				timeoutMs,
				advisors: abandoned,
				pendingAdvisorCards: this.#pendingAdvisorCardEvents.size,
			});
			return false;
		}
		return true;
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#config.agentId ? { ownerId: this.#config.agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return findLastAssistantMessage(this.agent.state.messages);
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retry.attempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has(TOOL.edit);
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/** True when the current registry entry for `name` came from a built-in factory. */
	hasBuiltInTool(name: string): boolean {
		return this.#discovery.isBuiltIn(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	/**
	 * Registers the ephemeral vibe tools and activates them alongside `baseToolNames`.
	 *
	 * @throws When this session cannot create vibe tools or the factory returns duplicate names.
	 */
	async activateVibeTools(baseToolNames: string[]): Promise<void> {
		await this.#toolActivation.activateVibeTools(baseToolNames);
	}

	/** Removes tools installed by {@link activateVibeTools} and activates `nextToolNames`. */
	async deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		await this.#toolActivation.deactivateVibeTools(nextToolNames);
	}

	/**
	 * Rebuild the prompt for a model switch, when the switch actually moved a
	 * prompt input.
	 *
	 * EVERY caller of this method has just switched models, so every reason it
	 * records names that switch. It used to record a bare `edit-mode-change`
	 * whenever the edit variant differed, which describes a trigger no session can
	 * produce: nothing re-resolves the edit mode except a model switch, because
	 * `edit.mode` is not a prompt gate (see `system-prompt-builder/gate-registry`)
	 * and the only reads of `resolveActiveEditMode` for this purpose are the four
	 * `setModel`/`cycleModel` paths. So a reader triaging `cacheRead: 0` turns off
	 * the invalidation record chased a phantom settings flip, when the entry
	 * actually describes the ONE invalidation that is unavoidable: a different
	 * model is a different provider cache namespace, so the prefix was already
	 * dead and the rebuild cost nothing extra.
	 *
	 * Which inputs moved is still recorded, because that is the actionable half:
	 * `edit-mode` means the two models share a prompt cohort and only the edit
	 * variant forced the rebuild.
	 */
	async #syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		this.#compaction.resetAutoCompactionGuard("model_change");
		const currentEditMode = resolveActiveEditMode(this.settings, this.model);
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes(TOOL.edit);
		// The system prompt selects model-specific policy even when it does not display the model id.
		const modelChanged = this.#toolActivation.promptModelMoved();
		if (!editModeChanged && !modelChanged) return;
		const moved = [modelChanged ? "prompt-model-key" : undefined, editModeChanged ? "edit-mode" : undefined]
			.filter(part => part !== undefined)
			.join("+");
		await this.refreshBaseSystemPrompt(`model-switch:${moved}`);
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#discovery.mcpEnabled;
	}

	/**
	 * Flip MCP discovery on after deferred discovery learns the real tool count.
	 * UI sessions resolve `tools.discoveryMode: "auto"` before MCP servers
	 * connect, so a large MCP toolset discovered later must be able to upgrade
	 * the session from the force-activate path to the discovery path. One-way:
	 * discovery is never downgraded mid-session.
	 */
	enableMCPDiscovery(): void {
		this.#discovery.enableMCP();
	}

	getSelectedMCPToolNames(): string[] {
		return this.#discovery.selectedMCP();
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		return this.activateDiscoveredTools(toolNames.filter(isMCPToolName));
	}

	// ── Generic tool discovery (covers built-in + MCP + extension) ────────────

	isToolDiscoveryEnabled(): boolean {
		return this.#discovery.effectiveMode() !== "off";
	}

	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		return this.#discovery.discoverableTools(filter);
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		return this.#discovery.searchIndex();
	}

	getSelectedDiscoveredToolNames(): string[] {
		return this.#discovery.selectedDiscovered();
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const plan = this.#discovery.planActivation(toolNames, {
			messages: this.messages,
		});
		if (!plan.changed) return [];
		this.#discovery.applyActivation(plan);
		await this.setActiveToolsByName(plan.nextActive);
		const selection = this.#discovery.selectedDiscovered();
		if (!sameToolNames(this.sessionManager.getMCPToolSelection() ?? [], selection)) {
			this.sessionManager.appendMCPToolSelection(selection);
		}
		return plan.activated;
	}

	/** Apply a hot-reloaded lower cap to active schemas and the saved selection. */
	async enforceDiscoveredToolCap(): Promise<void> {
		const plan = this.#discovery.planCapReduction();
		if (!plan.changed) return;
		this.#discovery.applyPrune(plan);
		await this.setActiveToolsByName(plan.nextActive);
		const selection = this.#discovery.selectedDiscovered();
		if (!sameToolNames(this.sessionManager.getMCPToolSelection() ?? [], selection)) {
			this.sessionManager.appendMCPToolSelection(selection);
		}
	}

	/**
	 * Prune search-activated tools after history compaction that were not called in `messages`.
	 * Default, config, and protected tools are never pruned.
	 * Persists the reduced selection through `mcp_tool_selection`.
	 */
	async pruneDiscoveredToolsAfterCompaction(messages: readonly AgentMessage[]): Promise<void> {
		const plan = this.#discovery.planCompactionPrune(messages);
		if (!plan.changed) return;
		this.#discovery.applyPrune(plan);
		await this.setActiveToolsByName(plan.nextActive);
		const selection = this.#discovery.selectedDiscovered();
		if (!sameToolNames(this.sessionManager.getMCPToolSelection() ?? [], selection)) {
			this.sessionManager.appendMCPToolSelection(selection);
		}
	}

	/** The approval rung this session enforces; see {@link SessionApprovals.effectiveMode}. */
	effectiveApprovalMode(): ApprovalMode {
		return this.#approvals.effectiveMode();
	}

	/** Whether the `/yolo` bypass is active; see {@link SessionApprovals.isBypassed}. */
	isApprovalBypassed(): boolean {
		return this.#approvals.isBypassed();
	}

	/**
	 * Turn the `/yolo` bypass on or off. Returns the new state. Session-scoped: never written to
	 * settings, so a fresh session starts with it off. The next tool call reads it through the tool
	 * context (`bypassAllApprovals`).
	 */
	setApprovalBypass(enabled: boolean): boolean {
		return this.#approvals.setBypass(enabled);
	}

	/** The standing per-tool approval decisions the tool wrapper reads and writes. */
	sessionToolApprovals(): SessionToolApprovals {
		return this.#approvals.toolDecisions();
	}

	/**
	 * Reload the SSH tool from disk-backed capability discovery and make the
	 * refreshed definition visible to the next model call without restarting.
	 */
	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		await this.#toolActivation.refreshSshTool(options);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#toolActivation.apply(toolNames);
	}

	/** Every prefix-cache invalidation this session caused, by reason; see {@link ToolActivation.systemPromptInvalidations}. */
	systemPromptInvalidations(): readonly string[] {
		return this.#toolActivation.systemPromptInvalidations();
	}

	/**
	 * Rebuild the base system prompt for the active tool set and return the prompt now in force,
	 * recording `reason` when the bytes change; see {@link ToolActivation.refreshBaseSystemPrompt}.
	 */
	async refreshBaseSystemPrompt(reason: string): Promise<string[]> {
		return this.#toolActivation.refreshBaseSystemPrompt(reason);
	}

	/**
	 * The session-state block already delivered, so the same date and working
	 * directory are never stated twice. Undefined until the first delivery.
	 */
	#deliveredSessionState: string | undefined;

	/**
	 * Publish the backend's current volatile context for delivery at the next step
	 * boundary, and report whether anything new is queued.
	 *
	 * This is what a recall or a mental-model reload calls instead of
	 * `refreshBaseSystemPrompt`. It happens while a turn is already running (recall
	 * fires on `agent_start`) or between turns (the mental-model TTL reload fires
	 * on `agent_end`); either way the block reaches the model as a message after
	 * everything already cached, so the prefix survives.
	 */
	async publishVolatileMemoryContext(reason: string): Promise<boolean> {
		return this.#memory.publish(reason);
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 *
	 * @param mcpTools The new MCP tools to register.
	 * @param options.activateAll When true, force-activates every newly registered MCP tool
	 *   regardless of prior selection state. Used when MCP discovery is disabled and tools
	 *   arrive after initial session activation.
	 */
	async refreshMCPTools(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		await this.#toolActivation.refreshMCPTools(mcpTools, options);
	}

	/** The context an MCP custom tool runs against, read live on every call. */
	#customToolContext(): CustomToolContext {
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.#config.modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			obfuscateProviderText: text => this.obfuscateProviderText(text),
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
			settings: this.settings,
			getTurnIndex: () => this.getTurnIndex(),
			localProtocolOptions: localProtocolOptions(this.sessionManager),
		};
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		await this.#toolActivation.refreshRpcHostTools(rpcTools);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#compaction.isCompacting;
	}

	/**
	 * Whether idle-flush tasks, auto-continuations, or other short-lived
	 * post-prompt work are pending.  True in the brief window after
	 * `session.prompt()` returns but before a scheduled background delivery
	 * (e.g. an async-job result) has finished its own streaming turn.
	 * Loop-mode and similar auto-submit paths should treat this as a block
	 * to avoid racing against the delivery turn.
	 */
	get hasPostPromptWork(): boolean {
		return this.#postPrompt.pending;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
	getImageAttachments(): { label: string; uri: string; image: ImageContent }[] {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.map((image, index) => ({
				label: `Image #${index + 1}`,
				uri: `attachment://${index + 1}`,
				image,
			}));
		}
		return [];
	}

	buildDisplaySessionContext(): SessionContext {
		// RENDER PATH, and also the agent-state rebuild after a compaction, a
		// history rewrite or a session switch, so a throw here does not fail one
		// render, it fails the session. Degrades per string; never throws.
		return this.#expandArgot(
			this.#secrets.deobfuscateSessionContextForDisplay(
				this.sessionManager.buildSessionContext({ activeProvider: this.model?.provider }),
			),
		);
	}

	/**
	 * Expand argot handles across a rebuilt transcript so display/export/resume
	 * matches the live message seam. No-op unless a dictionary was read this
	 * session. Composes after secret deobfuscation.
	 */
	#expandArgot(context: SessionContext): SessionContext {
		return this.#config.argot?.loaded ? expandSessionContext(this.#config.argot, context) : context;
	}

	/**
	 * Expand argot handles across transcript entries a viewer parsed off disk.
	 *
	 * The agent dashboard reads a spawned agent's or advisor's session file
	 * directly, so it never passes through `buildDisplaySessionContext`. It gets
	 * the same codec through this accessor rather than reaching for `#argot`.
	 */
	expandArgotEntries(entries: SessionMessageEntry[]): SessionMessageEntry[] {
		return this.#config.argot?.loaded ? expandSessionMessageEntries(this.#config.argot, entries) : entries;
	}

	/**
	 * Transcript for TUI display. Full history is kept for export/resume-style
	 * callers; live chat can collapse compacted history to keep the hot render
	 * surface bounded. Display-only — NEVER feed the result to
	 * `agent.replaceMessages` or a provider.
	 */
	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		// RENDER PATH: every TUI repaint runs this, so a throw would unwind the
		// render loop. Degrades per string; never throws.
		return this.#expandArgot(
			this.#secrets.deobfuscateSessionContextForDisplay(
				this.sessionManager.buildSessionContext({
					transcript: true,
					collapseCompactedHistory: options?.collapseCompactedHistory,
					keepDanglingToolCalls: options?.keepDanglingToolCalls,
				}),
			),
		);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		return this.#secrets.obfuscateMessages(convertToLlm(messages));
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformContext = this.#config.transformContext;
		const transformedMessages = await (transformContext ? transformContext(messages, signal) : messages);
		return await (this.#config.convertToLlm ?? convertToLlm)(transformedMessages);
	}

	/**
	 * Apply session-level stream hooks to a direct side request.
	 *
	 * The lease is admitted before any caller/extension hook can run and is
	 * captured by the returned payload hook for the request's full lifetime.
	 */
	async prepareSimpleStreamOptions(
		options: SimpleStreamOptions,
		provider = "anthropic",
	): Promise<SimpleStreamOptions> {
		const runtime = await this.leaseSecretRuntime();
		const sessionOnPayload = this.#config.payloadHook?.();
		const sessionOnResponse = this.#onResponse;
		const sessionMetadata = this.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#onSseEvent;
		const openrouterRoutingPreset =
			provider === "openrouter" ? this.settings.get("providers.openrouterVariant") : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? this.settings.get("providers.antigravityEndpoint") : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? this.settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: this.settings.get("model.loopGuard.enabled"),
				checkAssistantContent: this.settings.get("model.loopGuard.checkAssistantContent"),
				...options.loopGuard,
			},
		};

		// Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so
		// they share the same session bucket as Agent.prompt-routed requests on Anthropic
		// OAuth. Caller-provided metadata wins so explicit overrides are respected.
		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		const requestOnPayload = options.onPayload;
		if (runtime.hasRedactions || sessionOnPayload || requestOnPayload) {
			preparedOptions.onPayload = async (payload, model) => {
				const sessionPayload = sessionOnPayload ? await sessionOnPayload(payload, model) : undefined;
				const sessionResolvedPayload = sessionPayload ?? payload;
				const requestPayload = requestOnPayload ? await requestOnPayload(sessionResolvedPayload, model) : undefined;
				return runtime.obfuscatePayload(requestPayload ?? sessionResolvedPayload);
			};
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.#providerSessions.activeId();
	}
	getEvalSessionId(): string {
		const parentEvalSessionId = this.#config.parentEvalSessionId;
		if (parentEvalSessionId !== undefined) return parentEvalSessionId;
		return defaultEvalSessionId({
			cwd: this.sessionManager.getCwd(),
			getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
		});
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flags). */
	get scopedModels(): ReadonlyArray<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planMode.state;
	}

	/** Prewalk state, if armed and active */
	getPrewalkState(): Prewalk | undefined {
		return this.#handoff.prewalk;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planMode.setState(state);
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	getVibeModeState(): VibeModeState | undefined {
		return this.#vibeModeState;
	}

	setVibeModeState(state: VibeModeState | undefined): void {
		this.#vibeModeState = state;
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	markPlanReferenceSent(): void {
		this.#planMode.markReferenceSent();
	}

	setPlanReferencePath(path: string): void {
		this.#planMode.setReferencePath(path);
	}

	getPlanReferencePath(): string {
		return this.#planMode.referencePath;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#approvals.forgetClientDecisions();
		const activeToolNames = this.getActiveToolNames();
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#approvals.wrapForClient(tool));
		this.agent.setTools(activeTools);
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpoint.state;
	}

	getLastCompletedRewind(): CompletedRewindState | undefined {
		return this.#checkpoint.lastCompleted;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpoint.set(state);
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#planMode.buildContextMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await sendModeContext(this, this.#buildGoalModeMessage(), options);
	}

	async sendVibeModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await sendModeContext(this, this.#buildVibeModeMessage(), options);
	}

	/**
	 * Resolve a helper to its model and thinking level.
	 */
	resolveHelperModel(id: HelperId): HelperModelSelection | undefined {
		return resolveHelperModel(this.settings, id, this.#config.modelRegistry.getAvailable(), this.model);
	}

	/**
	 * Resolve the configured `defaultModel` chain to its first available model,
	 * with the effort its `:level` suffix names. Undefined when the setting is
	 * unset or matches nothing available.
	 */
	resolveDefaultModel(): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
		const resolved = resolveModelSelectorValue(
			this.settings.get("defaultModel"),
			this.#config.modelRegistry.getAvailable(),
			{ settings: this.settings, matchPreferences: getModelMatchPreferences(this.settings) },
		);
		if (!resolved.model) return undefined;
		return {
			model: resolved.model,
			thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
		};
	}

	/**
	 * Resolve the explicit thinking suffix that should apply when a temporary
	 * picker selects a model already assigned to defaultModel or a helper chain.
	 */
	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#config.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.settings);
		const defaultPattern = this.settings.get("defaultModel");
		if (defaultPattern) {
			const resolved = resolveModelSelectorValue(defaultPattern, availableModels, {
				settings: this.settings,
				matchPreferences,
			});
			if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined && resolved.model) {
				if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
			}
		}

		for (const id of HELPER_IDS) {
			const patterns = helperModelPatterns(this.settings, id);
			if (patterns.length === 0) continue;
			const resolved = resolveModelSelectorValue(patterns, availableModels, {
				settings: this.settings,
				matchPreferences,
			});
			if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined && resolved.model) {
				if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
			}
		}

		return undefined;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		const todoContext = buildGoalTodoContext(this);
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalsPrompts["goals/goal-mode-context"].text, { goalContext: content, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * The date and working directory as they stand now, or null when the model has
	 * already been told exactly this.
	 *
	 * Deduped against the last block delivered, so a session that never re-roots
	 * states them once and a session that re-roots restates them on the next turn.
	 * Re-sending an unchanged block would grow the context every turn for no new
	 * information, which is the cost this whole arrangement exists to avoid.
	 */
	#buildSessionStateMessage(): CustomMessage | null {
		const content = prompt
			.render(sessionPrompts["session/session-state"].text, {
				date: localCalendarDate(Date.now()),
				cwd: shortenPath(normalizePromptPath(this.sessionManager.getCwd())),
			})
			.trim();
		if (content === this.#deliveredSessionState) return null;
		this.#deliveredSessionState = content;
		return {
			role: "custom",
			customType: SESSION_STATE_MESSAGE_TYPE,
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildVibeModeMessage(): CustomMessage | null {
		if (!this.#vibeModeState?.enabled) return null;
		return {
			role: "custom",
			customType: "vibe-mode-context",
			content: prompt.render(sessionPrompts["session/vibe-mode-active"].text),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Build a hidden companion message describing image attachments for a text-only
	 * model. Each image is saved under local:// and a vision-capable model describes
	 * it; the descriptions are returned as a `display: false` custom message (so the
	 * model reads them but the TUI does not render the blob) carrying one
	 * `<image path="local://…">…</image>` block per image. Returns `undefined` when
	 * the active model already accepts images, the feature is disabled, or no
	 * description could be produced. Never throws.
	 */
	async #buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const model = this.model;
		const shouldDescribe =
			!!model &&
			!model.input.includes("image") &&
			!this.settings.get("images.blockImages") &&
			this.settings.get("images.describeForTextModels");
		if (!shouldDescribe || !model) {
			return undefined;
		}
		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(
				normalizedImages,
				{
					activeModel: model,
					modelRegistry: this.#config.modelRegistry,
					settings: this.settings,
					localProtocolOptions: localProtocolOptions(this.sessionManager),
					activeModelString: formatModelString(model),
					telemetryConfig: this.agent.telemetry,
					sessionId: this.sessionId,
				},
				signal,
			);
		} catch (err) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: errorMessage(err),
			});
			return undefined;
		}
		if (blocks.length === 0) {
			return undefined;
		}
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	/**
	 * The content of a text message carrying image attachments: the text, then the images normalized
	 * for the active model. When the model is text-only, the hidden companion describing the images is
	 * returned beside it; the image stays in the message itself.
	 */
	async #textWithImages(
		text: string,
		images: ImageContent[] | undefined,
	): Promise<{
		content: (TextContent | ImageContent | VideoContent)[];
		images: ImageContent[] | undefined;
		imageDescriptionNotice: CustomMessage | undefined;
	}> {
		const normalizedImages = await normalizeModelContextImages(images, { model: this.model });
		const content: (TextContent | ImageContent | VideoContent)[] = [{ type: "text", text }];
		if (!normalizedImages?.length) return { content, images: normalizedImages, imageDescriptionNotice: undefined };
		content.push(...normalizedImages);
		return {
			content,
			images: normalizedImages,
			imageDescriptionNotice: await this.#buildImageDescriptionNotice(normalizedImages),
		};
	}

	/**
	 * Hand startup work to the session instead of awaiting it on the boot path.
	 *
	 * Chained, so several deferrals order the way they were handed over, and swallowed, so a failure
	 * cannot reach the process as an unhandled rejection or refuse the first turn — the work logs its
	 * own failure.
	 */
	deferStartupWork(work: Promise<void>): void {
		this.#startupHydration = this.#startupHydration.then(() => work).catch(() => {});
	}

	/** Resolves once every deferred startup task has finished. A turn awaits this before it runs. */
	whenStartupHydrated(): Promise<void> {
		return this.#startupHydration;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	/**
	 * Returns `false` when the command was fully handled locally (extension or
	 * custom-TS command consumed without calling the LLM). Returns `true` when
	 * the prompt was forwarded to the agent — either directly or queued as a
	 * steer/follow-up. Callers that render a UI or manage turn lifecycle (e.g.
	 * the ACP agent) use this to know whether to expect an `agent_end` event.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		await this.#promptRefresh;
		await this.#startupHydration;
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		const restoredOwnership =
			sessionFile && sessionId ? await readSessionOwnershipMarker(sessionFile, sessionId) : null;
		const cloudSessionId = restoredOwnership?.marker.sessionId ?? process.env.VEYYON_CHECKPOINT_SESSION;
		if (restoredOwnership && !this.settings.get("checkpoints.enabled"))
			throw new Error("Transferred session requires checkpoints.enabled; prompt admission is blocked");
		if (restoredOwnership && process.env.VEYYON_CHECKPOINT_NODE !== restoredOwnership.marker.targetNode)
			throw new Error("Transferred session belongs to a different checkpoint node; prompt admission is blocked");
		if (this.settings.get("checkpoints.enabled") && cloudSessionId && cloudSessionId === sessionId) {
			if (!this.#cloudOwnership) {
				const ownershipMarker = restoredOwnership?.marker;
				const ownershipPath = restoredOwnership?.path;
				this.#cloudOwnership = new SynchronizedSession(
					cloudSessionId,
					CheckpointClient.fromEnv(),
					ownershipMarker,
					undefined,
					ownershipMarker && ownershipPath
						? (resumeToken, epoch) =>
								persistSessionResumeCapability(ownershipPath, ownershipMarker, resumeToken, epoch)
						: undefined,
				);
				const previous = this.agent.beforeToolCall;
				this.agent.beforeToolCall = async (context, signal) => {
					if (this.sessionManager.getSessionId() !== cloudSessionId) {
						await this.#cloudOwnership!.close();
						if (ownershipMarker)
							throw new ToolAdmissionFatalError(
								"Transferred session identity changed; tool admission is blocked",
							);
						return previous?.(context, signal);
					}
					try {
						await this.#cloudOwnership!.admit();
					} catch (error) {
						// Without write authority every later call fails the same way; end the run instead of letting the
						// model re-sample against a fence it cannot lift.
						throw new ToolAdmissionFatalError(errorMessage(error), { cause: error });
					}
					return previous?.(context, signal);
				};
				this.#listenerReleases.push(() => {
					void this.#cloudOwnership!.close().catch(error =>
						logger.warn("Cloud ownership release failed", { error: errorMessage(error) }),
					);
				});
			}
			await this.#cloudOwnership.admit();
		} else if (restoredOwnership) {
			throw new Error("Transferred session does not match its cloud authority marker; prompt admission is blocked");
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await tryExecuteExtensionCommand(this.#config.extensionRunner, text);
			if (handled) {
				return false;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await tryExecuteCustomCommand(this, this.customCommands, text, agent =>
				this.#grantedAgents.add(agent),
			);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				const parsed = parseSlashCommand(text);
				const canonicalInvocation =
					parsed === null ? text : `/${parsed.name}${parsed.args.length > 0 ? ` ${parsed.args}` : ""}`;
				text = expandSlashCommand(canonicalInvocation, this.#slashCommands);
			}
		}

		if (options?.videos?.length) {
			if (!this.model?.input.includes("video")) {
				throw new UnsupportedModelInputError(this.model?.id ?? "unknown", "video");
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// Every resolver has now had its turn: builtins upstream in the dispatcher,
		// then extension, custom, file-based commands and prompt templates above. A
		// text that STILL reads as `/name` is a command this build does not have,
		// and forwarding it to the model is the wrong answer to a typo. It is also
		// the bug this refusal was written for: `/secret list`, typed into a build
		// that predated the command, was sent as prose and the model began grepping
		// the filesystem for secrets files. Synthetic prompts are exempt because an
		// agent-authored turn is never a user reaching for a command.
		if (expandPromptTemplates && !options?.synthetic && expandedText === text) {
			const unresolved = unresolvedSlashCommandName(text);
			// The name only. The argument tail of a miss on `/secret add` is a credential.
			if (unresolved !== undefined) throw new Error(unknownSlashCommandMessage(unresolved));
		}

		// Magic keywords ("ultrathink", "orchestratez"): append hidden system notices after the
		// user's message that steer this turn. User-authored prompts only — synthetic /
		// agent-initiated turns never trigger them.
		const keywordNotices = options?.synthetic ? [] : createMagicKeywordNotices(this, expandedText);

		// A user-initiated prompt (typed message or the `.`/`c` continue shortcut)
		// re-enables advisor auto-resume that a prior user interrupt suppressed.
		// Agent-initiated synthetic prompts (auto-continue, plan, reminders) do not.
		if (options?.userInitiated ?? !options?.synthetic) {
			this.#finalize.evidence.startUserTurn();
			this.#advisorRoster.allowAutoResume();
			this.#planMode.noteUserTurn();
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			// Steer/follow-up the keyword notices BEFORE the queued user message so the
			// model reads the steering notice ahead of the prompt it modifies.
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, options?.videos, "followUp", options);
			} else {
				await this.#queueUserMessage(expandedText, options?.images, options?.videos, "steer", options);
			}
			return true;
		}

		// Skip eager preludes when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#todo.eagerPrelude(expandedText) : undefined;
		const eagerTaskPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTaskPrelude(expandedText) : undefined;
		const {
			content: userContent,
			images: normalizedImages,
			imageDescriptionNotice,
		} = await this.#textWithImages(expandedText, options?.images);
		if (options?.videos?.length) {
			userContent.push(...options.videos);
		}

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };
		if (options?.telegramTrace) {
			attachTelegramTrace(message, options.telegramTrace, this.sessionManager.getSessionId());
		}

		const preludeMessages: AgentMessage[] = [];
		if (eagerTodoPrelude) {
			if (eagerTodoPrelude.toolChoice) {
				this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
					label: "eager-todo",
				});
			}
			preludeMessages.push(eagerTodoPrelude.message);
		}
		if (eagerTaskPrelude) {
			preludeMessages.push(eagerTaskPrelude);
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				images: normalizedImages,
				prependMessages:
					preludeMessages.length > 0 || keywordNotices.length > 0 || imageDescriptionNotice
						? [...preludeMessages, ...keywordNotices, ...(imageDescriptionNotice ? [imageDescriptionNotice] : [])]
						: undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		return true;
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & {
			queueChipText?: string;
			queueOnly?: boolean;
		},
	): Promise<void> {
		const textContent = contentText(message.content, { separator: "" });

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillArgs = "";
			if (details && typeof details === "object" && "args" in details && typeof details.args === "string") {
				skillArgs = details.args;
			}
			keywordNotices = createMagicKeywordNotices(this, skillArgs);
		}

		if (options?.queueOnly) {
			if (!options.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await queueCustomMessage(this, notice, options.streamingBehavior);
			}
			await queueCustomMessage(this, message, options.streamingBehavior, options.queueChipText);
			return;
		}
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			await this.sendCustomMessage(message, {
				deliverAs: options.streamingBehavior,
				queueChipText: options.queueChipText,
			});
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<void> {
		this.#inFlight.begin();
		startupMarker("prompt:start");
		const generation = this.#promptGeneration;
		try {
			// The turn leaves rest: take the held at-rest reading before the flush below or the prompt
			// appends a message, since the reading is at rest only while the session holds none.
			takeHeldAtRestReading(this);
			// Flush any pending bash and Python results before the new prompt
			this.#executions.flush();
			this.#pullSessionNotices(true);
			this.#flushPendingIrcAsides();

			// A new user prompt does not reset stop-time reminder suppression. Replaying
			// the same unfinished list after each "continue" correction floods context.
			this.#todo.onNewPrompt();
			this.#resetPromptMaintenanceState();
			this.#stopRetries.acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;

			await this.#retry.maybeRestoreFallbackPrimary();

			// Validate model
			if (!this.model) {
				// Every command named here has to work in the channel the reader is in.
				// `/login` carries no `textMode: true` in
				// `slash-commands/builtin-declarations.ts`, so it is TUI-only, and
				// `veyyon setup` hard-exits with "requires an interactive TTY" when
				// stdin or stdout is not a terminal (see `commands/setup.ts`). This error
				// reaches `--print` runs and ACP clients too, so the terminal path is
				// named separately from the interactive one and the environment variable
				// is named for the case where neither is available.
				throw new Error(
					"No model selected, so there is nothing to send the prompt to.\n\n" +
						"Fix: in an interactive veyyon session, run /login to sign in and then /model to choose a model. " +
						"From a terminal, run `veyyon auth-broker login` to sign in and `veyyon models` to see what is available. " +
						"With no terminal at all, set the provider's API key environment variable and pass `--model <provider>/<id>`.",
				);
			}

			// Validate API key
			const apiKey = await this.#config.modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				const provider = this.model.provider;
				// Distinguish "never signed in" from "signed in, but no usable token
				// right now". `hasAuth` reports whether a credential is configured
				// WITHOUT refreshing; `getApiKey` refreshes and just returned nothing.
				// So when `hasAuth` is true the credential IS stored and the token
				// could not be produced — an expired OAuth token whose refresh failed,
				// or the provider rejecting the refresh (e.g. a 403/402 for a lapsed
				// subscription). Reporting "No API key found" there reads as lost
				// credentials and pushes the user into a re-login loop; name the real
				// cause instead so a provider-side account problem is not mistaken for
				// veyyon losing the login.
				const signedIn = this.#config.modelRegistry.authStorage.hasAuth(provider);
				// A credential a failed refresh disabled is invisible to `hasAuth`,
				// because disabled rows are filtered out of the credential list. So
				// the user whose login was torn down looks identical to the one who
				// never signed in, and gets told to sign in with nothing saying what
				// happened to the login they had. Name the cause instead.
				const disabledCause = signedIn
					? undefined
					: this.#config.modelRegistry.authStorage.disabledCredentialCause(provider);
				throw new Error(
					signedIn
						? `Signed in to ${provider}, but could not get a usable token right now.\n\n` +
								`The stored token may have expired and its refresh failed, or ${provider} rejected it ` +
								`(for example a lapsed subscription or unpaid balance). ` +
								`${credentialRemedySentence(provider)} ` +
								`If signing in again succeeds and the next call still fails the same way, the problem is on the ${provider} side: check that account's billing and plan status. ` +
								`Your credentials are still stored in ${getActiveAuthDbPath()}.`
						: disabledCause
							? `Your ${provider} login was disabled after a token refresh failed, so there is no usable credential right now.\n\n` +
								`The provider rejected the refresh with: ${disabledCause}\n\n` +
								`This usually means the refresh token was already spent or revoked, which a crash mid-refresh can cause. ` +
								`${credentialRemedySentence(provider)} ` +
								`The disabled credential is still recorded in ${getActiveAuthDbPath()} and signing in replaces it.`
							: `No API key found for ${provider}.\n\n` +
								`${credentialRemedySentence(provider)} ` +
								`Stored credentials live in ${getActiveAuthDbPath()}.`,
				);
			}

			// Phase markers for the submit path: VEYYON_DEBUG_STARTUP=1 writes one
			// synchronous stderr line per phase, so a "submit feels slow" report
			// names the phase that spent the time instead of offering a guess.
			startupMarker("prompt:compaction-check:start");
			// Port first: until an unreadable server-side window is ported, the
			// rebuilt context re-expands every message the window stood in for, and
			// any check below would measure (and compact) that expanded span.
			await this.#compaction.portUnreadableRemoteCompaction();
			if (this.#promptGeneration !== generation) {
				return;
			}
			// Check whether an aborted response left enough context pressure to require
			// in-place compaction before this prompt starts its agent loop.
			const lastAssistant = findLastAssistantMessage(this.agent.state.messages);
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#contextCheck.check(lastAssistant, false, false);
			}
			startupMarker("prompt:compaction-check:done");

			startupMarker("prompt:plan-arm:start");
			await this.#handoff.armPlanYoloIfNeeded();
			startupMarker("prompt:plan-arm:done");

			// Build messages array (session context, eager todo prelude, then active prompt message)
			startupMarker("prompt:context-build:start");
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#planMode.buildReferenceMessage();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#planMode.buildContextMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			const vibeModeMessage = this.#buildVibeModeMessage();
			if (vibeModeMessage) {
				messages.push(vibeModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(
					fileMentions,
					this.sessionManager.getCwd(),
					this,
					{
						autoResizeImages: this.settings.get("images.autoResize"),
						useHashLines: resolveFileDisplayMode(this).hashLines,
						snapshotStore: getFileSnapshotStore(this),
					},
				);
				for (const fileMentionMessage of fileMentionMessages) {
					messages.push(await normalizeAgentMessageImages(fileMentionMessage, this.model));
				}
			}

			// Ahead of the user's message, not after it: the memories are what the model
			// should already know when it reads the question, which is how the eager-task
			// prelude is placed too. Position within the turn is free either way — the
			// cache prefix ends before all of it.
			startupMarker("prompt:memory-context:start");
			const memoryContextMessage = await this.#memory.collect(expandedText);
			if (memoryContextMessage) messages.unshift(memoryContextMessage);
			startupMarker("prompt:memory-context:done");
			startupMarker("prompt:context-build:done");

			// Ahead of the memories for the same reason the memories are ahead of the
			// question: the date and the working directory are what the model should
			// already know when it reads either.
			const sessionStateMessage = this.#buildSessionStateMessage();
			if (sessionStateMessage) messages.unshift(sessionStateMessage);
			const beforeAgentStartSystemPrompt = this.#toolActivation.baseSystemPrompt;
			startupMarker("prompt:before-agent-start:start");
			// Emit before_agent_start extension event
			if (this.#config.extensionRunner) {
				const result = await this.#config.extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						const normalized = normalizeCustomMessagePayload(msg);
						const hasExplicitAttribution =
							msg !== null &&
							typeof msg === "object" &&
							!Array.isArray(msg) &&
							(msg.attribution === "user" || msg.attribution === "agent");
						messages.push(
							await normalizeAgentMessageImages(
								{
									role: "custom",
									customType: normalized.customType,
									content: normalized.content,
									display: normalized.display,
									details: normalized.details,
									attribution: hasExplicitAttribution
										? normalized.attribution
										: (promptAttribution ?? (message.role === "user" ? "user" : "agent")),
									timestamp: Date.now(),
								},
								this.model,
							),
						);
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			startupMarker("prompt:before-agent-start:done");

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Auto thinking: classify this real user turn and set the effective level
			// before the model request. Synthetic/tool-continuation turns (developer/
			// custom roles) and non-auto sessions are skipped. Never blocks the turn —
			// failures fall back to a concrete level inside the helper.
			if (this.#thinking.isAuto && message.role === "user") {
				await this.#thinking.applyAuto(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			startupMarker("prompt:pre-prompt-compaction:start");
			await this.#runPrePromptCompactionIfNeeded(messages);
			startupMarker("prompt:pre-prompt-compaction:done");
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			this.#context.beginPrompt(messages);
			try {
				await this.#promptAgentWithIdleRetry(messages, agentPromptOptions, generation);
			} finally {
				this.#context.endPrompt();
			}
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery(generation);
			}
		} finally {
			this.#endInFlight();
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(
		text: string,
		imagesOrOptions?: ImageContent[] | SteerOptions,
		videosOrOptions?: VideoContent[] | SteerOptions,
		options?: SteerOptions,
	): Promise<void> {
		if (text.startsWith("/")) {
			throwIfExtensionCommand(this.#config.extensionRunner, text);
		}

		let images: ImageContent[] | undefined;
		let videos: VideoContent[] | undefined;
		let opts: SteerOptions | undefined;

		if (Array.isArray(imagesOrOptions)) {
			images = imagesOrOptions;
			if (Array.isArray(videosOrOptions)) {
				videos = videosOrOptions;
				opts = options;
			} else if (videosOrOptions && typeof videosOrOptions === "object") {
				opts = videosOrOptions;
			} else {
				opts = options;
			}
		} else if (imagesOrOptions && typeof imagesOrOptions === "object") {
			opts = imagesOrOptions;
		} else if (Array.isArray(videosOrOptions)) {
			videos = videosOrOptions;
			opts = options;
		} else if (videosOrOptions && typeof videosOrOptions === "object") {
			opts = videosOrOptions;
		} else {
			opts = options;
		}

		if (videos?.length && !this.model?.input.includes("video")) {
			throw new UnsupportedModelInputError(this.model?.id ?? "unknown", "video");
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, videos, "steer", opts);
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 * Set `options.synthetic` to enqueue a hidden developer message (agent-attributed
	 * by default) instead of a user-attributed follow-up; the plan-approval flow
	 * uses this to land its execution directive behind a queued user turn without
	 * flipping advisor auto-resume.
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		videosOrOptions?: VideoContent[] | FollowUpOptions,
		options?: FollowUpOptions,
	): Promise<void> {
		if (text.startsWith("/")) {
			throwIfExtensionCommand(this.#config.extensionRunner, text);
		}

		let videos: VideoContent[] | undefined;
		let opts: FollowUpOptions | undefined;
		if (Array.isArray(videosOrOptions)) {
			videos = videosOrOptions;
			opts = options;
		} else if (videosOrOptions && typeof videosOrOptions === "object") {
			opts = videosOrOptions;
		} else {
			opts = options;
		}

		if (videos?.length && !this.model?.input.includes("video")) {
			throw new UnsupportedModelInputError(this.model?.id ?? "unknown", "video");
		}

		const expandedText =
			opts?.expandPromptTemplates === false ? text : expandPromptTemplate(text, [...this.#promptTemplates]);
		if (!opts?.synthetic) {
			await this.#queueUserMessage(expandedText, images, videos, "followUp", opts);
			return;
		}
		// Synthetic branch: agent-initiated hidden developer message. Bypass
		// #queueUserMessage (which clears advisor auto-resume suppression and
		// enqueues as a user-attributed message) and place the developer message
		// directly on the follow-up queue.
		const { content, imageDescriptionNotice } = await this.#textWithImages(expandedText, images);
		if (videos?.length) {
			content.push(...videos);
		}
		if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
		this.agent.followUp({
			role: "developer",
			content,
			attribution: opts.attribution ?? "agent",
			timestamp: Date.now(),
		});
		this.#scheduleIdleQueueDrain();
	}

	async #queueUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		videos: VideoContent[] | undefined,
		mode: "steer" | "followUp",
		options?: { telegramTrace?: TelegramDeliveryTraceData },
	): Promise<void> {
		if (videos?.length && !this.model?.input.includes("video")) {
			throw new UnsupportedModelInputError(this.model?.id ?? "unknown", "video");
		}
		// A queued user message (RPC/SDK/collab steer or follow-up, or a typed message
		// while streaming) is a deliberate resume; re-enable advisor auto-resume that
		// a user interrupt suppressed.
		this.#advisorRoster.allowAutoResume();
		const { content, imageDescriptionNotice } = await this.#textWithImages(text, images);
		if (videos?.length) {
			content.push(...videos);
		}
		if (mode === "followUp") {
			if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
			const message: AgentMessage = {
				role: "user",
				content,
				attribution: "user",
				timestamp: Date.now(),
			};
			if (options?.telegramTrace) {
				attachTelegramTrace(message, options.telegramTrace, this.sessionManager.getSessionId());
			}
			this.agent.followUp(message);
		} else {
			if (imageDescriptionNotice) this.agent.steer(imageDescriptionNotice);
			const message: AgentMessage = {
				role: "user",
				content,
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			};
			if (options?.telegramTrace) {
				attachTelegramTrace(message, options.telegramTrace, this.sessionManager.getSessionId());
			}
			this.agent.steer(message);
		}
		this.#scheduleIdleQueueDrain();
	}

	#scheduleIdleQueueDrain(): void {
		this.#scheduleQueuedMessageDrain();
	}

	#scheduleQueuedMessageDrain(): void {
		if (this.#queuedMessageDrainScheduled || !this.#canAutoContinueForFollowUp() || !this.agent.hasQueuedMessages()) {
			return;
		}
		this.#queuedMessageDrainScheduled = true;
		this.#scheduleAgentContinue({
			shouldContinue: () => {
				this.#queuedMessageDrainScheduled = false;
				return this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages();
			},
			onSkip: () => {
				this.#queuedMessageDrainScheduled = false;
			},
			onError: () => {
				this.#queuedMessageDrainScheduled = false;
			},
		});
	}

	/**
	 * Gate for idle-path queued-message auto-continue. See `#scheduleIdleQueueDrain` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		// A queued steer resumes from ANY tail: Agent.continue() runs #runLoop(undefined),
		// whose initial steering poll injects the steer before the first provider call, so the
		// request tail becomes the steer (valid) regardless of any injected custom / bashExecution
		// / pythonExecution record a user interrupt left as the literal transcript tail. This is
		// why a queued user steer stranded behind a preserved advisor card (or a flushed IRC aside
		// / eval execution record) still resumes — no tail-role enumeration needed.
		if (this.agent.peekSteeringQueue().length > 0) return true;
		// Follow-up-only auto-resume stays suppressed while a deliberate user interrupt is in effect
		// (the advisor roster's auto-resume suppression, cleared on the next user prompt): the user stopped, so their
		// queued follow-up waits for an explicit resume — even if an interleaving IRC wake turn has
		// since left a provider-valid tail.
		if (this.#advisorRoster.autoResumeSuppressed) return false;
		// Follow-up-only resume has no steer to inject, so Agent.continue() continues from the
		// existing context tail — which must itself be a valid provider tail. An injected
		// non-conversational tail (advisor card → `developer`, bash/python execution) would make
		// the first model call invalid, so leave the follow-up queued for the next explicit resume.
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#postPrompt.schedule(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		}
	}

	async #promptAgentInitiatedMessage(
		message: CustomMessage,
		options?: { acceptTerminalEmptyStop?: boolean },
	): Promise<void> {
		this.#inFlight.begin();
		try {
			const acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;
			if (acceptTerminalEmptyStop) {
				this.#resetPromptMaintenanceState();
			}
			this.#stopRetries.acceptTerminalEmptyStop = acceptTerminalEmptyStop;
			await this.agent.prompt(message);
			await this.#waitForPostPromptRecovery();
		} finally {
			this.#stopRetries.acceptTerminalEmptyStop = false;
			this.#endInFlight();
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @returns true iff this call synchronously started a new turn (awaited
	 * `agent.prompt`); false when the message was queued/appended without a turn
	 * — including when `triggerTurn` is downgraded because the client defers
	 * agent-initiated turns. Callers that must mirror the resulting `agent_end`
	 * use this to avoid acting on a turn that never ran.
	 */
	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			queueChipText?: string;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
		// A message that starts a turn is a turn: it reaches the same tools, so it waits for the same
		// hydration `prompt` waits for.
		if (options?.triggerTurn) await this.#startupHydration;
		const normalizedPayload = normalizeCustomMessagePayload<T>(message);
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? withQueueChipText(normalizedPayload.details, options.queueChipText)
				: normalizedPayload.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: normalizedPayload.customType,
			content: normalizedPayload.content,
			display: normalizedPayload.display,
			details,
			attribution: normalizedPayload.attribution,
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await normalizeAgentMessageImages(appMessage, this.model);
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, options?.triggerTurn ?? false);
				return false;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(normalizedAppMessage);
			} else {
				this.agent.steer(normalizedAppMessage);
			}
			this.#scheduleIdleQueueDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
					return false;
				}
				await this.#promptAgentInitiatedMessage(normalizedAppMessage, {
					acceptTerminalEmptyStop: options.acceptTerminalEmptyStop === true,
				});
				return true;
			}
			this.#appendCustomMessageToContext(normalizedAppMessage);
			return false;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
				return false;
			}
			await this.#promptAgentInitiatedMessage(normalizedAppMessage);
			return true;
		}

		this.#appendCustomMessageToContext(normalizedAppMessage);
		return false;
	}

	/**
	 * Send a user message through the prompt flow.
	 *
	 * Omitted `deliverAs` starts a turn when idle and queues as a steer while streaming.
	 * Explicit `deliverAs` queues without starting a turn in either state.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent | VideoContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images and videos
		let text: string;
		let images: ImageContent[] | undefined;
		let videos: VideoContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			videos = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else if (part.type === "image") {
					images.push(part);
				} else if (part.type === "video") {
					videos.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
			if (videos.length === 0) videos = undefined;
		}

		if (videos?.length && !this.model?.input.includes("video")) {
			throw new UnsupportedModelInputError(this.model?.id ?? "unknown", "video");
		}

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, videos, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, videos, "steer");
			return;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion.
		// `streamingBehavior: "steer"` preserves prompt-flow side effects during streaming while
		// covering the narrow race where a stream starts before prompt() acquires the turn.
		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
			videos,
			streamingBehavior: "steer",
		});
	}

	/** Clear queued messages and return the user-restorable ones (text plus any attached images).
	 *  Only user-authored messages (plain user turns, `attribution:"user"` custom like `/skill`) are
	 *  returned for editor restore. Other queued messages stay in the agent-core queues so a continuing
	 *  stream still delivers them — EXCEPT on `forInterrupt` (Esc+abort), where only advisor cards are
	 *  kept (abort() preserves them as visible advice) and every other
	 *  non-user steer (hidden goal/plan/budget, IRC/extension asides) is dropped, so abort()'s
	 *  #drainStrandedQueuedMessages can't auto-resume the run the user just interrupted (the drain only
	 *  fires while agent.hasQueuedMessages()). Plain Alt+Up dequeue preserves those non-user steers. */
	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		this.agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		return { steering, followUp };
	}

	/** Number of pending displayable messages (includes steering, follow-up, next-turn messages, and
	 *  prompts waiting for the agent to go idle). Reflects actual queued work (advisor cards
	 *  included) — feeds hasPendingMessages()/RPC and the empty-submit abort gate. The
	 *  user-restorable subset is surfaced by getQueuedMessages()/clearQueue(). */
	get queuedMessageCount(): number {
		return (
			this.agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			this.agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#pendingNextTurnMessages.length +
			this.#promptsWaitingOnIdle
		);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: this.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 * Steps over agent-authored queued messages (advisor cards, hidden/internal steers).
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};
		// Notices queue immediately before their user message, so dropping the popped
		// prompt means also dropping the contiguous hidden-user companions right before
		// it — companions of other queued prompts stay put.
		const removeWithCompanions = (queue: readonly AgentMessage[], userIndex: number): AgentMessage[] => {
			let start = userIndex;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
			const next = queue.slice();
			next.splice(start, userIndex - start + 1);
			return next;
		};
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			const removed = steering[fromSteer];
			this.agent.replaceQueues(removeWithCompanions(steering, fromSteer), followUp.slice());
			return toRestoredQueuedMessage(removed);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			const removed = followUp[fromFollowUp];
			this.agent.replaceQueues(steering.slice(), removeWithCompanions(followUp, fromFollowUp));
			return toRestoredQueuedMessage(removed);
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#config.skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Atomically replace the skills visible to this live session after a cwd re-scope. */
	replaceSkills(skills: readonly Skill[]): void {
		this.#skills = [...skills];
	}

	/** Replace every cwd-derived advisor input and rebuild advisor agents in that scope. */
	replaceProjectAdvisorScope(scope: ProjectAdvisorScope): void {
		this.#advisorRoster.replaceProjectScope(scope);
	}

	/**
	 * Non-fatal problems the operator must see, from every subsystem that raises one.
	 *
	 * A live channel, not a record: whatever surface the session is running under attaches to
	 * this and renders what arrives. It replaced `skillWarnings`, which was the same idea with no
	 * consumer, so a skill that failed to load produced a field nobody read.
	 */
	get operatorNotices(): OperatorNotices {
		return this.#operatorNotices;
	}

	/** The recorded todo board. Public: the RPC mode, the SDK, the todo slash
	 *  command and the interactive HUD all read and write it through here. */
	getTodoPhases(): TodoPhase[] {
		return this.#todo.phases();
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todo.setPhases(phases);
	}

	/** Currently-applied {@link TITLE_SYSTEM.md} override, or undefined when the
	 *  bundled prompt is in effect. Consumed by {@link InteractiveMode} so the
	 *  first-input title path and the replan refresh share one source. */
	get titleSystemPrompt(): string | undefined {
		return this.#replanTitle.systemPrompt;
	}

	/** Replace the title-generation system prompt override. Called by
	 *  {@link InteractiveMode.refreshTitleSystemPrompt} after the session cwd
	 *  changes (e.g. `/move` relocation) so the next replan refresh resolves
	 *  against the destination project's override. */
	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#replanTitle.systemPrompt = prompt;
	}

	// Auto-clear of completed/abandoned tasks was removed: the timer-driven
	// splice mutated the canonical todo board between tool calls, so the model
	// observed phase totals shrinking ("5 → 4") after marking tasks done. The
	// `tasks.todoClearDelay` setting is now inert; completed tasks survive
	// until the next explicit `todo` call removes them via `rm`/`drop`.

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * `reason` (e.g. `USER_INTERRUPT_LABEL`) rides the agent's `AbortController`
	 * and surfaces verbatim on the aborted assistant message's `errorMessage`, so
	 * the transcript can distinguish a deliberate user interrupt from an opaque
	 * abort. Omit it for internal/lifecycle aborts.
	 */
	async abort(options?: {
		goalReason?: GoalAbortReason;
		reason?: string;
		/** Internal `/compact` startup keeps the manual-compaction marker alive while aborting the active turn. */
		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisorRoster.suppressAutoResume();
		// Pull advisor concerns out of the steer/follow-up queues before any await so
		// the post-abort stranded-message drain can't auto-resume the run on them.
		// They are re-recorded as visible advice once the agent settles (below).
		const strandedAdvisorCards = userInterrupt ? this.#advisorRoster.extractQueuedCards() : [];
		// Session switch/compact paths disconnect first; explicit aborts should
		// leave any queued steer/follow-up visible for the user rather than
		// auto-starting a fresh turn during cleanup.
		this.#abortInProgress = true;
		try {
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			if (options?.preserveCompaction) {
				// Manual `/compact` installed its own abort controller before
				// this internal abort and must keep it alive (that marker is what makes
				// isCompacting report true during startup). Any in-flight
				// auto-compaction MUST still be cancelled, though: otherwise a
				// background maintenance pass races the manual run and both
				// appendCompaction/replaceMessages, double-rewriting session history.
				this.#compaction.abortAutomatic();
			} else {
				this.abortCompaction();
			}
			this.abortHandoff();
			this.abortBash();
			this.abortEval();
			// The advisors are reviewing the turn being stopped. Without this they keep
			// streaming after the interrupt, one model call per configured advisor, and
			// bill for a review of work that no longer exists.
			this.#advisorRoster.cancelInFlight(options?.reason ?? "primary aborted");
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
			// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
			// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
			// a subsequent prompt() can incorrectly observe the session as busy after an abort.
			this.#endInFlight(true);
			this.#sessionStopContinuationCount = 0;
			this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(
				message => message.customType !== "session-stop-continuation",
			);
			// Safety net: if the agent loop aborted without producing an assistant
			// message (e.g. failed before the first stream), the in-flight yield was
			// never resolved or rejected by the normal message_end path. Reject it now
			// so any requeue callback still fires and the queue stays consistent.
			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}
			// Re-record advisor concerns the interrupt would otherwise strand, as
			// visible/persisted advice without triggering a turn (the agent is idle
			// now): cards steered into the queue before the user stopped, plus any
			// that arrived via enqueueAdvice mid-abort and were parked hidden in
			// #pendingNextTurnMessages while the turn was still tearing down. Other
			// deferred next-turn context (non-advisor) stays queued, in order.
			const parkedAdvisorCards = this.#pendingNextTurnMessages.filter(isAdvisorCard);
			if (parkedAdvisorCards.length > 0) {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
			}
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#advisorRoster.preserveCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const nextDiscoverySessionToolNames = this.#discovery.mcpEnabled
			? [...this.#discovery.activeNonMCP(), ...this.#discovery.defaultMCPTools()]
			: undefined;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#config.extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#config.extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.#whileDisconnectedFromAgent(() =>
			this.#startNewTranscript(previousSessionFile, nextDiscoverySessionToolNames, options),
		);

		// Emit session_switch event with reason "new" to hooks
		if (this.#config.extensionRunner) {
			await this.#config.extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/** Saves or drops the outgoing transcript and starts an empty one. Runs with agent events detached. */
	async #startNewTranscript(
		previousSessionFile: string | undefined,
		nextDiscoverySessionToolNames: string[] | undefined,
		options: NewSessionOptions | undefined,
	): Promise<void> {
		await this.abort();
		this.#cancelOwnAsyncJobs();
		this.#providerSessions.closeAll("new session");
		this.agent.reset();
		if (options?.drop && previousSessionFile) {
			// Detach the advisor recorder feed and drain its writer BEFORE deleting the
			// old artifacts dir: `await this.abort()` only stops the primary, so a still-
			// running advisor turn could otherwise finish, emit `message_end`, and recreate
			// `<old>/__advisor.jsonl`. The roster's resetSessionState (after newSession) re-primes
			// the advisor and re-attaches the feed at the new session's path.
			await this.#advisorRoster.closeRecorders();
			try {
				await this.sessionManager.dropSession(previousSessionFile);
			} catch (err) {
				logger.error("Failed to delete session during /drop", { err });
			}
		} else {
			await this.sessionManager.flush();
		}
		await this.sessionManager.newSession(options);
		// The transcript changed under this session: release what the conversation it left held.
		await this.#endConversation();

		this.#checkpoint.clear();
		this.setTodoPhases([]);
		this.#providerSessions.freshId = undefined;
		this.#providerSessions.clearInheritedCacheKey("new-session");
		this.#providerSessions.sync();
		this.#memory.rekey();
		this.#resetMemoryContextForNewTranscript();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel, this.configuredThinkingLevel());
		this.sessionManager.appendServiceTierChange(serviceTierEntry(this.#serviceTierByFamily));
		if (nextDiscoverySessionToolNames) {
			await this.#toolActivation.apply(nextDiscoverySessionToolNames, { persistMCPSelection: false });
			if (this.getSelectedMCPToolNames().length > 0) {
				this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
		}
		this.#discovery.rememberSessionDefaults(this.sessionFile);

		this.#todo.resetForNewContext();
		this.#planMode.resetReference();
		this.#advisorRoster.resetSessionState();
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto", trigger?: SessionNameTrigger): Promise<boolean> {
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		return setSessionName.call(this.sessionManager, name, source, trigger);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#config.extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#config.extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Forking preflights artifacts and then publishes the new JSONL. If its
		// final publish fails, SessionManager may already have switched its in-memory
		// identity, while this agent still routes requests and memory on the old one.
		// Restore the last durable transcript instead of leaving a split identity.
		const beforeFork = this.sessionManager.captureState();
		let forkResult: Awaited<ReturnType<SessionManager["fork"]>>;
		try {
			forkResult = await this.sessionManager.fork();
		} catch (error) {
			if (
				this.sessionManager.getSessionId() !== beforeFork.sessionId ||
				this.sessionManager.getSessionFile() !== beforeFork.sessionFile
			) {
				try {
					// The failed fork abandoned its published-file layout. The next
					// persistence operation must revalidate the original file, including
					// any foreign writer's tail, before writing to it again.
					this.sessionManager.restoreState({ ...beforeFork, needsRewrite: true });
				} catch (restoreError) {
					throw new AggregateError([error, restoreError], "Fork failed and could not restore its original session");
				}
			}
			throw error;
		}
		if (!forkResult) {
			return false;
		}

		// SessionManager.fork already copied and checked inherited artifacts before
		// switching the session; a best-effort copy here could hide missing evidence.

		// Update agent session ID
		this.#providerSessions.freshId = undefined;
		this.#providerSessions.adoptInheritedCacheKey();
		this.#providerSessions.sync();
		this.#memory.rekey();
		this.#resetMemoryContextForNewTranscript();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#config.extensionRunner) {
			await this.#config.extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs). Active switches
	 * always take effect; if the current transcript is too large for the target
	 * model, the next prompt's compaction/error path owns that recovery instead
	 * of leaving the session pinned to the old model.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		slot = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ConfiguredThinkingLevel;
			persist?: boolean;
			currentContextTokens?: number;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = resolveActiveEditMode(this.settings, this.model);
		if (!this.#config.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(missingCredentialsMessage(model.provider, model.id, "the requested model"));
		}

		const targetModel = await this.#config.modelRegistry.refreshSelectedModelMetadata(model);

		this.#config.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#retry.clearActiveFallback();
		this.#setModelWithProviderSessionReset(targetModel);
		this.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, slot);
		if (options?.persist) {
			this.settings.setDefaultModel(
				this.#formatDefaultModelValue(targetModel, options.selector, options.thinkingLevel),
			);
		}
		AgentStorage.forAgentDir(this.settings.getAgentDir())?.recordModelUsage(
			`${targetModel.provider}/${targetModel.id}`,
		);

		// Apply the session override, explicit selector variant, saved per-model
		// default, or model default in that order.
		this.#thinking.reapplyForModel(options?.thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = resolveActiveEditMode(this.settings, this.model);
		if (!this.#config.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(missingCredentialsMessage(model.provider, model.id, "the requested model"));
		}

		const targetModel = await this.#config.modelRegistry.refreshSelectedModelMetadata(model);

		this.#config.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#retry.clearActiveFallback();
		this.#setModelWithProviderSessionReset(targetModel);
		this.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		AgentStorage.forAgentDir(this.settings.getAgentDir())?.recordModelUsage(
			`${targetModel.provider}/${targetModel.id}`,
		);

		this.#thinking.reapplyForModel(thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	async #getScopedModelsWithApiKey(): Promise<
		Array<{
			model: Model;
			thinkingLevel?: ConfiguredThinkingLevel;
			explicitThinkingLevel?: boolean;
		}>
	> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{
			model: Model;
			thinkingLevel?: ConfiguredThinkingLevel;
			explicitThinkingLevel?: boolean;
		}> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#config.modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = resolveActiveEditMode(this.settings, this.model);
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#config.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#retry.clearActiveFallback();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		AgentStorage.forAgentDir(this.settings.getAgentDir())?.recordModelUsage(
			`${next.model.provider}/${next.model.id}`,
		);

		// An unsuffixed scoped entry re-reads the current saved per-model default;
		// only an explicit scope suffix is a selector pin.
		this.#thinking.reapplyForModel(next.explicitThinkingLevel ? next.thinkingLevel : undefined);
		await this.#syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = resolveActiveEditMode(this.settings, this.model);
		const availableModels = this.#config.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#config.modelRegistry.getApiKey(nextModel, this.sessionId);
		if (!apiKey) {
			throw new Error(missingCredentialsMessage(nextModel.provider, nextModel.id, "the next model in the cycle"));
		}

		this.#config.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#retry.clearActiveFallback();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		AgentStorage.forAgentDir(this.settings.getAgentDir())?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#thinking.reapplyForModel();
		await this.#syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#config.modelRegistry.getAvailable();
		const patterns = this.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns);
	}

	/**
	 * True when the currently selected model's family is set to `priority` — the
	 * `/fast` on/off state for the active model. Returns false when no model is
	 * selected or the model exposes no service-tier family (e.g. Fireworks, which
	 * has its own Providers › Fireworks Tier toggle).
	 *
	 * For "is priority actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		return family ? this.#serviceTierByFamily[family] === "priority" : false;
	}

	/**
	 * True when `priority` is actually realized on the wire for the currently
	 * selected model (OpenAI/Google `service_tier`, direct Anthropic fast mode,
	 * or Fireworks priority). Returns false for tiers the active model can't
	 * realize and when no model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.model;
		return !!model && realizesPriorityServiceTier(this.#effectiveServiceTier(model), model);
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	#effectiveServiceTier(model: Model | undefined = this.model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.settings.get("providers.fireworksTier") === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#providerSessions.states);
		}
		this.#serviceTierByFamily = next;
		this.sessionManager.appendServiceTierChange(serviceTierEntry(next));
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * that family's `priority` tier, and turning it off returns the family to the
	 * tier the operator configured rather than to no tier at all. Returns `false`
	 * when the model has no service-tier family, so callers can report that fast
	 * mode is unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		if (!family) {
			this.emitNotice("info", "The current model has no service-tier control for /fast to toggle.", "priority");
			return false;
		}
		if (!enabled) {
			if (this.#serviceTierByFamily[family] !== "priority") return true;
			// Fast mode OVERRODE whatever this family was configured for, so turning
			// it off restores that baseline. Clearing outright silently spent the
			// operator's `tier.openai: flex` (a cheaper, slower tier) for the rest of
			// the session, and the change is persisted, so a resume kept the loss. A
			// configured `priority` is the one case where clearing is what was asked
			// for: there is no other baseline to go back to.
			const configured = buildServiceTierByFamily(
				this.settings.get("tier.openai"),
				this.settings.get("tier.anthropic"),
				this.settings.get("tier.google"),
			)[family];
			this.setServiceTierFamily(family, configured === "priority" ? undefined : configured);
			return true;
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Apply a live instrumentation change to settings, future model loops, and
	 * the session journal's lifecycle interval as one transition.
	 */
	setInstrumentationLevel(level: InstrumentationLevel): void {
		this.settings.set("session.instrumentation", level);
		this.agent.instrumentation = level;
		this.sessionManager.setInstrumentationLevel(level);
	}

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Strip image blocks from every message on the current branch and persist the rewrite. Returns
	 * `{ removed: 0 }` without a rewrite when the branch holds no image.
	 */
	dropImages(): Promise<{ removed: number }> {
		return this.#rewrites.dropImages();
	}

	/**
	 * Reduce context by dropping heavy content. `images` delegates to {@link dropImages}; `elide`
	 * replaces large tool results, large fenced or XML blocks, and duplicated tool results with
	 * placeholders that link an `artifact://` copy of the original. Zero counts when nothing is
	 * eligible.
	 */
	shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		return this.#rewrites.shake(mode, opts);
	}

	/**
	 * Elide earlier tool results byte-identical to a newer one. Lossless and model-free, so any
	 * compaction strategy may run it. Zero counts when nothing is redundant.
	 */
	dedupeRedundantToolResults(): Promise<{ toolResultsDropped: number; tokensFreed: number; artifactId?: string }> {
		return this.#rewrites.dedupeRedundantToolResults();
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		return this.#compaction.compact(customInstructions, options);
	}

	/**
	 * Cancel in-progress manual or automatic context maintenance.
	 */
	abortCompaction(): void {
		this.#compaction.abort();
		this.#sessionHandoff.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		// A port replaces the expanded span with a summary, which is the reduction
		// the idle pass exists for; compacting again on top of it would pay twice.
		if (await this.#compaction.portUnreadableRemoteCompaction()) return;
		await this.#compaction.runAutoCompaction("idle", false);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#sessionBranch.abortSummary();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#sessionHandoff.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#sessionHandoff.active;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		return this.#sessionHandoff.run(customInstructions, options);
	}

	async #runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		const model = this.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.settings.getGroup("compaction");
		// The local-estimate floor is applied in getContextBreakdown, so this is the exact number the
		// footline gauge shows.
		const contextTokens = this.getContextBreakdown({ contextWindow, pendingMessages: messages })?.usedTokens ?? 0;
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Auto-promote first: switching to a larger-context model avoids compacting
		// the history at all. The post-turn threshold path already promotes before
		// compacting; without this, the pre-prompt path would pre-empt promotion and
		// compact (summary) a session that should have just been promoted.
		if (await this.#promoteContextModel()) {
			logger.debug("Pre-prompt context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				model: `${model.provider}/${model.id}`,
			});
			return;
		}

		logger.debug("Pre-prompt context maintenance triggered by pending prompt size", {
			contextTokens,
			contextWindow,
			model: `${model.provider}/${model.id}`,
		});
		await this.#compaction.runAutoCompaction("threshold", false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
			phase: "pre_turn",
		});
	}

	/**
	 * Compact continuing tool-loop runs before the next provider request.
	 *
	 * `onTurnEnd` is the safe boundary: tool results for the just-finished turn
	 * are already paired in `activeMessages`, the live array the agent loop reads
	 * before its next model call. Before compacting, the just-finished turn is
	 * synchronously persisted if async message hooks have not reached the normal
	 * append path yet.
	 */
	async #maintainContextMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (
			signal?.aborted ||
			this.#isDisposed ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			!context?.willContinue
		)
			return;

		const lastAssistant = [...activeMessages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;
		if (this.#yields.findYieldMessage(activeMessages)) return;
		if (!(await this.#persistence.persistTurnForMidRunCompaction(context))) return;
		if (await this.#maybeHandoffExpensiveAgent(activeMessages)) return;

		const model = this.model;
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.midTurnEnabled === false) return;

		const billedContextTokens = calculateContextTokens(lastAssistant.usage);
		const storedContextTokens = this.#context.estimateStoredTokens();
		const contextTokens = compactionContextTokens(billedContextTokens, storedContextTokens);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Promote to a larger-context sibling before compacting, mirroring the
		// pre-prompt (#runPrePromptCompactionIfNeeded) and post-turn threshold
		// (`TurnContextCheck`) paths. Without this, a long mid-turn tool loop that
		// crosses the threshold compacts the history (and can hit the no-progress
		// dead-end on a single oversized turn) on a model that should have just
		// been promoted to a larger window instead.
		if (await this.#promoteContextModel()) {
			logger.debug("Mid-run context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				from: `${model?.provider}/${model?.id}`,
			});
			return;
		}

		const messagesBefore = activeMessages.length;
		await this.#compaction.runAutoCompaction("threshold", false, {
			autoContinue: false,
			suppressContinuation: true,
			triggerContextTokens: contextTokens,
			phase: "mid_turn",
		});

		if (signal?.aborted) return;
		const compactedMessages = this.agent.state.messages;
		if (compactedMessages !== activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...compactedMessages);
		}
		logger.debug("Mid-run compaction ran between provider calls", {
			contextTokens,
			contextWindow,
			strategy: compactionSettings.strategy,
			goalActive: this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active",
			messagesBefore,
			messagesAfter: activeMessages.length,
		});
	}

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	#discardAssistantTurn(assistantMessage: AssistantMessage): void {
		removeAssistantMessageFromActiveContext(this.agent, assistantMessage);
		this.#persistence.dropAssistantFromBranch(assistantMessage);
	}

	/**
	 * Durably record a terminal empty error turn (`stopReason: "error"` with no
	 * substantive content) that `MessagePersistence.persistIfMissing` skipped, so the
	 * session JSONL keeps a record of why the run stopped instead of ending at the
	 * last tool result. A no-op for non-empty/non-error turns and idempotent via
	 * the already-persisted guard; the turn is dropped from active context by the
	 * caller (or `isProviderRefusalMessage`/`isEmptyErrorTurn` filters) so it is
	 * never replayed on the wire. Used by the retry-lifecycle dead-ends and the
	 * non-retry terminal error tail.
	 */
	async #persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		await this.#persistence.waitFor(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#persistence.alreadyPersisted(message)) return;
		if (AIError.isContextOverflow(message, this.model?.contextWindow ?? undefined)) return;
		this.#persistence.append(message);
	}

	async #applyRewind(report: string, activeMessages?: AgentMessage[]): Promise<void> {
		const checkpointState = this.#checkpoint.state;
		if (!checkpointState) {
			return;
		}
		try {
			this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
				startedAt: checkpointState.startedAt,
			});
		} catch (error) {
			logger.warn("Rewind branch checkpoint missing, falling back to root", {
				error: errorMessage(error),
			});
			this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
		}

		const rewoundAt = new Date().toISOString();
		const details = { report, startedAt: checkpointState.startedAt, rewoundAt };
		this.sessionManager.appendCustomMessageEntry(
			"rewind-report",
			prompt.render(turnControlPrompts["turn-control/rewind-report"].text, { report }),
			false,
			details,
			"agent",
		);
		this.#checkpoint.markRewound({ report, startedAt: checkpointState.startedAt, rewoundAt }, activeMessages);
		const sessionContext = this.buildDisplaySessionContext();
		if (activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...sessionContext.messages);
		}
		await this.#toolActivation.restoreMCPSelections(sessionContext);
		this.agent.replaceMessages(activeMessages ?? sessionContext.messages);
		this.#advisorRoster.resetSessionState();
		this.#todo.syncFromBranch();
		this.#providerSessions.closeCodexForHistoryRewrite(this.model);
		this.#checkpoint.finish();
	}

	/**
	 * Render context shared by the eager todo/task preludes. `toolRefs` resolves each
	 * tool's wire name (matching `buildSystemPrompt`'s `toolRefs`) so the reminder names
	 * the tool the model actually sees when an extension renames it; `taskBatch` gates
	 * batch-call guidance that would steer toward a failing call shape when `task.batch`
	 * is off (the flat single-spawn schema rejects `tasks`/`context`).
	 */
	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#toolRegistry.get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName(TOOL.task), todo: wireName(TOOL.todo) },
			taskBatch: this.settings.get("agent.batch"),
		};
	}

	#createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		// Resolved against the agents the live task tool will actually accept: a
		// reminder to delegate, in a session where every agent is disabled, is an
		// instruction the model can only fail to follow.
		if (!resolveDelegation(this.settings, enabledAgentNames(this.#toolRegistry.get(TOOL.task))).required) {
			return undefined;
		}
		// Main agent only: agents keep `task` active (the parent only filters `todo`),
		// so a salient delegate-reminder there would amplify nested fan-out. Gate on the
		// resolved agent kind, not the id, so a top-level session with a custom `agentId`
		// still gets the reminder.
		if (this.#config.agentKind === "sub") return undefined;
		if (this.#planMode.enabled) return undefined;
		// First-message-only gates are skipped post-compaction (`promptText === undefined`),
		// where there is no fresh user message to suppress the reminder for.
		if (promptText !== undefined) {
			if (this.agent.state.messages.some(m => m.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.getActiveToolNames().includes(TOOL.task)) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(turnControlPrompts["turn-control/eager-task"].text, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Build the eager task/todo reminders to re-inject on the auto-continuation turn that
	 * follows a compaction. The first-message preludes are the oldest messages, so
	 * compaction summarizes them away and the agent silently loses the delegate-via-tasks
	 * and phased-todo guidance mid-work; this re-asserts them, reminder-only (the todo
	 * builder drops its forced tool_choice when `promptText` is undefined). Each builder
	 * still applies its own mode / agent-kind / plan-mode / tool-active / surviving-todo
	 * gates, so an empty array means nothing currently warrants a nudge.
	 */
	#buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.#todo.eagerPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.#createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}

	/**
	 * Switch to a larger-context sibling when context promotion is enabled and a
	 * target with a strictly larger window (and a usable key) exists. Returns true
	 * when the model was switched, so the caller can retry without compacting.
	 * Message-independent core shared by the post-turn check ({@link TurnContextCheck})
	 * and the pre-prompt threshold path
	 * ({@link #runPrePromptCompactionIfNeeded}).
	 */
	async #promoteContextModel(): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: errorMessage(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#config.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = contextPromotionTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#config.modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#providerSessions.closeForModelSwitch(currentModel, model);
			if (!modelsAreEqual(currentModel, model)) {
				this.#providerSessions.clearInheritedCacheKey("model-change");
			}
		}
		this.agent.setModel(model);

		// Re-evaluate append-only context mode — provider or setting may have changed
		this.#syncAppendOnlyContext(model);
	}

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext");
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	/**
	 * The `defaultModel` value a persisted switch writes: the chosen selector, carrying an explicit
	 * effort suffix when one was passed or when the configured primary already named one.
	 */
	#formatDefaultModelValue(
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ConfiguredThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const [primary] = normalizeModelPatternList(this.settings.get("defaultModel"));
		const thinkingLevel = extractExplicitThinkingSelector(primary, {
			isLiteralModelId: (provider, id) => this.#config.modelRegistry.find(provider, id) !== undefined,
		});
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled");
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retry.abort();
	}

	/**
	 * Prompt the agent, waiting out a run that is still in flight. A hidden
	 * continuation queued from an `agent_end` handler lands here while the turn
	 * it reacts to is still unwinding, so its first `prompt` is refused as busy.
	 *
	 * `generation` is the prompt cycle the caller started in. The wait ends when
	 * the agent is idle, and a user interrupt is one way it gets there: `abort()`
	 * bumps the generation before the loop settles, and a prompt that woke on
	 * that settle would start the very turn the user stopped. The autoresearch
	 * stall nudge did exactly that -- Escape ended the run and the nudge queued a
	 * turn earlier restarted it three milliseconds later. A stale generation
	 * returns without prompting; the messages are dropped like every other
	 * setup-time bail-out in `#promptWithMessage`.
	 */
	async #promptAgentWithIdleRetry(
		messages: AgentMessage[],
		options: { toolChoice?: ToolChoice } | undefined,
		generation: number,
	): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				this.#promptsWaitingOnIdle += 1;
				try {
					await this.agent.waitForIdle();
				} finally {
					this.#promptsWaitingOnIdle -= 1;
				}
				if (this.#promptGeneration !== generation) {
					return;
				}
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retry.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled");
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from agent state and re-attempts with a fresh retry budget.
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.isStreaming || this.isCompacting || this.isRetrying) return false;
		return this.#retry.retryLastFailedTurn();
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();

		if (this.#config.extensionRunner?.hasHandlers("user_bash")) {
			const hookResult = await this.#config.extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordBashResult(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		return await this.#executions.runBash(async signal => {
			const result = await executeBashCommand(command, {
				onChunk,
				signal,
				sessionKey: this.sessionId,
				cwd,
				timeout: clampTimeout(TOOL.bash, undefined, this.settings.get("tools.maxTimeout")) * 1000,
				onMinimizedSave: originalText => saveBashOriginalArtifact(this.sessionManager, originalText),
				useUserShell: options?.useUserShell,
			});
			this.recordBashResult(command, result, options);
			return result;
		});
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			signal: result.signal,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		this.#executions.record(bashMessage);
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this.#executions.abortBash();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#executions.bashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#executions.hasDeferredBash;
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();
		this.assertEvalExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			if (this.#config.extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await this.#config.extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertEvalExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Use the same session ID as eval's Python backend for kernel sharing.
			const sessionId = this.getEvalSessionId();
			const { executePython: executePythonCommand } = await loadPythonExecutor();
			this.assertEvalExecutionAllowed();
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.#evalKernelOwnerId,
				kernelMode: this.settings.get("python.kernelMode"),
				interpreter: this.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackEvalExecution(execution, abortController);
	}

	assertEvalExecutionAllowed(): void {
		this.#executions.assertEvalAllowed();
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		return this.#executions.trackEval(execution, abortController);
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		this.#executions.record(pythonMessage);
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		this.#executions.abortEval();
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#executions.evalRunning;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#executions.hasDeferredPython;
	}

	// =========================================================================
	// IRC Delivery
	// =========================================================================

	/**
	 * Surfaces and consumes pending IRC incoming records before the next model
	 * step can inject them automatically.
	 *
	 * Tool results already expose the formatted body to the model. Leaving the
	 * same record in either pending IRC queue would deliver it a second time at
	 * the next step boundary — including on `peek`, which is why inbox peeks
	 * also drain here.
	 */
	drainPendingIrcInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		return this.#ircInbox.takeIncoming(agentId, opts);
	}

	/**
	 * Deliver an IRC message into this session (recipient side; called by the
	 * IrcBus). Emits the `irc_message` session event for UI cards and injects
	 * the rendered message into the model's context as an `irc:incoming`
	 * custom message:
	 *
	 * - mid-turn → queued on the aside channel and folded in at the next step
	 *   boundary (non-interrupting, like async-result deliveries) → "injected";
	 * - idle in plan mode → appended into context without waking an autonomous
	 *   turn (convergence stays user-driven) → "injected";
	 * - idle → starts a real turn with the message so the recipient wakes
	 *   → "woken".
	 *
	 * Never blocks on the recipient's turn: the wake turn is fire-and-forget.
	 *
	 * When the sender expects a reply (`send await:true`) and this session
	 * cannot produce a real reply turn in time — mid-turn with async execution
	 * disabled (the next step boundary may be gated on the sender's own batch
	 * finishing), or idle in plan mode (wake turns are suppressed) — an
	 * ephemeral side-channel auto-reply is generated from the current context
	 * (the old `respondAsBackground` path) and sent back over the bus on this
	 * agent's behalf.
	 */
	async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#isDisposed) {
			throw new Error("Recipient session is disposed.");
		}
		if (msg.completion) {
			const completionId = msg.completion.id;
			if (
				this.sessionManager
					.getEntries()
					.some(
						entry =>
							entry.type === "custom_message" &&
							entry.customType === "task:continuation" &&
							Reflect.get(entry.details ?? {}, "completionId") === completionId,
					)
			) {
				await this.sessionManager.ensureOnDisk();
				await this.sessionManager.sync();
				return "injected";
			}
		}
		if (!this.#ircContinuations) {
			this.#ircContinuations = new IrcContinuationOutbox(this.sessionManager);
		}
		if (!msg.completion && this.#ircContinuations.hasPhase(msg.id)) {
			await this.sessionManager.ensureOnDisk();
			await this.sessionManager.sync();
			return "injected";
		}
		// Auto-reply eligibility: the sender is blocked on an answer and this
		// session cannot produce a real reply turn in time — either mid-turn with
		// async execution disabled (no step boundary until the sender's own batch
		// ends), or idle in plan mode (autonomous wake turns are suppressed).
		const planModeIdle = !this.isStreaming && this.#planMode.enabled;
		const autoReply =
			(opts?.expectsReply ?? false) && ((this.isStreaming && !this.settings.get("async.enabled")) || planModeIdle);
		const registry = AgentRegistry.global();
		const identity = registry.actorContext(msg.to);
		const relation = registry.relationTo(msg.to, msg.from);
		const record: CustomMessage = {
			role: "custom",
			customType: msg.completion ? "task:continuation" : "irc:incoming",
			content: prompt.render(sideChannelPrompts["side-channel/irc-incoming"].text, {
				from: msg.from,
				message: msg.body,
				source: "agent",
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: this.isStreaming,
				...identity,
				parentId: identity.parentId ?? "unknown",
				ancestorIds: identity.ancestorIds.join(", ") || "none verified",
				relation,
				parentUpdate: relation === "parent",
				phaseId: msg.id,
				completionHandle: msg.completion?.handle,
				completionSource: msg.completion?.resultSource,
			}),
			display: true,
			details: {
				id: msg.id,
				from: msg.from,
				message: msg.body,
				source: "agent",
				relation,
				...identity,
				actor: { source: "agent", relation, ...identity },
				...(msg.completion
					? {
							completionId: msg.completion.id,
							phaseId: msg.completion.phaseId,
							handle: msg.completion.handle,
							resultSource: msg.completion.resultSource,
						}
					: {}),
				...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
			},
			attribution: "agent",
			timestamp: msg.ts,
		};
		if (msg.completion) {
			// Persist before acknowledging delivery. A sender crash may replay the same result.
			this.#appendCustomMessageToContext(record);
			this.sessionManager.flushSync();
			await this.sessionManager.ensureOnDisk();
			await this.sessionManager.sync();
			void this.#emitSessionEvent({ type: "irc_message", message: record });
			if (this.isStreaming) {
				this.#ircInbox.queueCompletionWake(record);
				return "injected";
			}
			if (this.#planMode.enabled) return "injected";
			// The record is already in context; wake on it without persisting a second copy.
			await this.#wakeForIrc([record]);
			return "woken";
		}
		void this.#emitSessionEvent({ type: "irc_message", message: record });
		if (relation === "parent") {
			if (!this.#ircContinuations) {
				this.#ircContinuations = new IrcContinuationOutbox(this.sessionManager);
			}
			const outbox = this.#ircContinuations;
			if (this.#ircActivePhase || outbox.unfinished().length > 0) {
				// Preserve both phase boundaries and the order of input retained across a restart.
				outbox.begin(msg.id, record);
				await this.sessionManager.ensureOnDisk();
				await this.sessionManager.sync();
				if (!this.#ircActivePhase) await this.replayIrcContinuations();
				return "injected";
			}
		}
		if (this.isStreaming) {
			if (relation === "parent") {
				this.agent.steer({
					role: "user",
					content: prompt.render(steeringPrompts["steering/parent-irc"].text, {
						from: msg.from,
						selfId: msg.to,
						message: msg.body,
					}),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#ircInbox.queueInterrupt(record);
			}
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}
		// Plan mode: record into context but do not wake an autonomous turn.
		if (this.#planMode.enabled) {
			this.#appendCustomMessageToContext(record);
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}
		// Idle: wake a real turn so the recipient responds (shared with the stranded-aside resume).
		await this.#wakeForIrc([record]);
		return "woken";
	}

	/** Replay durable result deliveries on a retained agent's next native activation. */
	async replayIrcContinuations(settling = false): Promise<void> {
		if (!this.#ircContinuations) {
			this.#ircContinuations = new IrcContinuationOutbox(this.sessionManager);
		}
		const outbox = this.#ircContinuations;
		await outbox.flush(async completion => {
			const registry = AgentRegistry.global();
			const context = registry.actorContext(completion.agentId);
			// Only this agent's verified lineage can receive its result, never a foreign peer.
			for (const parentId of context.ancestorIds) {
				const parent = registry.get(parentId);
				if (!parent || parent.status === "aborted") continue;
				const receipt = await IrcBus.global().send(
					{ from: completion.agentId, to: parentId, body: completion.output },
					{
						completion: {
							version: 1,
							id: completion.id,
							handle: completion.handle,
							phaseId: completion.phaseId,
							resultSource: completion.resultSource,
						},
					},
				);
				if (receipt.outcome !== "failed") return true;
			}
			return false;
		});
		if (
			this.agent.state.isStreaming ||
			(!settling && this.isStreaming) ||
			this.#planMode.enabled ||
			this.#ircActivePhase
		)
			return;
		const consumed = new Set(
			this.sessionManager
				.getEntries()
				.flatMap(entry =>
					entry.type === "custom" &&
					entry.customType === "irc:completion-consumed" &&
					typeof entry.data === "string"
						? [entry.data]
						: [],
				),
		);
		const pendingCompletion = this.agent.state.messages.find(
			message =>
				message.role === "custom" &&
				message.customType === "task:continuation" &&
				typeof Reflect.get(message.details ?? {}, "completionId") === "string" &&
				!consumed.has(Reflect.get(message.details ?? {}, "completionId")),
		);
		if (pendingCompletion?.role === "custom") {
			const from = Reflect.get(pendingCompletion.details ?? {}, "from");
			const selfId = this.#config.agentId;
			if (
				selfId &&
				typeof from === "string" &&
				AgentRegistry.global().actorContext(from).ancestorIds.includes(selfId)
			) {
				await this.#wakeForIrc([pendingCompletion], true);
				return;
			}
		}
		const retained = outbox.unfinished().find(record => {
			const from = Reflect.get(record.details ?? {}, "from");
			const selfId = this.#config.agentId;
			if (typeof from !== "string" || selfId === undefined) return false;
			const registry = AgentRegistry.global();
			return record.customType === "task:continuation"
				? registry.actorContext(from).ancestorIds.includes(selfId)
				: registry.relationTo(selfId, from) === "parent";
		});
		if (retained) await this.#wakeForIrc([retained], true);
	}

	/**
	 * Generate and deliver an ephemeral auto-reply to `msg` on this agent's
	 * behalf: a no-tools side-channel turn over the current history (same
	 * pipeline as `/btw`), recorded into this session as an `irc:autoreply`
	 * aside so the model knows what was said for it, and sent back to the
	 * sender as a regular bus message (`replyTo: msg.id`) so their parked
	 * `wait`/`await:true` resolves. Failures only log — the sender then hits
	 * its normal wait timeout.
	 */
	async #runIrcAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const registry = AgentRegistry.global();
			const identity = registry.actorContext(msg.to);
			const relation = registry.relationTo(msg.to, msg.from);
			const { replyText } = await this.runEphemeralTurn({
				promptText: prompt.render(sideChannelPrompts["side-channel/irc-autoreply"].text, {
					from: msg.from,
					...identity,
					parentId: identity.parentId ?? "unknown",
					ancestorIds: identity.ancestorIds.join(", ") || "none verified",
					relation,
					parentUpdate: relation === "parent",
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#isDisposed) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#emitSessionEvent({ type: "irc_message", message: record });
			// Asides drain at the next step boundary; anything left over is
			// flushed at the start of the next prompt (#flushPendingIrcAsides).
			this.#ircInbox.queueAside(record);
			// `from` must be the id the sender addressed (msg.to) so their
			// from-filtered waiter matches.
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: errorMessage(error) });
		}
	}
	/**
	 * Persist one directional, content-free IRC delivery event as session
	 * metadata. Custom metadata survives JSONL reload but never enters context.
	 * Called only by the bus's exactly-once record boundary.
	 */
	recordIrcDeliveryTelemetry(facts: IrcPersistedDeliveryFacts): void {
		const detail = sessionTelemetryDetail(this.settings.get("session.instrumentation"), "agent-communication");
		if (detail !== "rich" && detail !== "ultra") return;
		const telemetry: IrcPersistedDeliveryTelemetry = {
			...projectIrcDeliveryTelemetry(detail, facts),
			messageId: facts.messageId,
			direction: facts.direction,
		};
		this.sessionManager.appendCustomEntry("irc:delivery-telemetry", telemetry);
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Called by the IrcBus to surface
	 * agent↔agent traffic on the main session.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current model, system prompt
	 * and history, without modifying either; see {@link runEphemeralTurn}. Used by `/btw`, `/omfg`,
	 * the idle recap, the IRC auto-reply and the composer prediction.
	 */
	runEphemeralTurn(args: EphemeralTurnArgs): Promise<EphemeralTurnResult> {
		return runEphemeralTurn(
			{
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				sessionId: this.sessionId,
				messages: this.messages,
				agent: this.agent,
				preferWebsockets: this.#config.preferWebsockets,
				providerSessionStates: this.#providerSessions.states,
				secrets: this.#secrets,
				sideStreamFn: this.#sideStreamFn,
				convertMessagesToLlm: (messages, signal) => this.convertMessagesToLlm(messages, signal),
				prepareSimpleStreamOptions: (options, provider) => this.prepareSimpleStreamOptions(options, provider),
				resolveApiKey: (model, sessionId) => this.#config.modelRegistry.resolver(model, sessionId),
				effectiveServiceTier: model => this.#effectiveServiceTier(model),
			},
			args,
		);
	}

	/** Append a custom message to the model's context and the session file without starting a turn. */
	#appendCustomMessageToContext<T>(message: CustomMessage<T>): void {
		this.agent.appendMessage(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution ?? "agent",
		);
	}

	/**
	 * Persist any IRC asides that missed their step-boundary injection (the
	 * message landed after the turn's last aside drain). Called at the start
	 * of the next prompt so the model still sees them.
	 */
	#flushPendingIrcAsides(): void {
		const records = this.#takeIrcRecords();
		for (const record of records) {
			// emitExternalEvent on message_end appends to agent state and dispatches
			// to all session listeners, which in turn handle TUI rendering and
			// sessionManager persistence via #handleAgentEvent.
			this.agent.emitExternalEvent({ type: "message_start", message: record });
			this.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	/**
	 * Every waiting IRC record, leaving the queues empty. Notices from other sessions are acknowledged
	 * here, at the moment they leave the inbox for the turn, so a notice is delivered only once it is in
	 * the turn. A crash before this point leaves the claim in `claimed/`, and it is offered again.
	 */
	#takeIrcRecords(): CustomMessage[] {
		const records = this.#ircInbox.takeAll();
		const noticeIds: string[] = [];
		for (const record of records) {
			const id = record.customType === "session:notice" ? Reflect.get(record.details ?? {}, "id") : undefined;
			if (typeof id !== "string") continue;
			noticeIds.push(id);
			this.#noticesInInbox.delete(id);
			this.#noticesSeen.add(id);
			if (this.#noticesSeen.size > MAX_SEEN_NOTICE_IDS) {
				for (const oldest of this.#noticesSeen) {
					this.#noticesSeen.delete(oldest);
					break;
				}
			}
		}
		if (noticeIds.length === 0) return records;
		try {
			ackSessionNotices(this.sessionManager.getSessionId(), noticeIds);
		} catch (error) {
			logger.warn("Acknowledging session notices failed", { error: errorMessage(error) });
		}
		return records;
	}

	/**
	 * Claim the notices other sessions queued for this one (`launch/session-notices.ts`) and hand each
	 * to the addressed session as informational `session:notice` records, never as parent instructions
	 * to its lanes. The addressed session can decide whether any verified information affects its work.
	 *
	 * Runs at the start of every prompt and, at most once a second, at each step boundary. Only the
	 * driving session reads its queue. A claim offered again is dropped here by notice id.
	 */
	#pullSessionNotices(force: boolean): void {
		if (this.#isDisposed || this.#isSpawned) return;
		const now = Date.now();
		if (!force && now - this.#lastNoticeScanAt < SESSION_NOTICE_SCAN_MS) return;
		this.#lastNoticeScanAt = now;
		const sessionId = this.sessionManager.getSessionId();
		let notices: SessionNotice[];
		try {
			registerSessionNoticeQueue(sessionId);
			notices = claimSessionNotices(sessionId);
		} catch (error) {
			logger.warn("Reading session notices failed", { error: errorMessage(error) });
			return;
		}
		for (const notice of notices) {
			if (this.#noticesInInbox.has(notice.id)) continue; // claimed again while still waiting for its turn
			if (this.#noticesSeen.has(notice.id)) {
				try {
					ackSessionNotices(sessionId, [notice.id]); // an earlier acknowledgement did not land
				} catch {}
				continue;
			}
			const record: CustomMessage = {
				role: "custom",
				customType: "session:notice",
				content: prompt.render(sideChannelPrompts["side-channel/irc-incoming"].text, {
					from: notice.from,
					message: formatNoticeMessage(notice, Date.now()),
					source: "external-session notice",
					selfId: this.#config.agentId ?? sessionId,
					relation: "external-session notice",
					parentId: "not agent lineage",
					ancestorIds: "not agent lineage",
					parentUpdate: false,
					phaseId: notice.id,
				}),
				display: true,
				details: { id: notice.id, from: notice.from, message: notice.body, source: "external-session-notice" },
				attribution: "agent",
				timestamp: notice.ts,
			};
			void this.#emitSessionEvent({ type: "irc_message", message: record });
			this.#ircInbox.queueAside(record);
			this.#noticesInInbox.add(notice.id);
		}
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file; see {@link SessionSwitch.switchTo}.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	switchSession(sessionPath: string): Promise<boolean> {
		return this.#sessionSwitch.switchTo(sessionPath);
	}

	/**
	 * Create a branch from a user message entry; see {@link SessionBranch.branch}.
	 *
	 * @returns the selected message's text for editor pre-fill, and whether a hook cancelled
	 */
	branch(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		return this.#sessionBranch.branch(entryId);
	}

	/** Branch at the live leaf with a `/btw` exchange appended; see {@link SessionBranch.branchFromBtw}. */
	branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		return this.#sessionBranch.branchFromBtw(question, assistantMessage, leafId, sessionId);
	}

	/**
	 * Navigate to a different node in the session tree, in the same session file; see
	 * {@link SessionBranch.navigateTree}.
	 */
	navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<TreeNavigationResult> {
		return this.#sessionBranch.navigateTree(targetId, options);
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		return this.#sessionBranch.userMessages();
	}

	/**
	 * Get session statistics.
	 *
	 * Spend covers the messages the latest compaction summarized away as well as
	 * the live context. Summing the context alone silently un-spends every turn
	 * behind the boundary: after one compaction `/session` reported half the cost
	 * the session had actually paid, and goal mode reads the same total as its
	 * token budget, so a long run bought itself budget back every time it
	 * compacted. `contextUsage` below still reports the LIVE context: what sits in
	 * the window and what has been spent are two different questions with one
	 * owner each.
	 */
	getSessionStats(): SessionStats {
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			...this.#sessionSpend(),
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Spend over the messages the compaction in effect summarized away, oldest first, followed by
	 * the live context.
	 *
	 * The summarized messages are gone from the live context by design and they are still what this
	 * session paid for. Everything from the boundary forward is already in the context, so nothing
	 * is counted twice, and an earlier compaction's own summary is an ENTRY rather than a message,
	 * so a session that compacted several times counts each range once. The stored branch is also
	 * what a resume reads, so the total survives a restart.
	 */
	#sessionSpend(): SessionSpend {
		const branch = this.sessionManager.getBranch();
		const boundary = compactedHistoryEnd(branch);
		return this.#spendLedger.total(branch, boundary, this.state.messages);
	}

	/** The token totals goal accounting charges against a budget. */
	#goalUsage(): GoalTokenUsage {
		const { input, output, cacheRead, cacheWrite } = this.#sessionSpend().tokens;
		return { input, output, cacheRead, cacheWrite };
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		return this.#context.breakdown(options);
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		return this.#context.usage(options);
	}

	/**
	 * Context usage with the non-message size the newest usage anchor recorded standing in for a
	 * measurement, so reading it builds no tool schema. Undefined when no anchor recorded that size or
	 * a prompt is in flight. See `ContextAccounting.restingUsage`.
	 */
	getRestingContextUsage(): ContextUsage | undefined {
		return this.#context.restingUsage();
	}

	/**
	 * Monotonic counter that changes whenever the in-flight pending context
	 * snapshot is set or cleared. Status-line context memoization keys on this so
	 * a value computed mid-turn cannot persist after the turn ends/aborts.
	 */
	get contextUsageRevision(): number {
		return this.#context.revision;
	}

	/** Usage reports for every stored credential, each provider's base URL resolved as requests resolve it. */
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#usage.fetchReports(signal);
	}

	/**
	 * Redeem one saved rate-limit reset (OpenAI Codex or Anthropic) for a specific account. Powers the
	 * `/usage reset` command. Never throws for business outcomes; inspect the returned `code`.
	 */
	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#usage.redeem(target, signal);
	}

	/**
	 * List saved rate-limit resets per stored OpenAI Codex and Anthropic account, fetched live from
	 * each provider's reset route (bypasses the usage cache). Powers the `/usage reset` account selector.
	 */
	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#usage.listResetCredits(signal);
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		// Public HTML export ships in the veyyon brand palette (collab-web
		// pink/purple), matching share.veyyon.dev — not the host's terminal theme.
		// Callers who want a themed export can pass `palette: "theme"` with
		// `themeName` directly to `exportSessionToHtml`.
		// Lazy by necessity, not by oversight. `export/html` text-imports the
		// gitignored `tool-views.generated.js`, and Bun resolves that text import
		// when an importer merely parses, so a static import here turns a missing
		// generated file into a boot failure rather than an export failure
		// (source-install launch failure, 2026-07-24). This is the one carve-out
		// from the no-inline-import rule and it stays.
		const { exportSessionToHtml } = await import("../export/html");
		return exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			palette: "web",
			obfuscator: this.settings.get("share.redactSecrets") ? this.providerRedactor : undefined,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = lastCopyCandidateAssistantMessage(this.messages);
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return lastCopyCandidateAssistantMessage(this.messages) !== undefined;
	}

	/**
	 * Get text content of the most recent visible handoff message.
	 * Fresh handoff sessions store the handoff context as a custom message, not
	 * an assistant message, so callers that copy the "last" message can use this
	 * as a fallback before the new session has an assistant response.
	 */
	getLastVisibleHandoffText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "custom") continue;

			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;

			if (typeof customMessage.content === "string") {
				return customMessage.content.trim() || undefined;
			}

			let text = "";
			for (const content of customMessage.content) {
				if (content.type === "text") {
					text += content.text;
				}
			}
			return text.trim() || undefined;
		}

		return undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export: system
	 * prompt, model/thinking config, tool inventory, and the full transcript
	 * rendered with markdown role headings (`## User`, `## Assistant`,
	 * `### Tool Call`/`### Tool Result`).
	 */
	formatSessionAsText(): string {
		const activeModel = this.model;
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinking.level,
			tools: this.agent.state.tools,
			inlineToolDescriptors: activeModel ? this.#resolvePruneToolDescriptions(activeModel) : false,
		});
	}

	/**
	 * Dump the current session's LLM-facing request context as JSON to a
	 * auto-named file in `os.tmpdir()`. This is the synchronous
	 * `convertToLlm`-boundary snapshot — system prompt, tools (wire schemas),
	 * thinking/service tier, and converted messages — with no network round-trip
	 * and no arming flag, so advisor/side requests cannot intercept it.
	 *
	 * The file persists on disk and may contain the same raw context/secrets
	 * as `/dump`; treat the path accordingly.
	 *
	 * @returns the written file path, or `undefined` when there are no messages.
	 */
	async dumpLlmRequestToTmpDir(): Promise<string | undefined> {
		const messages = this.messages;
		if (messages.length === 0) return undefined;
		const llmMessages = await this.convertMessagesToLlm(messages);
		const payload = {
			model: this.agent.state.model ?? null,
			thinkingLevel: this.#thinking.level ?? null,
			serviceTier: serviceTierEntry(this.#serviceTierByFamily),
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				...(tool.strict !== undefined ? { strict: tool.strict } : {}),
				...(tool.customWireName ? { customWireName: tool.customWireName } : {}),
			})),
			messages: llmMessages,
		};
		const filePath = path.join(os.tmpdir(), `veyyon-llm-request-${Snowflake.next()}.json`);
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return filePath;
	}

	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		return this.#advisorRoster.setEnabled(enabled);
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorRoster.enabled);
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		return this.#advisorRoster.applyConfigs(advisors, sharedInstructions);
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorRoster.enabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisorRoster.active;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set, built here if no advisor has reviewed a turn yet; a tool
	 * whose optional factory returns null (e.g. lsp with no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): Promise<string[]> {
		return this.#advisorRoster.availableToolNames();
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisorRoster.firstAgent();
	}

	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		return this.#advisorRoster.stats();
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		return formatAdvisorStatus(this.getAdvisorStats());
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		return this.#advisorRoster.formatHistoryAsText(options);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#config.extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#config.extensionRunner;
	}
}
