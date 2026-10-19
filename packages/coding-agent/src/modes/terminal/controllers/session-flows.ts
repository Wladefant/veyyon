/**
 * The session picker and the moves it starts: resuming a session (a live background one or a saved
 * file), and deleting one, including the session on screen.
 */
import type { SessionInfo } from "@veyyon/kernel/session/session-listing";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { errorMessage, normalizePathForComparison } from "@veyyon/utils";
import { BackgroundSessions, runningConversations } from "../../../session/background-sessions";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import { shortenPath } from "../../../tools/core/render-utils";
import { setSessionTerminalTitle } from "../../../utils/title-generator";
import { SessionSelectorComponent } from "../components/selectors/session-selector";
import type { SelectorController, SelectorControllerContext } from "./selector-controller";

/** The selector surface the session picker opens on. */
type SessionFlowsSurface = Pick<SelectorController, "showModalSelector">;

export class SessionFlows {
	readonly #ctx: SelectorControllerContext;
	readonly #surface: SessionFlowsSurface;

	constructor(ctx: SelectorControllerContext, surface: SessionFlowsSurface) {
		this.#ctx = ctx;
		this.#surface = surface;
	}

	async showSessionSelector(): Promise<void> {
		const sessions = await SessionManager.list(
			this.#ctx.sessionManager.getCwd(),
			this.#ctx.sessionManager.getSessionDir(),
		);
		// Always open in current-folder scope; the empty-state hint in SessionList
		// invites the user to Tab into all-projects rather than silently surfacing
		// every project's history when the cwd has nothing to resume. See #3099.
		const historyStorage = this.#ctx.historyStorage;
		const historyMatcher = historyStorage ? (query: string) => historyStorage.matchingSessionIds(query) : undefined;
		// Fullscreen session picker on the alternate screen (the /settings idiom):
		// the overlay borrows the alt buffer and enables mouse tracking (wheel
		// scroll + click-to-resume) for its lifetime, leaving the transcript
		// untouched underneath. Anchored top-left at full size so a mouse row maps
		// directly to a rendered line (the overlay paints from screen row 0), and
		// `fillHeight` selects the large centered-card sizing (card height
		// itself tracks the session list, so a short list stays a short card).
		this.#surface.showModalSelector(done => {
			const selector = new SessionSelectorComponent(
				sessions,
				async (session: SessionInfo) => {
					done();
					await this.handleResumeSession(session.path);
				},
				() => {
					done();
				},
				() => {
					// Release the alt buffer before teardown: shutdown() awaits flush/save/
					// dispose/drain before stop() leaves the alt screen, so without this the
					// fullscreen picker would freeze on screen for that window on Ctrl+C.
					done();
					void this.#ctx.shutdown();
				},
				{
					running: runningConversations(BackgroundSessions.global(), USER_INTERRUPT_LABEL),
					onDelete: async (session: SessionInfo) => {
						if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
							return false;
						}
						const storage = new FileSessionStorage();
						try {
							await storage.deleteSessionWithArtifacts(session.path);
							return true;
						} catch (err) {
							throw new Error(`Failed to delete session: ${errorMessage(err)}`, {
								cause: err,
							});
						}
					},
					historyMatcher,
					loadAllSessions: () => SessionManager.listAll(),
					getTerminalRows: () => this.#ctx.ui.terminal.rows,
					fillHeight: true,
				},
			);
			return { component: selector, focus: selector };
		});
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.#ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.#ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.#ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.#ctx.clearTransientSessionUi();
		this.#ctx.statusLine.invalidate();
		this.#ctx.statusLine.resetActiveTime();
		this.#ctx.ui.requestRender();
		this.#ctx.updateEditorBorderColor();
		this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.#ctx.clearTransientSessionUi();

		const previousCwd = this.#ctx.sessionManager.getCwd();
		// A session handed off by `/new` is still alive in this process, so resume
		// the OBJECT rather than its file: its turn keeps streaming into the view
		// it left, and the session being displayed now takes its place in the
		// background. Replaying the transcript here would rebuild a running turn
		// as finished text and leave the live session unreachable.
		const live = BackgroundSessions.global().take(sessionPath);
		if (live) {
			const liveCwd = live.sessionManager.getCwd();
			this.#ctx.attachMainSession(live);
			if (normalizePathForComparison(liveCwd) !== normalizePathForComparison(previousCwd)) {
				await this.#ctx.applyCwdChange(liveCwd);
			}
			this.#refreshSessionTerminalTitle();
			this.#ctx.updateEditorBorderColor();
			this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
			await this.#ctx.reloadTodos();
			this.#ctx.showStatus(live.isStreaming ? "Resumed a session that is still running" : "Resumed session");
			return;
		}

		// Switch session via AgentSession (emits hook and tool session events). The
		// SessionManager adopts the resumed session's own cwd when it differs.
		await this.#ctx.session.switchSession(sessionPath);
		const newCwd = this.#ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			// Resumed a session from another project: re-point the process and every
			// cwd-derived cache at it before rendering.
			await this.#ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.#ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#ctx.showStatus(movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session");
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.#ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.#ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.#ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.#ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.#ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.#ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.#ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}
}
