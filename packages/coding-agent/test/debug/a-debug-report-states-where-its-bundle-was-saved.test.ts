/**
 * WHY: the performance, dump and memory reports in `/debug` each built a status-line loader, wrote a
 * report bundle and presented the result: three copies of one sequence, none of them driven by a
 * test. They share one sequence now, and this suite drives each report through the selector:
 *
 * - the bundle holds the session file, the resolved settings and the report's own payload;
 * - the transcript states the report, where its bundle was saved and how many files it holds;
 * - a bundle that fails is reported as a failure, not as a saved report;
 * - the loader is in the status line while the bundle is written and gone afterwards.
 *
 * Not caught: a bundle report added to the menu and not to `REPORTS`, and the bundle's contents on
 * disk, which `raw-sse-report-bundle.test.ts` covers.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { DebugSelectorComponent } from "@veyyon/coding-agent/debug";
import * as profiler from "@veyyon/coding-agent/debug/profiler";
import * as reportBundle from "@veyyon/coding-agent/debug/report-bundle";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as natives from "@veyyon/natives";
import { type Component, Container } from "@veyyon/tui";

const DOWN = "\x1b[B";
const SESSION_FILE = "/repo/sessions/current.jsonl";
const SAVED = { path: "/repo/reports/bundle.tar.gz", files: ["session.jsonl", "settings.json", "profile.json"] };
const CPU_PROFILE = { profile: "cpu" } as never;
const WORK_PROFILE = { svg: "", sampleCount: 0 } as never;
const HEAP_SNAPSHOT = { snapshot: "heap" } as never;
const SETTINGS = {
	model: "model-a",
	thinkingLevel: "high",
	planModeEnabled: false,
	toolOutputExpanded: true,
	hideThinkingBlock: false,
};

interface Harness {
	selector: DebugSelectorComponent;
	status: Container;
	editor: { onSubmit?: () => void; onEscape?: () => void };
	presented: string[];
	errors: string[];
	/** Resolves on the next transcript entry or error the selector produces. */
	next(): Promise<void>;
}

function plain(content: Component | readonly Component[]): string {
	const components: readonly Component[] = Array.isArray(content) ? content : [content as Component];
	return stripVTControlCharacters(components.flatMap(component => component.render(100)).join("\n"));
}

function harness(): Harness {
	const status = new Container();
	const editor: Harness["editor"] = {};
	const presented: string[] = [];
	const errors: string[] = [];
	let wake: (() => void) | undefined;
	const ctx = {
		editor,
		session: { model: { id: "model-a" }, thinkingLevel: "high" },
		sessionManager: { getSessionFile: () => SESSION_FILE },
		planModeEnabled: false,
		toolOutputExpanded: true,
		hideThinkingBlock: false,
		statusContainer: status,
		ui: { requestRender: () => {}, requestComponentRender: () => {} },
		present: (content: Component | readonly Component[]) => {
			presented.push(plain(content));
			wake?.();
		},
		showError: (message: string) => {
			errors.push(message);
			wake?.();
		},
		showWarning: () => {},
	};
	const selector = new DebugSelectorComponent(ctx as never, () => {});
	selector.render(100);
	return {
		selector,
		status,
		editor,
		presented,
		errors,
		next() {
			const { promise, resolve } = Promise.withResolvers<void>();
			wake = resolve;
			return promise;
		},
	};
}

/** Moves to the menu row at `index` and picks it. */
function pick(h: Harness, index: number): void {
	for (let step = 0; step < index; step++) h.selector.handleInput(DOWN);
	h.selector.handleInput("\n");
}

interface Report {
	name: string;
	/** The line the transcript leads with once the bundle is saved. */
	saved: string;
	/** What the report adds to the bundle beyond the session file, settings and SSE capture. */
	payload: Record<string, unknown>;
	/** Picks the report and drives it to the point where its bundle is written. */
	run(h: Harness): Promise<void>;
}

const REPORTS: Report[] = [
	{
		name: "performance",
		saved: "+ Performance report saved",
		payload: { cpuProfile: CPU_PROFILE, workProfile: WORK_PROFILE },
		async run(h) {
			const started = h.next();
			pick(h, 1);
			await started;
			const done = h.next();
			h.editor.onSubmit?.();
			await done;
		},
	},
	{
		name: "dump",
		saved: "+ Report bundle saved",
		payload: {},
		async run(h) {
			const done = h.next();
			pick(h, 3);
			await done;
		},
	},
	{
		name: "memory",
		saved: "+ Memory report saved",
		payload: { heapSnapshot: HEAP_SNAPSHOT },
		async run(h) {
			const done = h.next();
			pick(h, 4);
			await done;
		},
	},
];

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	vi.spyOn(profiler, "startCpuProfile").mockResolvedValue({ stop: async () => CPU_PROFILE });
	vi.spyOn(profiler, "generateHeapSnapshotData").mockReturnValue(HEAP_SNAPSHOT);
	vi.spyOn(natives, "getWorkProfile").mockReturnValue(WORK_PROFILE);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(REPORTS)("the $name report", report => {
	it("bundles the session with its own payload and states where the bundle was saved", async () => {
		const h = harness();
		let bundled: reportBundle.ReportBundleOptions | undefined;
		let loadersWhileBundling = -1;
		vi.spyOn(reportBundle, "createReportBundle").mockImplementation(async options => {
			bundled = options;
			loadersWhileBundling = h.status.children.length;
			return SAVED;
		});

		await report.run(h);

		expect(bundled).toEqual({ sessionFile: SESSION_FILE, settings: SETTINGS, ...report.payload });
		expect(loadersWhileBundling).toBe(1);
		expect(h.status.children).toEqual([]);
		expect(h.errors).toEqual([]);
		expect(
			h.presented
				.at(-1)
				?.split("\n")
				.map(line => line.trim()),
		).toEqual([report.saved, SAVED.path, `Files: ${SAVED.files.length}`]);
	});

	it("reports a bundle that could not be written and clears the loader", async () => {
		const h = harness();
		vi.spyOn(reportBundle, "createReportBundle").mockRejectedValue(new Error("disk full"));

		await report.run(h);

		expect(h.errors).toEqual(["Failed to create report: disk full"]);
		expect(h.status.children).toEqual([]);
		expect(h.presented.some(entry => entry.includes(report.saved))).toBe(false);
	});
});
