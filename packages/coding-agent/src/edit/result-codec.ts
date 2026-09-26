/**
 * How a session file stores an edit result without a second copy of the edited file.
 *
 * An edit's details hold the file before the edit (`oldText`), the file after it (`newText`) and the
 * numbered diff the card draws, which lists every line the edit removed and added. `newText` is
 * therefore `oldText` with the diff applied. {@link editResultCodec} drops `newText` from the written
 * line when {@link applyNumberedDiff} reproduces it exactly, tagging the line with
 * `newTextFrom: "diff"`, and restores it when the session loads, so the entry in memory is the one
 * the tool returned. A multi-file edit's `perFileResults` entries are stored the same way.
 *
 * The rebuild reads only the details the line keeps, never the result's content, so a prune or a
 * compaction that replaces the content leaves it intact.
 */
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BuiltinToolName } from "../tools/core/builtin-names";
import { applyNumberedDiff } from "./numbered-diff-row";

/**
 * The tag a written line carries in place of `newText`. A persisted value: a rebuild that produces
 * something else is a new tag with this one kept, or every session written before the change loads
 * a different file.
 */
const FROM_DIFF = "diff";

/** Below this length the tag costs more than the `newText` it replaces. */
const MIN_DROPPED_TEXT = 32;

/** The snapshot fields of edit details or of one `perFileResults` entry. */
interface Snapshot {
	oldText?: unknown;
	newText?: unknown;
	newTextFrom?: unknown;
	diff?: unknown;
}

function rebuild(snapshot: Snapshot): string | undefined {
	if (typeof snapshot.diff !== "string") return undefined;
	return applyNumberedDiff(typeof snapshot.oldText === "string" ? snapshot.oldText : "", snapshot.diff);
}

/** `snapshot` without `newText` when its diff rebuilds it, else `snapshot` itself. */
function slimSnapshot<T extends Snapshot>(snapshot: T): T {
	const { newText } = snapshot;
	if (typeof newText !== "string" || newText.length < MIN_DROPPED_TEXT || rebuild(snapshot) !== newText) {
		return snapshot;
	}
	const { newText: _dropped, ...kept } = snapshot;
	return { ...kept, newTextFrom: FROM_DIFF } as T;
}

function restoreSnapshot(snapshot: Snapshot): void {
	if (snapshot.newTextFrom !== FROM_DIFF || snapshot.newText !== undefined) return;
	const newText = rebuild(snapshot);
	if (newText === undefined) return;
	snapshot.newText = newText;
	delete snapshot.newTextFrom;
}

/** How an edit result is written to a session file and read back. */
export const editResultCodec: ToolResultCodec = {
	toolName: "edit" satisfies BuiltinToolName,
	slim(details) {
		if (!isRecord(details)) return details;
		const slimmed: Record<string, unknown> & Snapshot = slimSnapshot(details);
		const perFile = details.perFileResults;
		if (!Array.isArray(perFile)) return slimmed;
		let changed = false;
		const perFileResults = perFile.map(entry => {
			if (!isRecord(entry)) return entry;
			const slim = slimSnapshot(entry);
			if (slim !== entry) changed = true;
			return slim;
		});
		return changed ? { ...slimmed, perFileResults } : slimmed;
	},
	restore(details) {
		if (!isRecord(details)) return;
		restoreSnapshot(details);
		const perFile = details.perFileResults;
		if (!Array.isArray(perFile)) return;
		for (const entry of perFile) {
			if (isRecord(entry)) restoreSnapshot(entry);
		}
	},
};
