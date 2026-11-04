/**
 * WHY: an action that holds a mouse button or a modifier key down while it does something else
 * released it only when that something finished. `tab.drag()` with natural input off pressed the
 * button, travelled and released; `tab.select()` held Control (Meta on macOS) while it clicked each
 * further option of a multiple select; a natural click held the button for its `delay` whatever the
 * signal said. When the op's deadline or the run's abort ended the wait while
 * the press or the travel was still running, the release was never sent. Puppeteer keeps the pressed
 * button and modifier in its own state, so on that tab every later press failed with "'left' is
 * already pressed" and every later click arrived as a Control-click, run after run, until the tab
 * closed.
 *
 * The contract, driven through the real tool against real headless Chromium: a page holds its main
 * thread inside the handler of the event the press or travel sends, so the op times out while that
 * input is still being dispatched; the op reports its timeout, and the next run's plain click on the
 * same tab lands as a plain click, with no button and no modifier held. Every member of the class is
 * covered: the button held during the press, the button held during the travel, in both input modes,
 * the modifier held during a multiple select's further click, and a natural click's hold.
 *
 * What it does not catch: a press held by run code through `page.mouse` or `page.keyboard`, which the
 * run owns; a release the browser itself fails to dispatch; and puppeteer's own click with a `delay`
 * past the op's deadline (natural input off), whose hold is a timer inside puppeteer that no signal
 * reaches, so the button stays down until that `delay` ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { CHROMIUM_AVAILABLE } from "./chromium";

/** The tool timeout of the run an op is cut short in, in seconds: it leaves each op 2 s. */
const CUT_TIMEOUT_S = 3;
/**
 * When the page lets go, counted from the run's start: after the op's 2 s deadline, so the op is cut
 * short while its input is still being dispatched, and before the run's 3 s one, so the run reports it.
 */
const HOLD_UNTIL_MS = 2_300;

const PAGE = `<!doctype html><title>held</title>
<style>
body{margin:0}
#a,#src,#dst,#multi{position:absolute;margin:0}
#a{left:40px;top:40px;width:120px;height:40px}
#src{left:100px;top:200px;width:100px;height:40px;background:#fa0}
#dst{left:500px;top:200px;width:160px;height:80px;background:#0a6}
#multi{left:40px;top:400px}
</style>
<button id="a">A</button><div id="src"></div><div id="dst"></div>
<select id="multi" multiple size="4"><option>One</option><option>Two</option><option>Three</option></select>
<script>
window.log = [];
window.hold = null;
let until = 0;
window.arm = h => { hold = h; until = performance.now() + ${HOLD_UNTIL_MS}; };
const busy = () => { while (performance.now() < until); };
addEventListener("mousedown", () => { if (hold === "press") { hold = null; busy(); } }, true);
addEventListener("pointermove", e => { if (hold === "travel" && e.buttons === 1) { hold = null; busy(); } }, true);
addEventListener("keydown", e => { if (hold === "modifier" && (e.key === "Control" || e.key === "Meta")) { hold = null; busy(); } }, true);
for (const type of ["mousedown", "mouseup", "click"]) {
	addEventListener(type, e => log.push({ type: e.type, target: e.target.id, buttons: e.buttons, ctrl: e.ctrlKey, meta: e.metaKey }), true);
}
</script>`;

interface Pressed {
	readonly type: string;
	readonly target: string;
	readonly buttons: number;
	readonly ctrl: boolean;
	readonly meta: boolean;
}

/** The action each case cuts short, and the page handler that holds it. */
const CASES: ReadonlyArray<{ name: string; hold: string; action: string; naturalInput: readonly boolean[] }> = [
	{ name: "a drag's press", hold: "press", action: 'tab.drag("#src", "#dst")', naturalInput: [false, true] },
	{ name: "a drag's travel", hold: "travel", action: 'tab.drag("#src", "#dst")', naturalInput: [false, true] },
	{
		name: "a multiple select's modified click",
		hold: "modifier",
		action: 'tab.select("#multi", "One", "Three")',
		naturalInput: [false],
	},
	// No page handler holds anything: the click's own `delay` outlasts the op's deadline.
	{
		name: "a natural click's hold",
		hold: "none",
		action: '(await tab.waitFor("#a")).click({ delay: 20000 })',
		naturalInput: [true],
	},
];

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

let server: http.Server;
let url = "";

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a press an abort cuts short", () => {
	for (const { name, hold, action, naturalInput: modes } of CASES) {
		for (const naturalInput of modes) {
			it(`is released after ${name}, natural input ${naturalInput ? "on" : "off"}`, async () => {
				const session: ToolSession = {
					cwd: process.cwd(),
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "browser.headless": true, "browser.naturalInput": naturalInput }),
				};
				const tool = new BrowserTool(session);
				const tab = `held-${hold}-${naturalInput}-${process.pid}`;
				try {
					await tool.execute("open", { action: "open", name: tab, url });
					const cut = await tool.execute("run", {
						action: "run",
						name: tab,
						timeout: CUT_TIMEOUT_S,
						code: `await tab.evaluate(h => window.arm(h), ${JSON.stringify(hold)});
try { await ${action}; return "completed"; } catch (error) { return error.message; }`,
					});
					// The op's own deadline cut it short; the run went on, so the tab kept its worker and its input state.
					expect(text(cut)).toContain(`timed out after ${(CUT_TIMEOUT_S - 1) * 1000}ms`);
					const after = await tool.execute("run", {
						action: "run",
						name: tab,
						timeout: 30,
						code: `await tab.evaluate(() => { log.length = 0; });
await tab.click("#a");
return JSON.stringify(await tab.evaluate(() => log));`,
					});
					const log = JSON.parse(text(after)) as Pressed[];
					expect(log.filter(event => event.type === "click")).toEqual([
						{ type: "click", target: "a", buttons: 0, ctrl: false, meta: false },
					]);
					expect(log.find(event => event.type === "mousedown")).toEqual({
						type: "mousedown",
						target: "a",
						buttons: 1,
						ctrl: false,
						meta: false,
					});
				} finally {
					await tool.execute("close", { action: "close", name: tab, kill: true });
				}
			}, 60_000);
		}
	}
});
