/**
 * A `diagnostics` call reports what the server's compiler check found.
 *
 * WHY. rust-analyzer's own analysis finds syntax errors and unresolved names; type errors, borrow errors
 * and lints come from `cargo check`, which rust-analyzer runs only when asked. Its default
 * configuration here does not run the check on save, and the `flycheck` capability it declares was read
 * by nothing, so the `diagnostics` action reported a file that does not compile as `OK`. The action now
 * asks a server declaring `flycheck` for its check and waits for the check to end.
 *
 * The class closed is a check's findings missing from the report, and a check that outlives the call
 * reported as clean. Every way a check can end against the call's budget is swept: it publishes and
 * ends, it ends and publishes after (rust-analyzer handles a fast check's results in one pass, ending
 * the check's progress before it publishes), it never starts, and it never ends. The last two are
 * reported as notes, and the last is bounded by the call's timeout. A server without the capability is
 * asked for no check, and a batch asks each server for one check of every workspace.
 *
 * WHAT THIS DOES NOT CATCH. Diagnostics after a write still come from the server's own analysis. A
 * check that begins later than the start grace is reported as not started.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { Diagnostic, LspParams, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { fileToUri } from "@veyyon/coding-agent/lsp/utils";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../../../utils/test/helpers/fake-time";
import { type FakeLspHandler, type FakeLspServer, installFakeLsp, type RpcMessage } from "../helpers/fake-lsp";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

const SERVER_NAME = "fake-ra";
const CHECKED: ServerConfig = {
	command: SERVER_NAME,
	resolvedCommand: process.execPath,
	fileTypes: ["rs"],
	rootMarkers: [],
	capabilities: { flycheck: true },
};
const UNCHECKED: ServerConfig = { ...CHECKED, capabilities: {} };

const COMPILER_ERROR: Diagnostic = {
	range: { start: { line: 1, character: 17 }, end: { line: 1, character: 20 } },
	severity: 1,
	source: "rustc",
	code: "E0308",
	message: "mismatched types",
};
const FOUND = "1 error(s):\n# app.rs\n  2:18 [error] [rustc] mismatched types (E0308)";

const TIMEOUT_SEC = 5;
/** A check that has not begun this long after it was asked for is taken as not started. */
const START_GRACE_MS = 1_000;

type CheckEnd = "publishes then ends" | "ends then publishes" | "never starts" | "never ends";

/** What the call reports for each way the check ends, and the bounds on how long the call takes. */
const CHECK_ENDS: Record<CheckEnd, { readonly report: string; readonly minMs: number; readonly maxMs: number }> = {
	"publishes then ends": { report: FOUND, minMs: 0, maxMs: START_GRACE_MS - 1 },
	"ends then publishes": { report: FOUND, minMs: 0, maxMs: START_GRACE_MS - 1 },
	"never starts": {
		report: `No issues from ${SERVER_NAME}\n  Server notes:\n  ${SERVER_NAME}: no compiler check started; only the server's own analysis is reported`,
		minMs: START_GRACE_MS,
		maxMs: START_GRACE_MS + 100,
	},
	"never ends": {
		report: `No issues from ${SERVER_NAME}\n  Server notes:\n  ${SERVER_NAME}: cargo check was still running at the ${TIMEOUT_SEC}s timeout, so its errors are not reported; raise \`timeout\` to wait for it`,
		minMs: 1_000,
		maxMs: TIMEOUT_SEC * 1000 - 1,
	},
};

/**
 * A server whose own analysis finds nothing, and whose compiler check, once asked for, finds
 * {@link COMPILER_ERROR} in the file it was asked about, or in every `.rs` file of `dir` for a check of
 * every workspace, and ends as `end` says. Like rust-analyzer, it publishes a file's check findings with
 * its own analysis every time it publishes that file.
 */
function serverWhoseCheck(end: CheckEnd, dir: string): FakeLspHandler {
	const versions = new Map<string, number | null>();
	const failing = new Set<string>();
	let trailing: (() => void) | undefined;
	const progress = (server: FakeLspServer, kind: string) =>
		server.send({
			jsonrpc: "2.0",
			method: "$/progress",
			params: {
				token: "rust-analyzer/flycheck/0",
				value: { kind, title: kind === "begin" ? "cargo check" : undefined },
			},
		});
	const publish = (server: FakeLspServer, uri: string) =>
		server.send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, version: versions.get(uri) ?? null, diagnostics: failing.has(uri) ? [COMPILER_ERROR] : [] },
		});
	const check = (server: FakeLspServer, scope: { uri: string } | null) => {
		const uris = scope
			? [scope.uri]
			: fs
					.readdirSync(dir)
					.filter(name => name.endsWith(".rs"))
					.map(name => fileToUri(path.join(dir, name)));
		for (const uri of uris) failing.add(uri);
		return () => {
			for (const uri of uris) publish(server, uri);
		};
	};
	return (message, server) => {
		if (message.method === "exit") {
			server.exit(0);
			return;
		}
		if (message.method === "textDocument/didOpen") {
			const { uri, version } = (message.params as { textDocument: { uri: string; version: number } }).textDocument;
			versions.set(uri, version);
			publish(server, uri);
			return;
		}
		if (message.method === "rust-analyzer/runFlycheck") {
			if (end === "never starts") return;
			progress(server, "begin");
			if (end === "never ends") return;
			const publishFindings = check(
				server,
				(message.params as { textDocument: { uri: string } | null }).textDocument,
			);
			if (end === "publishes then ends") {
				publishFindings();
				progress(server, "end");
			} else {
				progress(server, "end");
				trailing = publishFindings;
			}
			return;
		}
		if (message.id === undefined || message.method === undefined) return;
		trailing?.();
		trailing = undefined;
		const result = message.method === "initialize" ? { capabilities: {} } : null;
		server.send({ jsonrpc: "2.0", id: message.id, result });
	};
}

function isCheckRequest(message: RpcMessage): boolean {
	return message.method === "rust-analyzer/runFlycheck";
}

describe("a diagnostics call to a server with a compiler check", () => {
	const temps: TempDir[] = [];

	beforeAll(() => initTheme());

	afterEach(async () => {
		vi.useRealTimers();
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		for (const temp of temps.splice(0)) temp.removeSync();
	});

	/** A workspace of `count` Rust files checked by `server` alone. */
	function workspace(server: ServerConfig, count = 1): string {
		const temp = TempDir.createSync("@veyyon-lsp-compiler-check-");
		temps.push(temp);
		const dir = temp.path();
		for (let i = 0; i < count; i++) {
			fs.writeFileSync(path.join(dir, i === 0 ? "app.rs" : `app${i}.rs`), 'fn main() {\n    let x: u32 = "s";\n}\n');
		}
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { [SERVER_NAME]: server },
			idleTimeoutMs: undefined,
			missingServers: [],
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([[SERVER_NAME, server]]);
		return dir;
	}

	function diagnostics(dir: string, file: string): Promise<string> {
		const params: LspParams = { action: "diagnostics", file, timeout: TIMEOUT_SEC };
		return new LspTool(makeToolSession({ cwd: dir })).execute("lsp-diagnostics", params).then(toolResultText);
	}

	for (const [end, expected] of Object.entries(CHECK_ENDS) as Array<[CheckEnd, (typeof CHECK_ENDS)[CheckEnd]]>) {
		it(`whose check ${end} reports what it found, within the call's timeout`, async () => {
			const dir = workspace(CHECKED);
			const server = installFakeLsp(serverWhoseCheck(end, dir));
			installFakeTime();
			const started = performance.now();

			const report = await driveFakeTime(diagnostics(dir, "app.rs"));
			const elapsed = performance.now() - started;

			expect(report).toBe(expected.report);
			expect(elapsed).toBeGreaterThanOrEqual(expected.minMs);
			expect(elapsed).toBeLessThanOrEqual(expected.maxMs);
			expect(server.received.filter(isCheckRequest).map(message => message.params)).toEqual([
				{ textDocument: { uri: fileToUri(path.join(dir, "app.rs")) } },
			]);
		});
	}

	it("asks a server that declares no compiler check for none", async () => {
		const dir = workspace(UNCHECKED);
		const server = installFakeLsp(serverWhoseCheck("publishes then ends", dir));

		expect(await diagnostics(dir, "app.rs")).toBe("OK");
		expect(server.received.filter(isCheckRequest)).toEqual([]);
	});

	it("asks each server for one check of every workspace for a batch", async () => {
		const dir = workspace(CHECKED, 3);
		const server = installFakeLsp(serverWhoseCheck("publishes then ends", dir));

		const report = await diagnostics(dir, "*.rs");

		expect(server.received.filter(isCheckRequest).map(message => message.params)).toEqual([{ textDocument: null }]);
		expect(report.split("\n").filter(line => line.includes("mismatched types"))).toHaveLength(3);
	});
});
