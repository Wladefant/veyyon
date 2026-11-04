/**
 * Hook dialogs mirrored to a collab guest: the select, editor and ask requests a guest receives, and the race
 * between the local dialog and the guest's answer. The first answer wins and cancels the other side; a guest
 * transport that becomes unavailable is not an answer, so the local dialog keeps running.
 */
import { clampLow } from "@veyyon/utils";
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@veyyon/wire";
import type { CollabHost } from "../../../collab/host";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUISelectItem,
} from "../../../extensibility/extensions";
import {
	ASK_CHAT_OPTION_LABEL,
	ASK_NEXT_OPTION_LABEL,
	ASK_OTHER_OPTION_LABEL,
} from "../../../tools/agent/ask-option-labels";
import { boundPromptTitle } from "../components/dialogs/ask-dialog";
import type { InteractiveSelectorDialogOptions } from "../types";

interface CollabDialogWinner {
	source: "local" | "remote";
	value: string | undefined;
}

interface CollabAskDialogWinner {
	source: "local" | "remote";
	value: ExtensionAskDialogResult | undefined;
}

/** Tagged result from a guest UI request, distinguishing a real answer (even
 *  one whose literal value is "unavailable"), an explicit guest cancel, and a
 *  transport-unavailable sentinel (collab teardown / abort). */
type GuestUiResult = { kind: "answered"; value: string } | { kind: "cancelled" } | { kind: "unavailable" };

/** What a guest answered to one ask question: the options it checked and the text it typed after picking Other. */
interface GuestAskAnswer {
	selected: Set<string>;
	customInput: string | undefined;
}

/** One guest pick: a row label, or the text typed into the editor the Other row opens. */
type GuestAskPick = { label: string } | { customInput: string };

/** How a guest left an ask question without answering it: Chat, a lost transport, or a cancel. */
type GuestAskExit = "chat" | "unavailable" | undefined;

/**
 * The select a multi-choice guest question shows with `selected` checked.
 *
 * Mirrors the local dialog's Next gating: the Next row is omitted until an option is checked, so a guest cannot submit
 * an empty multi-select result (PRRT_kwDOQxs0bc6OFbDW). The remote select has no "disabled" row, so the row is omitted
 * rather than dimmed. An Other answer ends the question, so only a checked option opens Next.
 */
function multiSelectRequest(
	question: ExtensionAskDialogQuestion,
	options: CollabUiSelectItem[],
	other: CollabUiSelectItem[],
	selected: Set<string>,
): CollabUiRequestDraft {
	const hasAnswer = selected.size > 0;
	const rows = options.concat(other);
	if (hasAnswer) rows.push(ASK_NEXT_OPTION_LABEL);
	rows.push(ASK_CHAT_OPTION_LABEL);
	const checkedIndices: number[] = [];
	for (const [index, option] of question.options.entries()) {
		if (selected.has(option.label)) checkedIndices.push(index);
	}
	return {
		kind: "select",
		title: question.question,
		options: rows,
		selectionMarker: "checkbox",
		checkedIndices,
		markableCount: question.options.length,
		helpText: hasAnswer
			? "up/down navigate  enter toggle  Next → continue  esc cancel"
			: "up/down navigate  enter toggle  esc cancel",
	};
}

function toWireSelectOptions(options: ExtensionUISelectItem[]): CollabUiSelectItem[] {
	return options.map(option =>
		typeof option === "string"
			? option
			: option.description
				? { label: option.label, description: option.description }
				: { label: option.label },
	);
}

/** The select request a guest receives for a hook selector titled `title`. */
export function guestSelectRequest(
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions: InteractiveSelectorDialogOptions | undefined,
): CollabUiRequestDraft {
	return {
		kind: "select",
		title,
		options: toWireSelectOptions(options),
		initialIndex: dialogOptions?.initialIndex,
		selectionMarker: dialogOptions?.selectionMarker,
		checkedIndices: dialogOptions?.checkedIndices ? dialogOptions.checkedIndices.slice() : undefined,
		markableCount: dialogOptions?.markableCount,
		helpText: dialogOptions?.helpText,
	};
}

/**
 * Race the local hook dialog against a mirrored guest request. First *answer*
 * wins and cancels the other side. A remote `unavailable` settlement
 * (collab teardown, relay drop, abort) is NOT an answer: the local dialog
 * keeps running — the host user may be mid-keystroke in it — and its
 * eventual result is returned.
 */
export async function raceCollabDialog(
	host: CollabHost | undefined,
	request: CollabUiRequestDraft,
	signal: AbortSignal | undefined,
	local: (signal: AbortSignal | undefined) => Promise<string | undefined>,
): Promise<string | undefined> {
	if (!host) return local(signal);
	const localAbort = new AbortController();
	const remoteAbort = new AbortController();
	const remote = host.requestGuestUi(
		request,
		signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal,
	);
	if (!remote) return local(signal);
	const localWinner = local(signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal).then(
		(value): CollabDialogWinner => ({ source: "local", value }),
	);
	const remoteWinner: Promise<CollabDialogWinner> = remote.then(result =>
		result.kind === "answered" ? { source: "remote", value: result.value } : localWinner,
	);
	const winner = await Promise.race([localWinner, remoteWinner]);
	if (winner.source === "remote") localAbort.abort();
	else remoteAbort.abort();
	return winner.value;
}

/**
 * Race the local ask dialog against the same questions asked of the guest, one select (and Other editor) at a
 * time, reading `collabHost` per request. As with {@link raceCollabDialog}, a guest transport that becomes unavailable leaves the local dialog running.
 */
export async function raceCollabAskDialog(
	collabHost: () => CollabHost | undefined,
	questions: ExtensionAskDialogQuestion[],
	signal: AbortSignal | undefined,
	local: (signal: AbortSignal | undefined) => Promise<ExtensionAskDialogResult | undefined>,
): Promise<ExtensionAskDialogResult | undefined> {
	if (!collabHost()) return local(signal);
	const localAbort = new AbortController();
	const remoteAbort = new AbortController();
	const localSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
	const remoteSignal = signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal;
	const localWinner = local(localSignal).then((value): CollabAskDialogWinner => ({ source: "local", value }));
	const remoteWinner: Promise<CollabAskDialogWinner> = runGuestAskDialog(collabHost, questions, remoteSignal).then(
		result => (result === "unavailable" ? localWinner : { source: "remote", value: result }),
	);
	const winner = await Promise.race([localWinner, remoteWinner]);
	if (winner.source === "remote") localAbort.abort();
	else remoteAbort.abort();
	return winner.value;
}

async function runGuestAskDialog(
	collabHost: () => CollabHost | undefined,
	questions: ExtensionAskDialogQuestion[],
	signal: AbortSignal,
): Promise<ExtensionAskDialogResult | "unavailable" | undefined> {
	const results: ExtensionAskDialogResultItem[] = [];
	for (const question of questions) {
		const result = await runGuestAskQuestion(collabHost, question, signal);
		if (result === "unavailable" || result === undefined) return result;
		if (result === "chat") return { kind: "chat" };
		results.push(result);
	}
	return { kind: "submit", results };
}

async function runGuestAskQuestion(
	collabHost: () => CollabHost | undefined,
	question: ExtensionAskDialogQuestion,
	signal: AbortSignal,
): Promise<ExtensionAskDialogResultItem | "chat" | "unavailable" | undefined> {
	const options: CollabUiSelectItem[] = question.options.map(option =>
		option.description?.trim() ? { label: option.label, description: option.description.trim() } : option.label,
	);
	// Mirror the local dialog: `allowOther: false` offers no free-text row, so a
	// guest cannot return an answer outside the listed options.
	const other: CollabUiSelectItem[] = question.allowOther === false ? [] : [ASK_OTHER_OPTION_LABEL];
	const answer = question.multi
		? await runGuestMultiSelect(collabHost, question, options, other, signal)
		: await runGuestSingleSelect(collabHost, question, options, other, signal);
	if (answer === undefined || typeof answer === "string") return answer;
	const labels = question.options.map(option => option.label);
	return {
		id: question.id,
		question: question.question,
		options: labels,
		multi: question.multi ?? false,
		selectedOptions: labels.filter(label => answer.selected.has(label)),
		customInput: answer.customInput,
	};
}

/** Toggles the option the guest picks until it picks Next or types an Other answer. */
async function runGuestMultiSelect(
	collabHost: () => CollabHost | undefined,
	question: ExtensionAskDialogQuestion,
	options: CollabUiSelectItem[],
	other: CollabUiSelectItem[],
	signal: AbortSignal,
): Promise<GuestAskAnswer | GuestAskExit> {
	const selected = new Set<string>();
	while (true) {
		const pick = await guestPick(
			collabHost,
			question,
			multiSelectRequest(question, options, other, selected),
			other,
			signal,
		);
		if (pick === undefined || typeof pick === "string") return pick;
		if ("customInput" in pick) return { selected, customInput: pick.customInput };
		if (pick.label === ASK_NEXT_OPTION_LABEL) return { selected, customInput: undefined };
		if (!selected.delete(pick.label)) selected.add(pick.label);
	}
}

/** The one option the guest picks, starting on the question's recommended option, or its Other answer. */
async function runGuestSingleSelect(
	collabHost: () => CollabHost | undefined,
	question: ExtensionAskDialogQuestion,
	options: CollabUiSelectItem[],
	other: CollabUiSelectItem[],
	signal: AbortSignal,
): Promise<GuestAskAnswer | GuestAskExit> {
	const recommended =
		typeof question.recommended === "number" && Number.isInteger(question.recommended) ? question.recommended : 0;
	const request: CollabUiRequestDraft = {
		kind: "select",
		title: question.question,
		options: options.concat(other, [ASK_CHAT_OPTION_LABEL]),
		initialIndex: clampLow(recommended, 0, Math.max(0, question.options.length - 1)),
		selectionMarker: "radio",
		markableCount: question.options.length,
		helpText: "up/down navigate  enter select  esc cancel",
	};
	const pick = await guestPick(collabHost, question, request, other, signal);
	if (pick === undefined || typeof pick === "string") return pick;
	return "customInput" in pick
		? { selected: new Set(), customInput: pick.customInput }
		: { selected: new Set([pick.label]), customInput: undefined };
}

/**
 * The row the guest picks from `request`, the text it types after picking Other, or how it left the question. A
 * guest that cancels the Other editor sees `request` again rather than cancelling the whole ask.
 */
async function guestPick(
	collabHost: () => CollabHost | undefined,
	question: ExtensionAskDialogQuestion,
	request: CollabUiRequestDraft,
	other: CollabUiSelectItem[],
	signal: AbortSignal,
): Promise<GuestAskPick | GuestAskExit> {
	while (true) {
		const choice = await requestGuestUiString(collabHost, request, signal);
		if (choice.kind === "unavailable") return "unavailable";
		if (choice.kind === "cancelled") return undefined;
		if (choice.value === ASK_CHAT_OPTION_LABEL) return "chat";
		if (other.length === 0 || choice.value !== ASK_OTHER_OPTION_LABEL) return { label: choice.value };
		const input = await requestGuestUiString(
			collabHost,
			{ kind: "editor", title: boundPromptTitle("Custom answer: ", question.question) },
			signal,
		);
		if (input.kind === "unavailable") return "unavailable";
		if (input.kind === "answered") return { customInput: input.value };
	}
}

async function requestGuestUiString(
	collabHost: () => CollabHost | undefined,
	request: CollabUiRequestDraft,
	signal: AbortSignal,
): Promise<GuestUiResult> {
	// Read per request: a guest that leaves mid-ask makes the rest of the ask unavailable.
	const host = collabHost();
	if (!host) return { kind: "unavailable" };
	const remote = host.requestGuestUi(request, signal);
	if (!remote) return { kind: "unavailable" };
	const result = await remote;
	if (result.kind === "unavailable") return { kind: "unavailable" };
	return typeof result.value === "string" ? { kind: "answered", value: result.value } : { kind: "cancelled" };
}
