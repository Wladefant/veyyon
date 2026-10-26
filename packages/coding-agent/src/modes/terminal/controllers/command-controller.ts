import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { UsageReport } from "@veyyon/ai";
import type { CompactMode } from "@veyyon/kernel/session/compact-modes";
import type { NewSessionOptions } from "@veyyon/kernel/session/session-entries";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "@veyyon/kernel/session/shake-types";
import { Loader, type OverlayHandle, Spacer, Text } from "@veyyon/tui";
import {
	APP_NAME,
	CHANGELOG_URL,
	directoryExists,
	errorMessage,
	formatDuration,
	isAbortError,
	logger,
	Snowflake,
	stripAnsi,
} from "@veyyon/utils";
import { advisorStatusNextStep } from "../../../advisor/messages";
import { type CustomShareResult, type LoadedCustomShare, loadCustomShare } from "../../../export/custom-share";
import { shareSession } from "../../../export/share";
import type { CompactOptions } from "../../../extensibility/extensions/types";
import type * as hindsightModule from "../../../memory/hindsight";
import { compactionActionLabel, resolveCompactionKind } from "../../../presentation/summary-builder";
import type { AsyncJobSnapshotItem } from "../../../session/agent-session-types";
import { type AttachableSession, backgroundHandoff } from "../../../session/background-sessions";
import { computeContextBreakdown } from "../../../session/context-usage";
import type { OutputSummary } from "../../../session/streaming-output";
import { getSymbolTheme, theme } from "../../../theme/theme";
import { outputMeta } from "../../../tools/core/output-meta";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../../tools/core/path-utils";
import { replaceTabs, truncateToWidth } from "../../../tools/core/render-utils";
import { copyToClipboard } from "../../../utils/clipboard";
import { openPath } from "../../../utils/open";
import { setSessionTerminalTitle } from "../../../utils/title-generator";
import { ComposerLoader } from "../components/composer/composer-loader";
import { MoveOverlay, type MoveOverlayResult } from "../components/selectors/move-overlay";
import { BashExecutionComponent } from "../components/transcript/bash-execution";
import { EvalExecutionComponent } from "../components/transcript/eval-execution";
import { mountTranscriptBlock, transcriptBlockText } from "../components/transcript/transcript-block-chrome";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import type { InteractiveModeContext } from "../types";
import { renderContextUsage } from "../utils/context-usage";
import { buildHotkeysMarkdown } from "../utils/hotkeys-markdown";
import { buildToolsMarkdown } from "../utils/tools-markdown";
import { showMarkdownPanel } from "./command-controller-shared";
import { MemoryCommandController } from "./memory-command-controller";
import { renderSessionInfo } from "./session-info-view";
import { renderUsageReports } from "./usage-report-view";
/**
 * The slice of the interactive context this controller uses: 36 members of the
 * 215 `InteractiveModeContext` requires. See `CollabHostContext` for why the
 * full interface cannot be used as a parameter type: nothing but the real TUI
 * can satisfy it, so every test has to cast a stub into place unchecked.
 */
export type CommandControllerContext = Pick<
	InteractiveModeContext,
	| "attachMainSession"
	| "bashComponent"
	| "chatContainer"
	| "clearTransientSessionUi"
	| "clearWorkingLoader"
	| "createNextSession"
	| "editor"
	| "editorContainer"
	| "flushCompactionQueue"
	| "focusActiveEditorArea"
	| "initHooksAndCustomTools"
	| "keybindings"
	| "lspServers"
	| "mcpManager"
	| "pendingBashComponents"
	| "pendingMessagesContainer"
	| "pendingPythonComponents"
	| "present"
	| "pythonComponent"
	| "rebuildChatFromMessages"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetObserverRegistry"
	| "resetTranscript"
	| "session"
	| "sessionManager"
	| "settings"
	| "showError"
	| "showHookConfirm"
	| "showHookInput"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "statusLine"
	| "ui"
	| "updateEditorBorderColor"
>;

let hindsight: Promise<typeof hindsightModule> | undefined;
/** The Hindsight mental-model helpers load on the first `/memory mm` call, not with the controller. */
function loadHindsight(): Promise<typeof hindsightModule> {
	hindsight ??= import("../../../memory/hindsight");
	return hindsight;
}

/**
 * The instructions and options one compaction runs with. The slash path passes `mode` positionally; the extension
 * path carries it inside the options object, which a positional mode overrides on a copy.
 */
function compactionRequest(
	customInstructionsOrOptions: string | CompactOptions | undefined,
	mode: CompactMode | undefined,
): { instructions: string | undefined; options: CompactOptions | undefined } {
	const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
	const baseOptions =
		customInstructionsOrOptions && typeof customInstructionsOrOptions === "object"
			? customInstructionsOrOptions
			: undefined;
	if (!baseOptions) return { instructions, options: mode ? { mode } : undefined };
	return { instructions, options: mode ? { ...baseOptions, mode } : baseOptions };
}

export class CommandController {
	readonly #memory: MemoryCommandController;

	constructor(private readonly ctx: CommandControllerContext) {
		this.#memory = new MemoryCommandController(ctx, loadHindsight);
	}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}

	/** Writes the export `/export` parsed (`parseExportTarget`) and opens it in the browser. */
	async handleExportCommand(outputPath: string | undefined): Promise<void> {
		try {
			const filePath = await this.ctx.session.exportToHtml(outputPath);
			this.ctx.showStatus(`Session exported to: ${filePath}`);
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : "Unknown error";
			}
			const doc = sidecarPath
				? `${formatted}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: formatted;
			await copyToClipboard(doc);
			const statusParts = ["Session copied to clipboard"];
			if (sidecarPath) statusParts.push(`LLM request JSON: ${sidecarPath}`);
			if (sidecarError) statusParts.push(`LLM request JSON unavailable: ${sidecarError}`);
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	/**
	 * `/advisor dump`: copy the advisor's OWN transcript — its system prompt, the
	 * deltas it was fed, and its thinking/advise calls — rather than the main
	 * conversation's. Compact by default; `isRaw` asks for the full dump with the
	 * system prompt and tool schemas attached.
	 */
	handleAdvisorDumpCommand(isRaw = false) {
		const dump = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
		if (!dump) {
			this.ctx.showError("No advisor is running, so there is no advisor transcript to copy.");
			return;
		}
		copyToClipboard(dump).then(
			() => this.ctx.showStatus("Advisor transcript copied to clipboard."),
			(error: unknown) => this.ctx.showError(`Failed to copy the advisor transcript: ${errorMessage(error)}`),
		);
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const width = Math.max(1, this.ctx.ui.terminal.columns);
			const renderedLines = this.ctx.chatContainer.render(width).map(line => replaceTabs(stripAnsi(line)));
			const rendered = renderedLines.join("\n").trimEnd();
			if (!rendered) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(`Debug transcript written to:\n${tmpPath}`);
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write debug transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleShareCommand(): Promise<void> {
		let customShare: LoadedCustomShare | null;
		try {
			customShare = await loadCustomShare();
		} catch (err) {
			this.ctx.showError(errorMessage(err));
			return;
		}

		const loader = this.#mountShareLoader();
		// Custom share scripts keep their legacy contract: they receive a path
		// to a standalone HTML export. No fallback to the default flow on error.
		if (customShare) await this.#runCustomShare(customShare, loader);
		else await this.#runDefaultShare(loader);
	}

	/** Swaps the editor for the cancellable "Sharing session..." loader; cancelling puts the editor back. */
	#mountShareLoader(): ComposerLoader {
		const loader = new ComposerLoader(this.ctx.ui, theme, "Sharing session...");
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(loader);
		this.ctx.ui.setFocus(loader);
		this.ctx.ui.requestRender();
		loader.onAbort = () => {
			this.#restoreEditor(loader);
			this.ctx.showStatus("Share cancelled");
		};
		return loader;
	}

	#restoreEditor(loader: ComposerLoader): void {
		loader.dispose();
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.ui.setFocus(this.ctx.editor);
	}

	/**
	 * Hands a standalone HTML export to the custom share script and shows what it returned. A share cancelled while
	 * the script runs shows nothing, since cancelling already restored the editor; the export is deleted either way.
	 */
	async #runCustomShare(customShare: LoadedCustomShare, loader: ComposerLoader): Promise<void> {
		const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
		try {
			await this.ctx.session.exportToHtml(tmpFile);
			const result = await customShare.fn(tmpFile);
			if (loader.signal.aborted) return;
			this.#restoreEditor(loader);
			this.#showCustomShareResult(result);
		} catch (err) {
			if (loader.signal.aborted) return;
			this.#restoreEditor(loader);
			this.ctx.showError(`Custom share failed: ${errorMessage(err)}`);
		} finally {
			await fs.rm(tmpFile, { force: true }).catch(() => {});
		}
	}

	/** A bare string is the share URL; an object states a URL, a message, or both; nothing means the share went through. */
	#showCustomShareResult(result: CustomShareResult | string | undefined): void {
		if (typeof result === "string") {
			this.ctx.showStatus(`Share URL: ${result}`);
			this.openInBrowser(result);
			return;
		}
		if (!result) {
			this.ctx.showStatus("Session shared");
			return;
		}
		const parts: string[] = [];
		if (result.url) parts.push(`Share URL: ${result.url}`);
		if (result.message) parts.push(result.message);
		if (parts.length > 0) this.ctx.showStatus(parts.join("\n"));
		if (result.url) this.openInBrowser(result.url);
	}

	/**
	 * Default share: an encrypted snapshot to a secret gist (preferred) or the share server. The key rides in the link
	 * fragment and never leaves the client.
	 */
	async #runDefaultShare(loader: ComposerLoader): Promise<void> {
		try {
			const result = await shareSession(this.ctx.session.sessionManager, {
				serverUrl: this.ctx.settings.get("share.serverUrl"),
				store: this.ctx.settings.get("share.store"),
				state: this.ctx.session.state,
				obfuscator: this.ctx.settings.get("share.redactSecrets") ? this.ctx.session.providerRedactor : undefined,
			});
			if (loader.signal.aborted) return;
			this.#restoreEditor(loader);
			const lines = [`Share URL: ${result.url}`];
			if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
			if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
			this.ctx.showStatus(lines.join("\n"));
			this.openInBrowser(result.url);
		} catch (error: unknown) {
			if (loader.signal.aborted) return;
			this.#restoreEditor(loader);
			this.ctx.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleSessionCommand(): Promise<void> {
		this.ctx.present([new Spacer(1), new Text(renderSessionInfo(this.ctx), 1, 0)]);
	}

	/**
	 * `/advisor status`: what the advisor is doing, and the next move when it is
	 * doing nothing. The next step comes from `advisorStatusNextStep`, which the
	 * text-mode handler reports too, so a headless client is not left at the
	 * report without the fix.
	 */
	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		this.ctx.showStatus(
			`${this.ctx.session.formatAdvisorStatus()}\n${advisorStatusNextStep(stats.configured, stats.active)}`,
		);
	}

	async handleJobsCommand(): Promise<void> {
		const snapshot = this.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
		if (!snapshot) {
			this.ctx.showWarning("Async background jobs are unavailable in this session.");
			return;
		}

		const now = Date.now();
		const lineWidth = Math.max(24, (this.ctx.ui.terminal.columns ?? 100) - 24);
		let info = `${theme.fg("dim", "Running:")} ${snapshot.running.length}\n`;

		if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
			info += `\n${theme.fg("dim", "No async jobs yet.")}\n`;
			const block = new TranscriptBlock();
			mountTranscriptBlock(block, {
				header: theme.bold(theme.fg("accent", "Background Jobs")),
				body: transcriptBlockText(info.trimEnd()),
			});
			this.ctx.present(block);
			return;
		}

		if (snapshot.running.length > 0) {
			info += `\n${theme.bold("Running Jobs")}\n`;
			for (const job of snapshot.running) {
				info += `${renderJobLine(job, now)}\n`;
				info += `  ${theme.fg("dim", truncateToWidth(job.label, lineWidth))}\n`;
			}
		}

		if (snapshot.recent.length > 0) {
			info += `\n${theme.bold("Recent Jobs")}\n`;
			for (const job of snapshot.recent) {
				info += `${renderJobLine(job, now)}\n`;
				info += `  ${theme.fg("dim", truncateToWidth(job.label, lineWidth))}\n`;
			}
		}

		const block = new TranscriptBlock();
		mountTranscriptBlock(block, {
			header: theme.bold(theme.fg("accent", "Background Jobs")),
			body: transcriptBlockText(info.trimEnd()),
		});
		this.ctx.present(block);
	}

	async handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? null;
		if (!usageReports) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (!provider.fetchUsageReports) {
				this.ctx.showWarning("Usage reporting is not configured for this session.");
				return;
			}
			try {
				usageReports = await provider.fetchUsageReports();
			} catch (error) {
				this.ctx.showError(`Failed to fetch usage data: ${errorMessage(error)}`);
				return;
			}
		}

		if (!usageReports || usageReports.length === 0) {
			// A fresh account with nothing billed yet is a normal state, not a fault.
			this.ctx.showStatus("No usage recorded yet for this account's providers.");
			return;
		}

		const availableWidth = Math.max(40, (this.ctx.ui.terminal.columns ?? 100) - 2);
		const currentProvider = this.ctx.session.model?.provider;
		const activeAccount = currentProvider
			? this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
					currentProvider,
					this.ctx.session.sessionId,
				)
			: undefined;
		const output = renderUsageReports(usageReports, theme, Date.now(), availableWidth, provider =>
			provider === currentProvider ? activeAccount : undefined,
		);
		this.ctx.present([new Spacer(1), new Text(output, 1, 0)]);
	}

	async handleChangelogCommand(): Promise<void> {
		// Release notes live on the website now, not in the terminal. Print the
		// link and try to open it in the browser (best-effort; harmless if headless).
		const block = new TranscriptBlock();
		mountTranscriptBlock(block, {
			header: theme.bold(theme.fg("accent", "Changelog")),
			body: transcriptBlockText(
				`${theme.fg("dim", "What's new in")} ${APP_NAME}${theme.fg("dim", ":")}\n${theme.fg("link", CHANGELOG_URL)}`,
			),
		});
		this.ctx.present(block);
		try {
			openPath(CHANGELOG_URL);
		} catch {
			// Best-effort: the printed link is the fallback.
		}
	}

	handleHotkeysCommand(): void {
		const hotkeys = buildHotkeysMarkdown({ keybindings: this.ctx.keybindings });
		showMarkdownPanel(this.ctx, "Keyboard Shortcuts", hotkeys);
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({ tools: this.ctx.session.agent.state.tools });
		showMarkdownPanel(this.ctx, "Available Tools", tools);
	}

	handleContextCommand(): void {
		const breakdown = computeContextBreakdown(this.ctx.session);
		if (breakdown.contextWindow <= 0) {
			this.ctx.showWarning("Context usage is unavailable: no model is selected for this session.");
			return;
		}
		const output = renderContextUsage(breakdown, theme);
		const block = new TranscriptBlock();
		mountTranscriptBlock(block, {
			header: theme.bold(theme.fg("accent", "Context Usage")),
			body: transcriptBlockText(output),
		});
		this.ctx.present(block);
	}

	/**
	 * Print `/secret list`, which is the answer the footline's secrets chip is a handle for.
	 *
	 * Runs the command the operator would have typed, through the same port, rather than reading the
	 * vault here. A chip that answered from a second reader could disagree with the command about
	 * what is stored, and a chip exists to be trusted at a glance or not at all.
	 */
	showSecretList(): void {
		void import("../../../slash-commands/helpers/secret")
			.then(({ interactiveSecretPort, runSecretCommandForSurface }) =>
				runSecretCommandForSurface("list", interactiveSecretPort(this.ctx)),
			)
			.then(outcome => this.ctx.showStatus(outcome.message))
			.catch(error => this.ctx.showWarning(errorMessage(error)));
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#memory.handle(text);
	}

	/**
	 * Move the UI to a freshly created session and let the displayed one finish
	 * its turn in the background. Returns false when the caller should fall
	 * back to resetting the current session in place.
	 *
	 * Restricted to a plain `/new` on a streaming session: `/drop` deletes the
	 * session file the running turn is still writing to, and the option-carrying
	 * callers seed the next transcript from the current one, so both need the
	 * turn to be over.
	 *
	 * `session.newKeepsBackground` decides the streaming case. Off, this declines
	 * and the in-place reset below aborts the turn and closes its provider
	 * stream, so a conversation that leaves the screen stops billing. On, the
	 * turn survives and the status line counts it.
	 */
	async #handOffRunningSession(options: NewSessionOptions | undefined): Promise<boolean> {
		const createNextSession = this.ctx.createNextSession;
		if (!createNextSession || options || !this.ctx.session.isStreaming) return false;
		if (!this.ctx.settings.get("session.newKeepsBackground")) return false;
		let next: AttachableSession;
		try {
			next = await createNextSession();
		} catch (error) {
			// The new session could not be built, so the only way to honor `/new`
			// is today's in-place reset, which interrupts the turn.
			logger.warn("Falling back to an in-place new session", { error: errorMessage(error) });
			return false;
		}
		const kept = this.ctx.attachMainSession(next.session, next);
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();
		const handoff = backgroundHandoff(kept, this.ctx.settings.get("session.backgroundLimit"));
		this.ctx.present([
			new Spacer(1),
			new Text(theme.fg("accent", `${theme.status.success} New session started — ${handoff.message}`), 1, 1),
		]);
		// The new session has not been displayed before: install this screen's
		// dialogs, notifier and extension UI on it, as launch does for the first.
		await this.ctx.initHooksAndCustomTools();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async #runNewSessionFlow(options?: NewSessionOptions, label: string = "New session started"): Promise<void> {
		this.ctx.clearTransientSessionUi();

		// Read before anything resets: `newSession()` aborts the turn, so asking
		// afterwards always reports a quiet session and the outcome line would
		// never mention the turn it just stopped. Only a plain `/new` reports it;
		// `/drop` states its own outcome and the option-carrying callers were
		// never streaming.
		const stoppedARunningTurn = !options && this.ctx.session.isStreaming;

		if (await this.#handOffRunningSession(options)) return;

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		const outcome = stoppedARunningTurn ? `${label} — previous session stopped` : label;
		this.ctx.present([new Spacer(1), new Text(`${theme.fg("accent", `${theme.status.success} ${outcome}`)}`, 1, 1)]);
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before refreshing provider state.");
			return;
		}
		const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(`Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`);
	}

	async handleDropCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError("Nothing to drop (in-memory session)");
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, "Session dropped");
	}

	async handleForkCommand(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before forking.");
			return;
		}
		this.ctx.clearWorkingLoader();
		this.ctx.statusContainer.disposeChildren();

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError("Fork failed (session not persisted or cancelled)");
			return;
		}

		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();

		const sessionFile = this.ctx.session.sessionFile;
		const shortPath = sessionFile ? sessionFile.split("/").pop() : "new session";
		this.ctx.present([
			new Spacer(1),
			new Text(`${theme.fg("accent", `${theme.status.success} Session forked to ${shortPath}`)}`, 1, 1),
		]);
	}

	/**
	 * Floating ModalShell card for the `/move` path picker, hosted fullscreen
	 * (like the extensions dashboard / copy picker) so the transcript stays
	 * visible around it and SGR mouse tracking is enabled for its lifetime.
	 */
	#showMoveOverlay(): Promise<MoveOverlayResult | undefined> {
		const { promise, resolve } = Promise.withResolvers<MoveOverlayResult | undefined>();
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		const overlay = new MoveOverlay(this.ctx.sessionManager.getCwd(), result => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			// The suggestion band lives on the shared clock; hiding the overlay does not tell
			// it that, and a band still travelling would keep asking for frames.
			overlay.dispose();
			this.ctx.focusActiveEditorArea();
			this.ctx.ui.requestRender();
			resolve(result);
		});
		overlay.setOnRequestRender(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(overlay, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(overlay);
		this.ctx.ui.requestRender();
		return promise;
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before moving.");
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.#showMoveOverlay();
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError("Usage: /move <path>");
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		if (!(await this.#ensureMoveTarget(resolvedPath))) return;

		// The session moves storage and every cwd-derived input as one transaction, re-roots the
		// wire's path relativization and records the change for the model, exactly as `/move` does in
		// ACP. Its `cwd_changed` event runs `applyCwdChange`, which refreshes what only the terminal draws.
		try {
			await this.ctx.session.moveToCwd(resolvedPath);
		} catch (err) {
			this.ctx.showError(`Move failed: ${errorMessage(err)}`);
			return;
		}

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();

		this.ctx.present([
			new Spacer(1),
			new Text(
				`${theme.fg("accent", `${theme.status.success} Moved to ${this.ctx.sessionManager.getCwd()}`)}`,
				1,
				1,
			),
		]);
	}

	/**
	 * Whether `resolvedPath` is a directory the session can move into. A missing directory is created once the
	 * "Create directory?" prompt is confirmed, and only when its parent exists; a `false` result has already been
	 * reported, except a declined prompt.
	 */
	async #ensureMoveTarget(resolvedPath: string): Promise<boolean> {
		if (await directoryExists(resolvedPath)) return true;
		const name = path.basename(resolvedPath);
		if (!(await directoryExists(path.dirname(resolvedPath)))) {
			this.ctx.showError(`Cannot create "${name}": parent directory does not exist`);
			return false;
		}
		if (!(await this.ctx.showHookConfirm("Create directory?", `"${name}" does not exist. Create it?`))) return false;
		try {
			await fs.mkdir(resolvedPath, { recursive: true });
			return true;
		} catch (err) {
			this.ctx.showError(`Failed to create directory: ${errorMessage(err)}`);
			return false;
		}
	}

	async handleRenameCommand(title: string): Promise<void> {
		try {
			const stored = await this.ctx.sessionManager.setSessionName(title, "user");
			if (!stored) {
				this.ctx.showError("Session name cannot be empty.");
				return;
			}
			const name = this.ctx.sessionManager.getSessionName()!;
			this.ctx.showStatus(`Session renamed to "${name}".`);
		} catch (err) {
			this.ctx.showError(`Rename failed: ${errorMessage(err)}`);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		this.ctx.bashComponent = new BashExecutionComponent(command, this.ctx.ui, excludeFromContext);
		await this.#runShortcutExecution(
			this.ctx.bashComponent,
			"bashComponent",
			this.ctx.pendingBashComponents,
			onChunk => this.ctx.session.executeBash(command, onChunk, { excludeFromContext, useUserShell: true }),
			"Bash command failed",
		);
		this.ctx.bashComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		this.ctx.pythonComponent = new EvalExecutionComponent(code, this.ctx.ui, excludeFromContext);
		await this.#runShortcutExecution(
			this.ctx.pythonComponent,
			"pythonComponent",
			this.ctx.pendingPythonComponents,
			onChunk => this.ctx.session.executePython(code, onChunk, { excludeFromContext }),
			"Python execution failed",
		);
		this.ctx.pythonComponent = undefined;
		this.ctx.ui.requestRender();
	}

	/**
	 * One `!`/`%` shortcut execution: present `component` (deferred behind a streaming turn into
	 * `pending`), stream chunks into whichever block holds `slot` at the time, and settle that block
	 * with the result or, on a thrown failure, with an error notice prefixed by `failure`.
	 */
	async #runShortcutExecution<C extends BashExecutionComponent | EvalExecutionComponent>(
		component: C,
		slot: "bashComponent" | "pythonComponent",
		pending: C[],
		execute: (
			onChunk: (chunk: string) => void,
		) => Promise<OutputSummary & { exitCode: number | undefined; cancelled: boolean }>,
		failure: string,
	): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.pendingMessagesContainer.addChild(component);
			pending.push(component);
		} else {
			this.ctx.present(component);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await execute(chunk => this.ctx[slot]?.appendOutput(chunk));
			const live = this.ctx[slot];
			if (live) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				live.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
				});
			}
		} catch (error) {
			this.ctx[slot]?.setComplete(undefined, false);
			this.ctx.showError(`${failure}: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
		// A `!` or `%` command may have moved the tree, and an idle row has no other reason to look.
		this.ctx.statusLine.refreshGitStatus();
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to compact (no messages yet)");
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead.
		if (internalGuidance) {
			return this.executeCompaction({ internalGuidance, ...(mode ? { mode } : {}) }, false, beforeFlush, mode);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode);
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content and
	 * `images` strips image blocks. Rebuilds the chat and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(`Shake failed: ${errorMessage(error)}`);
			return;
		}

		const dropped = result.toolResultsDropped + result.blocksDropped + (result.imagesDropped ?? 0);
		if (dropped === 0) {
			this.ctx.showStatus("Nothing to shake.");
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
	): Promise<CompactionOutcome> {
		this.ctx.clearWorkingLoader();
		this.ctx.statusContainer.disposeChildren();

		const label = `${compactionActionLabel(isAuto, resolveCompactionKind(this.ctx.session))} (esc to cancel)`;
		const compactingLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			label,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(compactingLoader);
		this.ctx.ui.requestRender();

		let outcome: CompactionOutcome = "ok";
		try {
			const { instructions, options } = compactionRequest(customInstructionsOrOptions, mode);
			await this.ctx.session.compact(instructions, options);

			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
			this.ctx.rebuildChatFromMessages();

			this.ctx.statusLine.invalidate();
			// Same as the auto-compaction rebuild: a collapsed transcript is an
			// intentional replacement, so drop the stale pre-compaction scrollback
			// instead of repainting the shrunken frame below it. With collapse
			// disabled the full history stays inline and scrollback is kept.
			if (this.ctx.settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				this.ctx.showError("Compaction cancelled");
			} else {
				outcome = "failed";
				const message = errorMessage(error);
				this.ctx.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		// Run the caller's pre-flush hook (e.g. the plan-approval model transition)
		// before queued user input is dispatched, so any turn queued during
		// compaction executes on the post-compaction model rather than the model
		// compaction itself ran on.
		if (beforeFlush) await beforeFlush(outcome);
		await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}

	async handleHandoffCommand(customInstructions?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before handing off.");
			return;
		}

		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to hand off (no messages yet)");
			return;
		}

		this.ctx.clearWorkingLoader();
		this.ctx.statusContainer.disposeChildren();

		const handoffLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"Generating handoff… (esc to cancel)",
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(handoffLoader);
		this.ctx.ui.requestRender();

		try {
			// Handoff generation runs as a oneshot request; the new session is shown after it completes.
			const result = await this.ctx.session.handoff(customInstructions);

			if (!result) {
				this.ctx.showError("Handoff cancelled");
				return;
			}

			// Rebuild chat from the new session (which now contains the handoff document).
			this.ctx.clearTransientSessionUi();
			this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			await this.ctx.reloadTodos();

			this.ctx.present([
				new Spacer(1),
				new Text(`${theme.fg("accent", `${theme.status.success} New session started with handoff context`)}`, 1, 1),
			]);
			if (result.savedPath) {
				this.ctx.showStatus(`Handoff document saved to: ${result.savedPath}`);
			}
		} catch (error) {
			const message = errorMessage(error);
			if (message === "Handoff cancelled" || isAbortError(error)) {
				this.ctx.showError("Handoff cancelled");
			} else {
				this.ctx.showError(`Handoff failed: ${message}`);
			}
		} finally {
			handoffLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}
}

function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, now - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", "running");
	if (status === "completed") return theme.fg("success", "completed");
	if (status === "cancelled") return theme.fg("dim", "cancelled");
	return theme.fg("error", "failed");
}
