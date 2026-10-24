/**
 * The transcript blocks a later call of the same kind replaces instead of
 * stacking beside: the waiting `job` poll and the live `todo` snapshot. Each
 * stays live until the next block lands, which either displaces it or seals it
 * in place as final history. A block whose rows may already be in native
 * scrollback is sealed, never removed.
 */
import type { ToolExecutionComponent } from "../components/transcript/tool-execution";
import type { EventControllerContext } from "./event-controller";

type DisplaceableBlocksContext = Pick<EventControllerContext, "chatContainer" | "ui">;

export class DisplaceableBlocks {
	// Most recent `job` tool block whose result still had every watched job
	// running. Kept un-finalized (live) so the next `job` call displaces it —
	// one persistent poll instead of a stack of "waiting on N jobs" frames —
	// and sealed in place the moment anything else lands below it.
	#poll: ToolExecutionComponent | undefined = undefined;
	// Most recent successful `todo` snapshot in the active turn. It stays live
	// across intervening tool output so a later `todo` update can replace the
	// old full list; the turn boundary seals the final snapshot as history.
	#todo: ToolExecutionComponent | undefined = undefined;

	constructor(private ctx: DisplaceableBlocksContext) {}

	/**
	 * Resolve the pending displaceable poll block before the next block lands.
	 * A follow-up `job` call displaces it — the stale "waiting on N jobs" frame
	 * is removed so repeated polls read as one persistent poll — while anything
	 * else seals it in place as final history. Removal is gated on none of the
	 * block's rows having entered native scrollback: rows already on the tape
	 * are immutable visual history, so a scrolled-off poll seals instead of
	 * being retracted.
	 */
	resolvePoll(nextToolName?: string): void {
		const previous = this.#poll;
		if (!previous) return;
		this.#poll = undefined;
		if (
			nextToolName === "job" &&
			previous.isDisplaceableBlock() &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			this.ctx.chatContainer.removeChild(previous);
		}
		// Sealing stops the waiting-poll spinner and freezes the block (for a
		// just-removed component it only clears the animation timer).
		previous.seal();
		this.ctx.ui.requestRender();
	}

	/**
	 * Seals the live todo snapshot in place as final history. Runs at a turn or prompt boundary, where no later
	 * update of the same turn can replace it; a same-turn update displaces it through {@link track} instead.
	 */
	sealTodo(): void {
		const previous = this.#todo;
		if (!previous) return;
		this.#todo = undefined;
		if (!previous.isDisplaceableBlock()) return;
		previous.seal();
		this.ctx.ui.requestRender();
	}

	/**
	 * Tracks a displaceable block so the next call of its kind replaces it: a waiting job poll for the next `job` call,
	 * a todo panel for the next successful todo update. A successful update supersedes the previous live todo panel; a
	 * failed one never gets here (canBeDisplacedBy("todo") is false for an errored result), so the last good panel
	 * stays on screen.
	 */
	track(toolName: string, component: ToolExecutionComponent): void {
		if (toolName === "job" && component.canBeDisplacedBy("job")) {
			this.#poll = component;
			return;
		}
		if (toolName !== "todo" || !component.canBeDisplacedBy("todo")) return;
		const previous = this.#todo;
		if (previous && previous !== component && previous.isDisplaceableBlock()) {
			this.#todo = undefined;
			if (this.ctx.chatContainer.isBlockUncommitted(previous)) this.ctx.chatContainer.removeChild(previous);
			previous.seal();
		}
		this.#todo = component;
	}

	/**
	 * Adopt a rebuilt-tail todo snapshot as the tracked live snapshot. Used by
	 * rebuild paths (settings/extensions overlay close, focus attach, /resume)
	 * to preserve displacement continuity when a turn is still active — without
	 * this, the next same-turn `todo` update would stack another panel because
	 * the tracker was reset before rebuild. Drops the candidate when it is no
	 * longer a displaceable todo.
	 */
	inheritTodo(component: ToolExecutionComponent | null | undefined): void {
		this.#todo = component?.canBeDisplacedBy("todo") ? component : undefined;
	}

	/** Forgets both tracked blocks without sealing them. */
	clear(): void {
		this.#poll = undefined;
		this.#todo = undefined;
	}
}
