/**
 * Contracts: a per-line column cap reports the unit it was enforced in, every producer cuts in the
 * unit it reports, and a cap whose producer mirrored the raw stream points at that capture.
 *
 * WHY THIS SUITE EXISTS. The shell output sink caps each line in UTF-8 bytes and mirrors the raw
 * stream to an artifact whenever the cap drops bytes, yet the notice said "Some lines truncated to 512
 * chars" and named no artifact, so an agent reading a line of CJK or emoji output believed it had
 * lost less than it had and had no route back to the uncut line. Grep had the same split in a second
 * shape: the native searcher cuts on-disk matches in bytes while virtual resources (internal URLs
 * with no backing file) were cut in characters, so one line read differently depending on where it
 * lived. Ported from oh-my-pi 690b57d2485da3b31d35c5d8ac1bbd8a21a2fc04,
 * 9d8b40b0750fc2550afbf70cf212c198f32c993a, ec967f6f22a6 and a60bb7b22dea.
 *
 * THE CLASS. Every producer of `limits.columnTruncated`: the output sink (bash, eval, ssh, async
 * delivery), grep on disk, grep on a virtual resource, and `read`. Each is driven through its real
 * entry point with a line that is wide in bytes and narrow in characters, which is the only input
 * that tells the two units apart.
 *
 * THE DISPLAY. The `!` and `$` execution blocks draw their own footer from the run's metadata. They
 * were handed only `meta.truncation`, so once a column cap stopped counting as a window truncation
 * the block showed no warning at all; both components are driven with a real sink summary below.
 *
 * WHAT IT DOES NOT CATCH. A new producer is not discovered at run time: there is no registry of
 * column-cap producers to sweep. `OutputMetaBuilder.limits` refuses a `columnMax` without a
 * `columnUnit` at the type level, so a new producer must name its unit to compile; whether that unit
 * matches how it cut is only proven here for the producers listed above. The two call sites that
 * hand metadata to the execution blocks (the live shortcut and the transcript rebuild) are held by
 * the type of `setComplete`, not by a test here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	LocalProtocolHandler,
} from "@veyyon/coding-agent/internal-urls";
import { BashExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/bash-execution";
import { EvalExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/eval-execution";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { formatOutputNotice, type OutputMeta, outputMeta } from "@veyyon/coding-agent/tools/core/output-meta";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import type { TUI } from "@veyyon/tui";
import { removeWithRetries } from "@veyyon/utils";

/** 7 ASCII bytes + 400 two-byte characters: 407 characters, 807 bytes. Wide only when counted in bytes. */
const WIDE_IN_BYTES = `needle ${"é".repeat(400)}`;
/**
 * What survives a 512-byte cut: 509 bytes of whole characters, leaving 3 bytes for the marker. The
 * native searcher writes `...` and the virtual path writes `…`; both markers are 3 bytes.
 */
const KEPT_UNDER_512_BYTES = `needle ${"é".repeat(251)}`;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

function metaOf(result: { details?: unknown }): OutputMeta | undefined {
	return (result.details as { meta?: OutputMeta } | undefined)?.meta;
}

describe("the shell output sink's column cap", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "column-cap-sink-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("reports bytes and points at the raw capture it mirrored", async () => {
		const sink = new OutputSink({
			maxColumns: 16,
			spillThreshold: 100_000,
			artifactPath: path.join(tmpDir, "raw.log"),
			artifactId: "raw-7",
		});
		// 10 characters, 20 bytes: over a 16-byte cap, under a 16-character one.
		await sink.push(`short\n${"é".repeat(10)}\ntail\n`);
		const summary = await sink.dump();

		const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get();
		expect(meta?.truncation).toBeUndefined();
		expect(formatOutputNotice(meta)).toBe(
			"\n\n[Some lines truncated to 16 bytes. Read artifact://raw-7 for full output]",
		);
		// The capture it names holds the line the cap cut.
		expect(await fs.readFile(path.join(tmpDir, "raw.log"), "utf-8")).toContain("é".repeat(10));
	});

	it("names no capture when the sink had nowhere to mirror to", async () => {
		const sink = new OutputSink({ maxColumns: 16, spillThreshold: 100_000 });
		await sink.push(`${"é".repeat(10)}\n`);
		const meta = outputMeta()
			.truncationFromSummary(await sink.dump(), { direction: "tail" })
			.get();
		expect(formatOutputNotice(meta)).toBe("\n\n[Some lines truncated to 16 bytes]");
	});
});

describe("the `!` and `$` execution blocks", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	it("warn about a column cap even when the output was otherwise whole", async () => {
		const sink = new OutputSink({ maxColumns: 16, spillThreshold: 100_000 });
		await sink.push(`${"é".repeat(10)}\n`);
		const summary = await sink.dump();
		const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get();
		expect(meta?.truncation).toBeUndefined();

		const bash = new BashExecutionComponent("cat wide.txt", ui, false);
		bash.setComplete(0, false, { output: summary.output, meta });
		const evaluated = new EvalExecutionComponent("print(wide)", ui, false);
		evaluated.setComplete(0, false, { output: summary.output, meta });

		for (const block of [bash, evaluated]) {
			expect(Bun.stripANSI(block.render(120).join("\n"))).toContain("Some lines truncated to 16 bytes");
		}
	});
});

describe("grep's column cap", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "column-cap-grep-"));
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		InternalUrlRouter.instance().register({
			scheme: "virtual",
			immutable: true,
			async resolve(url: InternalUrl): Promise<InternalResource> {
				const content = `${WIDE_IN_BYTES}\n`;
				return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content, "utf-8") };
			},
		});
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	function session(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
		};
	}

	it("cuts a line on disk and the same line in a virtual resource at the same byte, and reports bytes", async () => {
		await fs.writeFile(path.join(tmpDir, "wide.txt"), `${WIDE_IN_BYTES}\n`);
		const tool = new SearchTool(session());

		const onDisk = await tool.execute("disk", { type: "text", input: "needle", path: "wide.txt" });
		const virtual = await tool.execute("virtual", { type: "text", input: "needle", path: "virtual://doc.md" });

		for (const [result, marker] of [
			[onDisk, "..."],
			[virtual, "…"],
		] as const) {
			const text = textOf(result);
			expect(text).toContain(`${KEPT_UNDER_512_BYTES}${marker}`);
			expect(text).not.toContain("é".repeat(252));
			expect(metaOf(result)?.limits?.columnTruncated).toEqual({ maxColumn: 512, unit: "bytes" });
			expect(formatOutputNotice(metaOf(result))).toContain("Some lines truncated to 512 bytes");
		}
	});
});

describe("read's column cap", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "column-cap-read-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("cuts and reports in characters", async () => {
		const settings = Settings.isolated();
		settings.set("tools.outputMaxColumns", 300);
		settings.set("read.summarize.enabled", false);
		const filePath = path.join(tmpDir, "wide.txt");
		// 407 characters: over a 300-character cap; its 807 bytes would be over a 512-byte one too, but
		// 280 two-byte characters (560 bytes) must survive a character cap untouched.
		await fs.writeFile(filePath, `head\n${WIDE_IN_BYTES}\n${"é".repeat(280)}\n`);
		const result = await new ReadTool({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		}).execute("read", { path: filePath });

		expect(textOf(result)).toContain("é".repeat(280));
		expect(metaOf(result)?.limits?.columnTruncated).toEqual({ maxColumn: 300, unit: "chars" });
		expect(formatOutputNotice(metaOf(result))).toContain("Some lines truncated to 300 chars");
	});
});
