/**
 * A language server that dies is reported with its exit code and stderr.
 *
 * WHY. When a server's output closes, the client's reader tore the client down at once unless the exit
 * was already recorded, rejecting every pending request with "LSP reader stopped; client torn down". A
 * process's closed output is routinely read before its exit is reaped, so a server that crashed during
 * its handshake (a Python entry point missing its module, say) was reported with that message instead of
 * its exit code and the stderr that names the cause. The reader now gives the exit a bounded moment to
 * land, and tears the client down only when the server outlives its output.
 *
 * The class closed is a server's death reported without its cause. Every order in which a dying server
 * can be observed is swept at the one place a client is started, `getOrCreateClient`: exit recorded
 * before the output closes, after it, and never. The last is bounded, so a server whose output broke
 * still fails the call within the grace instead of hanging it. The cause reaches the user through the
 * diagnostics action, which is checked once.
 *
 * WHAT THIS DOES NOT CATCH. A server that dies after its handshake rejects the requests then pending by
 * the same path, but only the handshake is driven here. A server whose exit lands later than the grace is
 * reported as a reader failure.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../../../utils/test/helpers/fake-time";
import { type FakeLspServer, installFakeLsp } from "../helpers/fake-lsp";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

const SERVER_NAME = "dying-ls";
const SERVER: ServerConfig = {
	command: SERVER_NAME,
	resolvedCommand: process.execPath,
	fileTypes: ["ts"],
	rootMarkers: [],
};

const STDERR = "ModuleNotFoundError: No module named 'dying_ls'";

interface Death {
	/** Ends the server as it receives `initialize`. */
	die(server: FakeLspServer): void;
	/** What the handshake is rejected with. */
	error: string;
}

/** Every order in which a dying server's closed output and its exit can reach the client. */
const DEATHS: Record<string, Death> = {
	"records its exit before its output closes": {
		die: server => server.exit(1),
		error: "LSP server exited unexpectedly (code 1)",
	},
	"closes its output before its exit is recorded": {
		die: server => server.crash(1, STDERR),
		error: `LSP server exited (code 1): ${STDERR}`,
	},
	"closes its output and lives on": {
		die: server => server.closeOutput(),
		error: "LSP reader stopped; client torn down",
	},
};

/** The grace a reader gives a closed server's exit, plus the turns the teardown takes. */
const READER_EXIT_BOUND_MS = 1_100;

function installDyingServer(death: Death): FakeLspServer {
	return installFakeLsp((message, server) => {
		if (message.method === "initialize") death.die(server);
	});
}

describe("a language server that dies during its handshake", () => {
	const temps: TempDir[] = [];

	beforeAll(() => initTheme());

	afterEach(async () => {
		vi.useRealTimers();
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		for (const temp of temps.splice(0)) temp.removeSync();
	});

	function workspace(): string {
		const temp = TempDir.createSync("@veyyon-lsp-dying-server-");
		temps.push(temp);
		return temp.path();
	}

	for (const [name, death] of Object.entries(DEATHS)) {
		it(`${name}: fails the start with its cause, within the reader's grace`, async () => {
			const dir = workspace();
			installDyingServer(death);
			installFakeTime();
			const started = Date.now();

			const start = lspClient.getOrCreateClient(SERVER, dir).then(
				() => "started",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			const outcome = await driveFakeTime(start);

			expect(outcome).toBe(death.error);
			expect(Date.now() - started).toBeLessThanOrEqual(READER_EXIT_BOUND_MS);
		});
	}

	it("is named with its stderr in the diagnostics action's report", async () => {
		const dir = workspace();
		fs.writeFileSync(path.join(dir, "app.ts"), "export const value = 0;\n");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { [SERVER_NAME]: SERVER },
			idleTimeoutMs: undefined,
			missingServers: [],
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([[SERVER_NAME, SERVER]]);
		installDyingServer(DEATHS["closes its output before its exit is recorded"]!);

		const result = await new LspTool(makeToolSession({ cwd: dir })).execute("lsp-diagnostics", {
			action: "diagnostics",
			file: "app.ts",
			timeout: 30,
		});

		expect(toolResultText(result)).toBe(
			[
				"No server checked the file",
				"  Server notes:",
				`  ${SERVER_NAME}: LSP server exited (code 1): ${STDERR}`,
			].join("\n"),
		);
	});
});
