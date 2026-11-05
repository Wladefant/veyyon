/**
 * A language server or linter that fails is reported, never counted as a clean check.
 *
 * WHY. The `lsp` diagnostics action and the diagnostics a write reports each ask every server that
 * handles the file and merge the answers, and both dropped a server whose answer threw. A type checker
 * that died on start left the file reported `OK`, or reported with only a linter's findings, so a type
 * error stayed hidden behind a clean result. A failed server is now named with its error, and a file no
 * server checked is reported as not checked.
 *
 * The class closed is a failed checker read as a clean one. It is swept over both surfaces that merge
 * servers' answers (the action for one file and for a batch, and a write), for each way a checker fails
 * (a language server that dies during its handshake, a linter whose run throws), alone and beside a
 * server that answered clean or with a finding. Each result is pinned against the same call without the
 * failing checker, so the only difference a failure makes is the report of it.
 *
 * WHAT THIS DOES NOT CATCH. A server that answers its handshake and never publishes is reported clean
 * once the wait budget ends, as before: its silence is indistinguishable from a clean file. The
 * file-bound actions report a failed server as a tool error and are
 * `every-file-bound-lsp-action-reports-what-the-server-answered.test.ts`'s.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import { clearLinterClientCache } from "@veyyon/coding-agent/lsp/clients";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { FileDiagnosticsResult } from "@veyyon/coding-agent/lsp/diagnostics";
import type { Diagnostic, LspParams, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { createLspWritethrough } from "@veyyon/coding-agent/lsp/writethrough";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TempDir } from "@veyyon/utils";
import { installFakeLsp } from "../helpers/fake-lsp";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

const BAD: Diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	severity: 1,
	message: "bad value",
	source: "good-lint",
};

/** A linter that answers every file with `diagnostics`. */
function linter(name: string, lint: () => Promise<Diagnostic[]>): [string, ServerConfig] {
	return [
		name,
		{
			command: name,
			fileTypes: ["ts"],
			rootMarkers: [],
			isLinter: true,
			createClient: () => ({ format: async (_file, content) => content, lint }),
		},
	];
}

interface Failing {
	server: [string, ServerConfig];
	/** The reason the failure is reported with: its error's message. */
	reason: RegExp;
}

/** Every way a checker fails, each installing what makes it fail. */
const FAILING: Record<string, () => Failing> = {
	"a language server that dies during its handshake": () => {
		installFakeLsp((message, server) => {
			if (message.method === "initialize") server.exit(1);
		});
		return {
			server: [
				"dying-ls",
				{ command: "dying-ls", resolvedCommand: process.execPath, fileTypes: ["ts"], rootMarkers: [] },
			],
			reason: /^.+$/,
		};
	},
	"a linter whose run throws": () => ({
		server: linter("broken-lint", () => Promise.reject(new Error("linter crashed"))),
		reason: /^linter crashed$/,
	}),
};

/** What else checks the file: nothing, a server that finds nothing, a server that finds `BAD`. */
const COMPANIONS: Record<string, Array<[string, ServerConfig]>> = {
	alone: [],
	"beside a server that answered clean": [linter("good-lint", async () => [])],
	"beside a server that reported a finding": [linter("good-lint", async () => [BAD])],
};

interface Workspace {
	dir: string;
	files: string[];
}

function workspace(temps: TempDir[], servers: Array<[string, ServerConfig]>, fileCount: number): Workspace {
	const temp = TempDir.createSync("@veyyon-lsp-failed-checker-");
	temps.push(temp);
	const files = Array.from({ length: fileCount }, (_, i) => {
		const file = path.join(temp.path(), `f${i}.ts`);
		fs.writeFileSync(file, "export const value = 0;\n");
		return file;
	});
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
		servers: Object.fromEntries(servers),
		idleTimeoutMs: undefined,
		missingServers: [],
	});
	vi.spyOn(lspConfig, "getServersForFile").mockReturnValue(servers);
	return { dir: temp.path(), files };
}

interface ActionReport {
	text: string;
	success: boolean | undefined;
}

async function diagnosticsAction(ws: Workspace, file: string): Promise<ActionReport> {
	const params: LspParams = { action: "diagnostics", file, timeout: 30 };
	const result = await new LspTool(makeToolSession({ cwd: ws.dir })).execute("lsp-diagnostics", params);
	return { text: toolResultText(result), success: result.details?.success };
}

function writeReport(ws: Workspace): Promise<FileDiagnosticsResult | undefined> {
	const write = createLspWritethrough(ws.dir, { enableFormat: false, enableDiagnostics: true });
	return write(ws.files[0]!, "export const value = 1;\n");
}

/**
 * The action's report split into its own lines and the notes it appends for `failing`: one
 * `Server notes:` block per file, naming the failed checker with a reason `failing.reason` matches, and
 * closing that file's lines.
 */
function splitNotes(text: string, failing: Failing): { lines: string[]; notes: string[] } {
	const [name] = failing.server;
	const all = text.split("\n");
	const lines: string[] = [];
	const notes: string[] = [];
	for (let i = 0; i < all.length; i++) {
		if (all[i] !== "  Server notes:") {
			lines.push(all[i]!);
			continue;
		}
		const note = all[++i] ?? "";
		expect(note.startsWith(`  ${name}: `)).toBe(true);
		expect(note.slice(`  ${name}: `.length)).toMatch(failing.reason);
		expect(all[i + 1] ?? "f0.ts: ").toMatch(/^(\S+ )?f\d\.ts: /);
		notes.push(note);
	}
	return { lines, notes };
}

describe("a failed checker", () => {
	const temps: TempDir[] = [];

	// The batch report marks each file with a theme glyph.
	beforeAll(() => initTheme());

	afterEach(async () => {
		await lspClient.shutdownAll();
		clearLinterClientCache();
		vi.restoreAllMocks();
		for (const temp of temps.splice(0)) temp.removeSync();
	});

	for (const [failingName, makeFailing] of Object.entries(FAILING)) {
		for (const [companionName, companions] of Object.entries(COMPANIONS)) {
			describe(`${failingName}, ${companionName}`, () => {
				it("is named in the diagnostics action's report for one file", async () => {
					const control =
						companions.length > 0 ? await diagnosticsAction(workspace(temps, companions, 1), "f0.ts") : undefined;
					const failing = makeFailing();
					const report = await diagnosticsAction(workspace(temps, [failing.server, ...companions], 1), "f0.ts");

					const { lines, notes } = splitNotes(report.text, failing);
					expect(notes).toHaveLength(1);
					const reported = { text: lines.join("\n"), success: report.success };
					if (!control) {
						expect(reported).toEqual({ text: "No server checked the file", success: false });
					} else if (control.text === "OK") {
						expect(reported).toEqual({ text: "No issues from good-lint", success: true });
					} else {
						expect(reported).toEqual(control);
					}
				});

				it("is named under each file of the diagnostics action's batch report", async () => {
					const control =
						companions.length > 0 ? await diagnosticsAction(workspace(temps, companions, 2), "*.ts") : undefined;
					const failing = makeFailing();
					const report = await diagnosticsAction(workspace(temps, [failing.server, ...companions], 2), "*.ts");

					const { lines, notes } = splitNotes(report.text, failing);
					expect(notes).toHaveLength(2);
					const expected = control
						? control.text
								.split("\n")
								.map(line => line.replace(/^(\S+ f\d\.ts): no issues$/, "$1: no issues from good-lint"))
						: ["f0.ts", "f1.ts"].map(file => `${file}: no server checked the file`);
					const fileLines = control ? lines : lines.map(line => line.replace(/^\S+ /, ""));
					expect(fileLines.toSorted()).toEqual(expected.toSorted());
				});

				it("is named in the diagnostics a write reports", async () => {
					const control = companions.length > 0 ? await writeReport(workspace(temps, companions, 1)) : undefined;
					const failing = makeFailing();
					const report = await writeReport(workspace(temps, [failing.server, ...companions], 1));

					const [name] = failing.server;
					const note = report?.messages.at(-1) ?? "";
					expect(note.startsWith(`${name} did not check the file: `)).toBe(true);
					expect(note.slice(`${name} did not check the file: `.length)).toMatch(failing.reason);
					if (!control) {
						expect(report).toEqual({
							server: undefined,
							messages: [note],
							summary: "not checked",
							errored: false,
						});
					} else if (control.messages.length === 0) {
						expect(report).toEqual({ ...control, messages: [note], summary: "no issues from good-lint" });
					} else {
						expect(report).toEqual({ ...control, messages: [...control.messages, note] });
					}
				});
			});
		}
	}
});
