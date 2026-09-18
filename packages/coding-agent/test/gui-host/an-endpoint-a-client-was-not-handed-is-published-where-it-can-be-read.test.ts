/**
 * WHY: the `gui` command bound an endpoint and then told nobody but the
 * terminal it was started from. The desktop client survives that because it
 * either passes the endpoint or derives the default socket itself, but a client
 * that does neither — the standalone Telegram bot daemon — had no endpoint to
 * dial, and on Windows the only workable endpoint is `tcp:` with a port the
 * operator did not choose. The class this closes is a host that is listening and
 * undiscoverable.
 *
 * The assertions go through a real bound server rather than a fixed string, so
 * what lands in the file is the endpoint a client can actually connect to,
 * including the port the OS picked for `tcp:127.0.0.1:0`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import {
	ENDPOINT_FILENAME,
	guiHostEndpointPath,
	publishGuiHostEndpoint,
	withdrawGuiHostEndpoint,
} from "../../src/gui-host/endpoint-file";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

describe("an endpoint a client was not handed is published where it can be read", () => {
	let server: GuiHostServer | null = null;
	let tempDir: string | null = null;

	afterEach(async () => {
		await server?.close();
		server = null;
		if (tempDir !== null) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	test("the published file names the bound endpoint, and a client reaching only that file connects", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-endpoint-"));
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage: await isolatedAuthStorage(tempDir),
		});

		const written = publishGuiHostEndpoint(server.endpoint, tempDir);
		expect(written).toBe(path.join(tempDir, ENDPOINT_FILENAME));

		// The OS chose the port, so a file holding the requested ":0" would be
		// useless. Read it back the way a client does.
		const fromFile = (await fs.readFile(written, "utf8")).trim();
		expect(fromFile).toBe(server.endpoint);
		expect(fromFile).toMatch(/^tcp:127\.0\.0\.1:\d+$/);
		expect(fromFile).not.toContain(":0");

		const client = await TestSocketClient.connect(fromFile);
		try {
			expect(await client.nextFrame()).toBeDefined();
		} finally {
			client.destroy();
		}
	});

	test("a clean shutdown withdraws the file, and a successor's endpoint is left alone", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-endpoint-"));
		const target = guiHostEndpointPath(tempDir);

		publishGuiHostEndpoint("tcp:127.0.0.1:7699", tempDir);
		expect(withdrawGuiHostEndpoint("tcp:127.0.0.1:7699", tempDir)).toBe(true);
		expect(await fs.exists(target)).toBe(false);

		// Withdrawing what is not there is not an error: a host that crashed and
		// was replaced must not make its successor's shutdown throw.
		expect(withdrawGuiHostEndpoint("tcp:127.0.0.1:7699", tempDir)).toBe(false);

		// A second host took the file over. The first one shutting down must not
		// delete it, or the live host becomes undiscoverable.
		publishGuiHostEndpoint("tcp:127.0.0.1:8800", tempDir);
		expect(withdrawGuiHostEndpoint("tcp:127.0.0.1:7699", tempDir)).toBe(false);
		expect((await fs.readFile(target, "utf8")).trim()).toBe("tcp:127.0.0.1:8800");
	});

	test("publishing creates the agent directory it writes into", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-endpoint-"));
		const nested = path.join(tempDir, "profiles", "work", "agent");

		const written = publishGuiHostEndpoint("unix:/tmp/veyyon-gui.sock", nested);

		expect(written).toBe(path.join(nested, ENDPOINT_FILENAME));
		expect((await fs.readFile(written, "utf8")).trim()).toBe("unix:/tmp/veyyon-gui.sock");
	});
});
