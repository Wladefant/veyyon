/**
 * The two anchored blocks above the composer: the todo board and the agent HUD, with the one motion
 * clock both rails step on, the todo auto-clear, and the coalesced rebuild an agent observer change
 * schedules. Carved out of `interactive-mode.ts`; the mode keeps `todoPhases` and `todoExpanded`
 * and delegates `setTodos`, `reloadTodos` and the redraws to this controller.
 */
import { Text } from "@veyyon/tui";
import { getPaddingX } from "@veyyon/utils/tight-mode";
import { isTerminalTodoStatus, isTodoListDone } from "@veyyon/wire";
import { settings } from "../../../config/settings";
import { transitionsEnabled } from "../../../theme/shimmer";
import { type Theme, theme } from "../../../theme/theme";
import { todoMatchesAnyDescription } from "../../../tools/agent/todo";
import { COMPOSER_INSET_COLS } from "../components/composer/composer-chrome";
import { renderAgentHudLines } from "../components/dashboard/agent-hud";
import {
	renderTodoBoardLines,
	TODO_BOARD_FRAME_DIVISOR,
	type TodoBoardMotion,
	todoBoardIsLive,
	todoBoardMarkerAnimates,
	todoBoardRailTravels,
} from "../components/dashboard/todo-board";
import {
	paintRailMotion,
	RAIL_IDLE_STEP_MS,
	RAIL_SETTLE_FRAMES,
	type RailMotion,
	railClockMs,
	railIdleHeadAtMs,
} from "../draw/rail-motion";
import type { SessionObserverChangeKind, SessionObserverRegistry } from "../session-observer-registry";
import type { InteractiveModeContext, TodoItem, TodoPhase } from "../types";

/** How long a burst of agent observer changes is coalesced before the block
 *  is rebuilt once. Exported because a test that drives the burst has to
 *  advance exactly this window: the block arms a repeating rail-motion interval
 *  as soon as it has lanes, so draining every pending timer never returns. */
export const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/**
 * Horizontal margin the two anchored blocks are mounted with, and the number
 * their width budget is derived from. One constant because a mount and a budget
 * that disagree is a soft wrap, and a soft wrap in an anchored region is a row
 * outside the block's own rail.
 *
 * `COMPOSER_INSET_COLS`, because a tool block's rail sits there and the prose
 * above it starts there. At one cell the board's rail was a column left of every
 * other left edge on screen, which is the distance that reads as broken rather
 * than as a margin.
 */
export const ANCHORED_BLOCK_PADDING_X = COMPOSER_INSET_COLS;

/**
 * What a todo board build reads that no board event delivers. A todo write, an
 * agent change, the expand toggle and the anchored clock each rebuild the board
 * themselves; the motion decision, the mount size and the theme change under it
 * with no event of their own.
 */
interface TodoBoardBuildInputs {
	motion: TodoBoardMotion;
	columns: number;
	maxRows: number;
	theme: Theme;
}

/** The slice of the interactive context the anchored blocks read and write. */
export type AnchoredBlocksContext = Pick<
	InteractiveModeContext,
	| "agentContainer"
	| "focusedAgentId"
	| "session"
	| "settings"
	| "syncRunningAgentBadge"
	| "todoContainer"
	| "todoExpanded"
	| "todoPhases"
	| "ui"
	| "viewSession"
>;

export class AnchoredBlocks {
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	/**
	 * Frame counter for everything animated in the anchored region: the lane
	 * sweep, the board's rail sweep, and the mark on the task in flight. One
	 * counter, so the two blocks cannot drift out of step.
	 */
	#anchoredStep = 0;
	#anchoredMotionInterval: NodeJS.Timeout | undefined;
	/** Settle frame while a closed board is going out, `undefined` otherwise. */
	#todoSettleFrame: number | undefined;
	/** The board being drawn for the length of that exit, held nowhere else. */
	#todoSettlePhases: TodoPhase[] | undefined;
	/** What the last board render measured: whether anything on it is in flight. */
	#todoBoardLive = false;
	/** The inputs the last board build read, so a streamed event rebuilds the board only when one moved. */
	#todoBoardBuiltFor: TodoBoardBuildInputs | undefined;
	#observerUiSyncTimer?: NodeJS.Timeout;
	#observerUiSyncNeedsTodoReconcile = false;
	/** Set once frame production stops: no timer arms again after `freeze`. */
	#frozen = false;
	readonly #observerRegistry: SessionObserverRegistry;

	constructor(
		private readonly ctx: AnchoredBlocksContext,
		observerRegistry: SessionObserverRegistry,
	) {
		this.#observerRegistry = observerRegistry;
	}

	/** Stops every timer the blocks own and keeps them stopped; the mode calls it when it stops producing frames. */
	freeze(): void {
		this.#frozen = true;
		this.#cancelTodoAutoClearTimer();
		this.#cancelAnchoredMotionTimer();
		this.#cancelObserverUiSyncTimer();
	}

	/**
	 * Auto-complete any pending/in_progress todo whose content matches a
	 * agent that has finished successfully. Fires on every observer
	 * `onChange` so the visual state stays in sync with agent lifecycle
	 * without requiring the agent to issue a follow-up `todo`. Failed
	 * and aborted agents are intentionally NOT auto-completed — those
	 * stay open so the user (or the next agent turn) can decide what to do.
	 *
	 * Idempotent: only flips open tasks, never re-touches completed ones.
	 *
	 * Every side of this is the VIEWED session's: the spawns consulted, the
	 * board read, and the session written back to. `this.ctx.todoPhases` is the
	 * viewed board, so persisting it into `session` while the view sat inside an
	 * agent copied that agent's board onto the driving session and persisted it
	 * there — a write-side version of the same leak.
	 */
	#reconcileTodosWithAgents(): void {
		const completedDescs: string[] = [];
		for (const session of this.#observerRegistry.getSessionsSpawnedBy(this.ctx.focusedAgentId)) {
			if (session.status !== "completed") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) completedDescs.push(candidate);
		}
		if (completedDescs.length === 0) return;

		let mutated = false;
		const next: TodoPhase[] = this.ctx.todoPhases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				if (task.status !== "pending" && task.status !== "in_progress") return task;
				if (!todoMatchesAnyDescription(task.content, completedDescs)) return task;
				mutated = true;
				return { ...task, status: "completed" as const };
			}),
		}));
		if (!mutated) return;
		this.ctx.viewSession.setTodoPhases(next);
		this.setTodos(next);
	}

	#cancelTodoAutoClearTimer(): void {
		if (!this.#todoAutoClearTimer) return;
		clearTimeout(this.#todoAutoClearTimer);
		this.#todoAutoClearTimer = undefined;
	}

	#hasClosedTodos(phases: TodoPhase[]): boolean {
		return phases.some(phase => phase.tasks.some(task => isClosedTodo(task)));
	}

	#removeClosedTodos(phases: TodoPhase[]): TodoPhase[] {
		const next: TodoPhase[] = [];
		for (const phase of phases) {
			const tasks = phase.tasks.filter(task => !isClosedTodo(task));
			if (tasks.length > 0) next.push({ name: phase.name, tasks });
		}
		return next;
	}

	#syncTodoAutoClearTimer(): void {
		this.#cancelTodoAutoClearTimer();
		const delaySeconds = this.ctx.settings.get("tasks.todoClearDelay");
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !this.#hasClosedTodos(this.ctx.todoPhases)) return;
		if (delaySeconds === 0) {
			this.ctx.todoPhases = this.#removeClosedTodos(this.ctx.todoPhases);
			return;
		}

		this.#todoAutoClearTimer = setTimeout(() => {
			this.#todoAutoClearTimer = undefined;
			this.ctx.todoPhases = this.#removeClosedTodos(this.ctx.todoPhases);
			this.renderTodoList();
			this.ctx.ui.requestRender();
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	scheduleObserverUiSync(kind: SessionObserverChangeKind): void {
		if (kind !== "progress") {
			this.#observerUiSyncNeedsTodoReconcile = true;
		}
		if (this.#observerUiSyncTimer) return;
		this.#observerUiSyncTimer = setTimeout(() => {
			this.#observerUiSyncTimer = undefined;
			this.#flushObserverUiSync();
		}, SUBAGENT_OBSERVER_UI_COALESCE_MS);
		this.#observerUiSyncTimer.unref?.();
	}

	#flushObserverUiSync(): void {
		this.ctx.syncRunningAgentBadge({ requestRender: false });
		if (this.#observerUiSyncNeedsTodoReconcile) {
			this.#observerUiSyncNeedsTodoReconcile = false;
			this.#reconcileTodosWithAgents();
		}
		this.#syncTodoAutoClearTimer();
		this.renderTodoList();
		this.renderAgentList();
		this.ctx.ui.requestRender();
	}

	#cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
		this.#observerUiSyncNeedsTodoReconcile = false;
	}

	/**
	 * The anchored todo board.
	 *
	 * A board with work on it and nothing left open draws NOTHING here — after it
	 * has finished going out.
	 *
	 * It used to collapse to one line, and that line was `▪ Todo list done ·
	 * 6 tasks` — the same sentence, from the same owner, that the transcript
	 * card for the write that closed the list had just printed. Both were on
	 * screen at once, one of them anchored above the composer for the rest of
	 * the session. This region is for work in flight; a finished plan is
	 * history, the card is where history lives, and the region being gone is
	 * how an anchored HUD says there is nothing open.
	 *
	 * What is new is that it stops being drawn through the same settle pass a
	 * tool block cools through, instead of vanishing between two frames. The
	 * region is the tallest thing above the composer and it used to disappear on
	 * one frame with no gesture at all, which reads as a rendering fault rather
	 * than as a plan closing. {@link #todoSettlePhases} holds the last drawn board
	 * for the length of the envelope and nothing else reads it, so `append` still
	 * puts a pending task back and the live board returns on the next frame.
	 */
	renderTodoList(): void {
		this.#buildTodoBoard();
		this.#todoBoardBuiltFor = {
			motion: this.#todoMotion(),
			columns: this.#anchoredColumns(),
			maxRows: this.#anchoredRowBudget(),
			theme,
		};
		// The board can be the only reason a frame is owed — a task in progress with
		// no agent running at all — so every path that redraws it re-decides
		// whether the clock should be ticking.
		this.#syncAnchoredMotionTimer();
	}

	/**
	 * Whether an input the last board build read has moved with no board event to
	 * report it: the agent starting or stopping, the mount resized, the theme
	 * swapped. Every motion field is compared, so a field added to
	 * `TodoBoardMotion` takes part without an edit here.
	 */
	todoBoardInputsMoved(): boolean {
		const built = this.#todoBoardBuiltFor;
		if (built === undefined) return true;
		if (built.theme !== theme) return true;
		if (built.columns !== this.#anchoredColumns() || built.maxRows !== this.#anchoredRowBudget()) return true;
		const motion = this.#todoMotion();
		for (const field in motion) {
			const key = field as keyof TodoBoardMotion;
			if (motion[key] !== built.motion[key]) return true;
		}
		return false;
	}

	#buildTodoBoard(): void {
		this.ctx.todoContainer.clear();
		const settling = this.#todoSettleFrame !== undefined ? this.#todoSettlePhases : undefined;
		const phases = (settling ?? this.ctx.todoPhases).filter(phase => phase.tasks.length > 0);
		this.#todoBoardLive = false;
		if (phases.length === 0) return;
		if (settling === undefined && isTodoListDone(phases)) return;

		const owned = this.#todoOwnedTasks();
		this.#todoBoardLive = todoBoardIsLive(phases, owned);
		const lines = renderTodoBoardLines(phases, {
			columns: this.#anchoredColumns(),
			// The two anchored blocks share one budget rather than each capping
			// itself: collapsed, the board ran to fourteen rows and the lane block to
			// ten, and on a short terminal the pair owned the screen. A third of the
			// viewport, and the board is what yields — the plan is static and the
			// agents are live.
			maxRows: this.#anchoredRowBudget(),
			expanded: this.ctx.todoExpanded,
			owned,
			// The board steps on its own divisor. The shared clock is the tool
			// rail's, fast enough for a highlight travelling down a block; a mark on
			// that clock changes several times a second next to text nobody is
			// reading that fast.
			frame: Math.floor(this.#anchoredStep / TODO_BOARD_FRAME_DIVISOR),
			// Motion states that the agent is working, so it is owed only while the
			// agent IS working: an interrupted or idle session gets a still board.
			animate: todoBoardMarkerAnimates(this.#todoMotion()),
			live: this.#todoBoardLive,
		});
		if (lines.length === 0) return;
		const motion = this.#todoRailMotion();
		const painted = motion ? paintRailMotion(lines, motion, theme) : lines;
		this.ctx.todoContainer.addChild(new Text(painted.join("\n"), ANCHORED_BLOCK_PADDING_X, 0));
	}

	/**
	 * Cells an anchored block actually gets to draw in.
	 *
	 * NOT the terminal width. Both blocks are mounted in a `Text` carrying
	 * `ANCHORED_BLOCK_PADDING_X` on each side, and `Text` SOFT-WRAPS its content
	 * to `width - paddingX * 2` before it ever reaches the terminal. A row built
	 * against the raw column count is therefore two cells too wide and the tail
	 * of it lands on a row of its own, at the margin, outside the block's rail —
	 * which is what a real capture of two live lanes showed: every lane's model
	 * badge on its own line at column zero. The width sweep in
	 * `test/agent-hud-render.test.ts` could not see it, because the blocks were
	 * obeying the bound they were given and the bound was wrong.
	 *
	 * `getPaddingX` is the same function the mount resolves its padding through,
	 * so tight layout (which spends the margin) is followed rather than guessed.
	 */
	#anchoredColumns(): number {
		return Math.max(1, (this.ctx.ui.terminal.columns || 80) - getPaddingX(ANCHORED_BLOCK_PADDING_X) * 2);
	}

	/**
	 * Rows the two anchored blocks may spend between them, board included.
	 *
	 * A third of the viewport, floored at enough for a header and three rows so a
	 * very short terminal still gets a board rather than chrome, and capped so a
	 * tall terminal does not turn the region into a page.
	 */
	#anchoredRowBudget(): number {
		const rows = this.ctx.ui.terminal.rows || 24;
		return Math.max(4, Math.min(14, Math.floor(rows / 3)));
	}

	/**
	 * Pending tasks a detached agent is working on right now.
	 *
	 * A pending task that an active spawn's description matches takes the accent
	 * and the in-flight mark, which is the only thing on the board stating that
	 * someone other than the main agent is on it.
	 */
	#todoOwnedTasks(): Set<string> {
		const owned = new Set<string>();
		const active = this.#observerRegistry
			.getSessionsSpawnedBy(this.ctx.focusedAgentId)
			.filter(session => session.status === "active");
		if (active.length === 0) return owned;
		const descriptions: string[] = [];
		for (const session of active) {
			const description =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (description) descriptions.push(description);
		}
		if (descriptions.length === 0) return owned;
		for (const phase of this.ctx.todoPhases) {
			for (const task of phase.tasks) {
				if (task.status !== "pending" || owned.has(task.content)) continue;
				if (todoMatchesAnyDescription(task.content, descriptions)) owned.add(task.content);
			}
		}
		return owned;
	}

	/**
	 * The board's rail motion for this frame: the exit pass while the plan is
	 * going out, the idle sweep while anything is in flight, and nothing at all
	 * when the board is open but the agent is not working.
	 *
	 * That last state is the one the block could not previously express. A board
	 * being worked and a board waiting for the operator rendered byte-identically,
	 * so the loudest region on the screen could not state whose turn it was.
	 */
	#todoRailMotion(): RailMotion | undefined {
		if (this.#todoSettleFrame !== undefined) return { kind: "settle", frame: this.#todoSettleFrame };
		if (!todoBoardRailTravels(this.#todoMotion())) return undefined;
		return { kind: "idle", head: railIdleHeadAtMs(railClockMs()) };
	}

	/**
	 * What the board is allowed to move on this frame.
	 *
	 * A task marked in progress is not motion. The model marks one, the turn
	 * ends, and the mark stays until the next turn changes it — so a board keyed
	 * on task state alone moved for as long as the operator sat and read it,
	 * stating that the agent is working while it waits for input.
	 * `session.isStreaming || isCompacting || hasPostPromptWork` is the same
	 * predicate the composer treats as busy, so the board moves exactly while the
	 * thing it draws moves, and an interrupt stops it on the frame the turn ends.
	 */
	#todoMotion(): TodoBoardMotion {
		return {
			transitions: transitionsEnabled(),
			agentInMotion:
				this.ctx.session.isStreaming || this.ctx.session.isCompacting || this.ctx.session.hasPostPromptWork,
			live: this.#todoBoardLive,
		};
	}

	/**
	 * Anchored HUD of in-flight agents, mirroring the Todos block above the
	 * editor. Driven entirely by observer-registry change events, so rows appear
	 * on spawn and the whole block clears itself once the last agent leaves
	 * the "active" state.
	 *
	 * The block belongs to the VIEWED session, not the driving one: focused into
	 * an agent from `/agents`, the rows are that agent's own spawns
	 * (`getSessionsSpawnedBy`), which for a leaf agent is empty and the block
	 * clears through the existing empty-array path. Rendering the driving
	 * session's list inside the agent's view named agents the viewed session
	 * never spawned, and made the two views indistinguishable.
	 *
	 * The rail carries the block's motion, so the block needs a repaint it does not
	 * otherwise get: the observer registry only fires when an agent's STATE
	 * changes, and an agent that has been running one bash command for four
	 * seconds produces no events at all, which is exactly the stretch the motion
	 * exists to cover.
	 *
	 * One sweep for the whole block, the same one every tool block runs. Gating it
	 * per row lit only the rows whose agent was inside a tool, so a roster where
	 * one agent kept starting and finishing calls flashed a chunk of the rail on
	 * and off while the rest of it stood still — motion an operator reads as a
	 * fault rather than as progress.
	 */
	renderAgentList(): void {
		this.ctx.agentContainer.clear();
		const sessions = this.#observerRegistry.getSessionsSpawnedBy(this.ctx.focusedAgentId);
		const lines = renderAgentHudLines(sessions, {
			columns: this.#anchoredColumns(),
			showModelBadge: settings.get("agent.showResolvedModelBadge"),
		});
		this.#syncAnchoredMotionTimer();
		if (lines.length === 0) return;
		const painted = transitionsEnabled()
			? paintRailMotion(lines, { kind: "idle", head: railIdleHeadAtMs(railClockMs()) }, theme)
			: lines;
		this.ctx.agentContainer.addChild(new Text(painted.join("\n"), ANCHORED_BLOCK_PADDING_X, 0));
	}

	/**
	 * One clock for both anchored blocks, armed while either has motion owed and
	 * disarmed the moment neither does.
	 *
	 * One timer and not two: the board and the lane block sit one row apart and
	 * their rails are the same rail, so two intervals at the same period would
	 * beat against each other and the two sweeps would drift out of step for no
	 * reason a reader could account for. The completion sweep, the breathing
	 * glyph, the lane scan and the board's exit all count in the same frames.
	 *
	 * Bounded on both ends by construction: it exists only while something is
	 * live, a running agent is what makes the lane block non-empty, and the
	 * board's settle disarms itself when its frame passes the envelope.
	 * `display.transitions: off` is the reduced-motion switch for chrome, so with
	 * it the timer is never armed and every row draws the same bytes at every
	 * clock.
	 */
	#syncAnchoredMotionTimer(): void {
		// `unref()` keeps the interval from holding the process open, which is not the same as
		// being gone: a frozen mode that still owns one goes on stepping, rendering, and reading
		// the settings singleton, and inside one test process that outlives the mode entirely.
		const wanted =
			!this.#frozen && transitionsEnabled() && (this.#anchoredMotionOwed() || this.#todoSettleFrame !== undefined);
		if (!wanted) {
			this.#cancelAnchoredMotionTimer();
			return;
		}
		if (this.#anchoredMotionInterval) return;
		this.#anchoredMotionInterval = setInterval(() => {
			this.#anchoredStep++;
			this.#advanceTodoSettle();
			this.renderTodoList();
			this.renderAgentList();
			this.ctx.ui.requestRender();
		}, RAIL_IDLE_STEP_MS);
		// A chrome animation must never be the reason the process stays alive.
		this.#anchoredMotionInterval.unref?.();
	}

	/** Disarms the anchored motion frame. Idempotent, so both the disarm path and the freeze call it. */
	#cancelAnchoredMotionTimer(): void {
		if (!this.#anchoredMotionInterval) return;
		clearInterval(this.#anchoredMotionInterval);
		this.#anchoredMotionInterval = undefined;
	}

	/**
	 * Whether either anchored block has something in flight worth a frame.
	 *
	 * The board's own liveness is read from what the last render measured rather
	 * than measured again: this runs on every frame, `#todoOwnedTasks` walks every
	 * active session against every task on the board, and the answer cannot have
	 * changed since the render that produced it — a change to either side arrives
	 * as an event that re-renders first.
	 */
	#anchoredMotionOwed(): boolean {
		// A live board is owed frames only while the agent is moving. Otherwise
		// the clock ran for the whole time the operator spent reading a plan that
		// was not being worked, and every one of those frames repainted two
		// regions to draw the same thing.
		if (todoBoardRailTravels(this.#todoMotion())) return true;
		return this.#observerRegistry
			.getSessionsSpawnedBy(this.ctx.focusedAgentId)
			.some(session => session.kind === "spawn" && session.status === "active" && session.detached === true);
	}

	/**
	 * Advance the board's exit by one frame, and clear it when the pass is over.
	 *
	 * The last frame of a settle is the static render, so stopping one frame past
	 * the envelope leaves the region on the bytes the renderer produced and then
	 * removes it — never on a half-cooled frame.
	 */
	#advanceTodoSettle(): void {
		if (this.#todoSettleFrame === undefined) return;
		if (this.#todoSettleFrame >= RAIL_SETTLE_FRAMES) {
			this.#todoSettleFrame = undefined;
			this.#todoSettlePhases = undefined;
			return;
		}
		this.#todoSettleFrame++;
	}

	/**
	 * Note that the plan closed, so the render can draw the exit as an event.
	 *
	 * A plan closing is the only event the board has; everything else about a
	 * board is a state and needs no memory.
	 */
	#noteTodoTransitions(before: TodoPhase[], after: TodoPhase[]): void {
		const nonEmptyBefore = before.filter(phase => phase.tasks.length > 0);
		const nonEmptyAfter = after.filter(phase => phase.tasks.length > 0);
		// A board that arrives ALREADY finished never had rows on screen, so there is
		// nothing to sweep away: it draws nothing at all, which is how the anchored
		// region says there is no open work. Arming the exit from an empty `before`
		// made a resumed session, and every caller that hands the HUD a closed plan
		// in one shot, play an exit for a board it never showed.
		const closedNow =
			nonEmptyAfter.length > 0 &&
			isTodoListDone(nonEmptyAfter) &&
			nonEmptyBefore.length > 0 &&
			!isTodoListDone(nonEmptyBefore);
		if (closedNow && transitionsEnabled()) {
			this.#todoSettlePhases = nonEmptyAfter;
			this.#todoSettleFrame = 1;
		}
		this.#syncAnchoredMotionTimer();
	}

	/**
	 * Re-derive the todo HUD from the session currently ON SCREEN.
	 *
	 * `viewSession`, not `session`: while the view is proxied onto an agent the
	 * board above the composer has to be that agent's, and the driving session's
	 * board has to come back intact on the way out. Both directions run through
	 * `clearTransientSessionUi`, which is the only caller that needs it
	 * synchronously; the async `reloadTodos` the session-switch paths already
	 * use is the same work plus a render request.
	 */
	syncTodoSurfaceToView(): void {
		this.ctx.todoPhases = this.ctx.viewSession.getTodoPhases();
		this.#syncTodoAutoClearTimer();
		this.renderTodoList();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		const before = this.ctx.todoPhases;
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.ctx.todoPhases = todos as TodoPhase[];
		} else {
			this.ctx.todoPhases = [
				{
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		// Every board write comes through here, so this is the one place that can
		// see a task close. A renderer cannot: it is handed a state and has no way
		// to know which part of it is new.
		this.#noteTodoTransitions(before, this.ctx.todoPhases);
		this.#syncTodoAutoClearTimer();
		this.renderTodoList();
		this.ctx.ui.requestRender();
	}
}

function isClosedTodo(task: TodoItem): boolean {
	return isTerminalTodoStatus(task.status);
}
