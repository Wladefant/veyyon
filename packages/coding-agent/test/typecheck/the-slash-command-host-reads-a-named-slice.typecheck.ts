/**
 * The TUI slash-command host reads a named slice of the interactive context, never the whole
 * `InteractiveModeContext`. This file forces the checker through `src/slash-commands/types.ts`.
 *
 * `TuiSlashCommandRuntime.ctx` used to be typed as the full interface. Only the real TUI can
 * construct that, so every slash-command test reached it through `as unknown as
 * InteractiveModeContext`, unchecked against the members it claimed to supply. The slice
 * (`TuiSlashCommandHostContext`) states the exact surface the host reads, so a test builds a
 * runtime from a `Pick` with no cast.
 *
 * Each statement below fails to compile when the contract breaks:
 * - the slice assigns into `ctx` and `ctx` assigns back into the slice, so the field is the slice;
 * - the slice assigns into each collab sub-slice, because `/collab` builds a `CollabHost` and a
 *   `CollabGuestLink` from the whole `ctx`;
 * - the `@ts-expect-error` lines name input-controller members that must stay absent, and an
 *   unused `@ts-expect-error` is itself an error once the slice widens back.
 */
import type { CollabGuestContext } from "@veyyon/coding-agent/collab/guest";
import type { CollabHostContext } from "@veyyon/coding-agent/collab/host";
import type { TuiSlashCommandHostContext, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

export function sliceContract(host: TuiSlashCommandHostContext, runtime: TuiSlashCommandRuntime): void {
	const built: TuiSlashCommandRuntime = { ctx: host };
	const back: TuiSlashCommandHostContext = runtime.ctx;
	const collabHost: CollabHostContext = host;
	const collabGuest: CollabGuestContext = host;
	void [built, back, collabHost, collabGuest];

	// @ts-expect-error handleBashCommand is input-controller-only, absent from the slice
	void host.handleBashCommand;
	// @ts-expect-error keybindings is input-controller-only, absent from the slice
	void host.keybindings;
	// @ts-expect-error showModelCycleTrack is input-controller-only, absent from the slice
	void host.showModelCycleTrack;
}
