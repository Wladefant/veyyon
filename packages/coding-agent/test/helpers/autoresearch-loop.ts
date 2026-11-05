import type { AutoresearchUiDelegate } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";

/** A UI context whose status-row writes land in `rows`, with `undefined` for a row taken away. */
export function ctxWriting(rows: Array<string | undefined>): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				rows.push(text);
			},
		},
	} as unknown as ExtensionContext;
}

/** A loop with a run that started five seconds ago, so the clock has to move. */
export function runtimeRunning(): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state.name = "startup-latency";
	runtime.state.metricUnit = "ms";
	runtime.runningExperiment = {
		runNumber: 1,
		startedAt: Date.now() - 5_000,
		command: "bash autoresearch.sh",
		runDirectory: "/repo/.autoresearch/run-1",
		tail: "",
	};
	return runtime;
}

export interface CountingScreen {
	delegate: AutoresearchUiDelegate;
	/** Renders the mounted screen handle has received. */
	renders(): number;
	/** Close the screen, which mounts synchronously and stays open until this is called. */
	close(): void;
}

/** A screen delegate that mounts at once, counts the renders it receives, and stays open until closed. */
export function countingScreen(): CountingScreen {
	let renders = 0;
	let close = (): void => {
		throw new Error("the screen was closed before it was shown");
	};
	return {
		delegate: {
			async showScreen(_ctx, _runtime, _model, options) {
				options.onMount({
					requestRender: () => {
						renders++;
					},
				});
				const closed = Promise.withResolvers<void>();
				close = () => {
					options.onDispose();
					closed.resolve();
				};
				await closed.promise;
			},
			async showLauncher() {},
		},
		renders: () => renders,
		close: () => close(),
	};
}
