/**
 * The host a desktop window attaches to states that a picture reached a screen.
 *
 * WHY THIS SUITE EXISTS:
 * `currentImageDisplayState()` is what every tool result carrying an image says
 * to the model, and the front end installs the answer: the terminal installs
 * one from its graphics protocol, and an uninstalled probe means no, which is
 * what a piped run does. The GUI host installed nothing. So a desktop session —
 * whose window decodes the payload and draws it through GPUI — appended "the
 * user cannot see this image" to every screenshot, diagram and rendered chart
 * the model had just produced, and a model that reads that sentence describes
 * the picture in prose or retries the capture.
 *
 * THE CLASS THIS CLOSES:
 * 1. A host that serves a drawing client and answers the probe with silence.
 * 2. A probe installed once and never handed back, which would leave the answer
 *    in force for a terminal front end in the same process after the host closes.
 * 3. `terminal.showImages` not reaching the desktop: the row is on its settings
 *    page, so turning it off has to change what the model is told there too.
 *
 * WHAT IT DOES NOT CATCH:
 * Whether the window drew a given payload. A picture it cannot decode is a
 * per-image outcome the block reports through the undrawn-call ledger, which
 * `only-the-front-end-says-whether-a-picture-reached-the-screen.test.ts` covers.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { settingsOrNull } from "../../src/config/settings-instance";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import {
	currentImageDisplayProbe,
	currentImageDisplayState,
	setImageDisplayProbe,
} from "../../src/session/image-visibility";

const scratchRoots: string[] = [];
const servers: GuiHostServer[] = [];

async function hostOn(label: string): Promise<GuiHostServer> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `veyyon-gui-images-${label}-`));
	scratchRoots.push(root);
	const server = await startGuiHostServer({
		endpoint: `unix:${path.join(root, "host.sock")}`,
		cwd: root,
		agentDir: root,
	});
	servers.push(server);
	return server;
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	setImageDisplayProbe(undefined);
	settingsOrNull()?.clearOverride("terminal.showImages");
	for (const root of scratchRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("a session served to the desktop says the picture reached the screen", async () => {
	setImageDisplayProbe(undefined);
	expect(currentImageDisplayState()).toEqual({ shown: false, reason: "no-protocol" });

	await hostOn("shown");

	expect(currentImageDisplayState()).toEqual({ shown: true });
});

test("closing the host hands the answer back to the front end that had it", async () => {
	setImageDisplayProbe(() => false);

	const server = await hostOn("restore");
	expect(currentImageDisplayState().shown).toBe(true);

	await server.close();

	expect(currentImageDisplayProbe()?.()).toBe(false);
	expect(currentImageDisplayState()).toEqual({ shown: false, reason: "no-protocol" });
});

test("the setting on the desktop's own settings page still decides", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-gui-images-setting-"));
	scratchRoots.push(root);
	await Settings.init({ cwd: root, agentDir: root });

	await hostOn("setting");
	expect(currentImageDisplayState()).toEqual({ shown: true });

	Settings.instance.override("terminal.showImages", false);

	expect(currentImageDisplayState()).toEqual({ shown: false, reason: "images-off" });
});
