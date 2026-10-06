// Live proof for the `app.extension` backend, on a THROWAWAY Chrome profile (never the operator's Chrome).
//
//   VEYYON_EXT_UNPACKED=<dir with the unpacked Playwright Extension 0.4.0> \
//   PUPPETEER_EXECUTABLE_PATH=<Chrome for Testing> \
//   bun tools/test-browser-extension.mjs
//
// It starts the real ExtensionRelay, connects the extension to it, drives a page through puppeteer on the
// relay's CDP endpoint (no remote-debugging port on the browser), and prints a JSON receipt:
// served host, timings, refused-origin proof, user tabs untouched, and what an idle service worker does.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { setAgentDir } from "../packages/utils/src/dirs.ts";
import { spyOn } from "bun:test";
import { logger } from "@veyyon/utils";
import {
	EXTENSION_PROTOCOL_VERSION,
	PLAYWRIGHT_EXTENSION_ID,
	writeExtensionToken,
} from "../packages/coding-agent/src/tools/web/browser/extension-policy.ts";
import { buildConnectUrl, ExtensionRelay } from "../packages/coding-agent/src/tools/web/browser/extension-relay.ts";

const unpacked = process.env.VEYYON_EXT_UNPACKED;
const chrome = process.env.PUPPETEER_EXECUTABLE_PATH;
if (!unpacked || !chrome) throw new Error("Set VEYYON_EXT_UNPACKED and PUPPETEER_EXECUTABLE_PATH.");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-ext-live-agent-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-ext-live-profile-"));
setAgentDir(agentDir);

// The relay logs why it closed or refused something at debug level. Keep those lines (already redacted).
const relayLog = [];
spyOn(logger, "debug").mockImplementation((message, fields) => {
	relayLog.push(`${message} ${JSON.stringify(fields ?? {})}`.slice(0, 300));
});

const receipt = {
	head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
	steps: {},
	timingsMs: {},
};
const lap = (name, since) => {
	receipt.timingsMs[name] = Math.round(performance.now() - since);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const hits = new Map();
const web = Bun.serve({
	hostname: "0.0.0.0",
	port: 0,
	fetch: request => {
		const host = request.headers.get("host") ?? "?";
		const { pathname } = new URL(request.url);
		// Scripts for the worker cases. Fetching them is not a hit on a refused host, so they are not counted.
		if (pathname === "/worker.js") {
			return new Response("postMessage('worker-ran')", { headers: { "content-type": "text/javascript" } });
		}
		if (pathname === "/sw.js") {
			return new Response("self.addEventListener('fetch', () => {})", { headers: { "content-type": "text/javascript" } });
		}
		hits.set(host, (hits.get(host) ?? 0) + 1);
		return new Response(
			`<!doctype html><title>before</title><body style="margin:20px;font:20px sans-serif">
<input id=name placeholder="test account name"><button id=b onclick="document.title='clicked:'+document.getElementById('name').value">Save</button>`,
			{ headers: { "content-type": "text/html" } },
		);
	},
});
// The test server is on loopback, but a public page is what the sandbox covers, so Chrome maps two public-looking
// names to it. LocalNetworkAccessChecks is off only because these names resolve to loopback here; a real public
// site never does.
const pageHost = "qa.test";
const farHost = "far.test";
const pageUrl = `http://${pageHost}:${web.port}/`;
receipt.steps.servedHost = `${pageHost}:${web.port}`;

let owner;
let relay;
try {
	owner = await puppeteer.launch({
		executablePath: chrome,
		headless: true,
		userDataDir: profile,
		pipe: true,
		enableExtensions: [unpacked],
		args: [
			"--no-first-run",
			`--host-resolver-rules=MAP ${pageHost} 127.0.0.1, MAP ${farHost} 127.0.0.1`,
			"--disable-features=LocalNetworkAccessChecks",
			`--unsafely-treat-insecure-origin-as-secure=http://${pageHost}:${web.port}`,
		],
	});
	// A "user tab" that Veyyon must not touch.
	const userTab = await owner.newPage();
	await userTab.setContent("<title>user-tab</title>user work");

	const status = await owner.newPage();
	await status.goto(`chrome-extension://${PLAYWRIGHT_EXTENSION_ID}/status.html`);
	await sleep(1500);
	const token = await status.evaluate(() => localStorage.getItem("auth-token"));
	if (!token) throw new Error("The extension showed no token.");
	writeExtensionToken("live", token);
	await status.close();

	const audits = [];
	relay = ExtensionRelay.start({
		policy: { allow: [pageHost, farHost, "127.0.0.1", "localhost"] },
		instance: "live",
		scrub: [token],
		onAudit: entry => audits.push(entry),
	});
	const connectPage = await owner.newPage();
	const t0 = performance.now();
	connectPage
		.goto(
			buildConnectUrl({
				extensionId: PLAYWRIGHT_EXTENSION_ID,
				protocolVersion: EXTENSION_PROTOCOL_VERSION,
				relayUrl: relay.extensionUrl,
				token,
				clientName: "veyyon-live-qa",
			}),
		)
		.catch(() => {});
	await relay.waitForExtension(30_000);
	lap("connect", t0);
	receipt.steps.connected = true;
	receipt.steps.remoteDebuggingPortOnBrowser = false;

	const t1 = performance.now();
	const browser = await puppeteer.connect({ browserWSEndpoint: relay.cdpUrl, protocolTimeout: 30_000 });
	const page = await browser.newPage();
	lap("newPage", t1);

	const t2 = performance.now();
	await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
	lap("goto", t2);
	receipt.steps.titleBefore = await page.title();
	// puppeteer evaluates in its own world; a page's own scripts run in the main world, where the relay's
	// guard lives. Cases that must behave like page code run through this helper.
	const mainWorld = (fn, arg) =>
		page.evaluate(
			(code, json) => {
				const el = document.createElement("script");
				el.textContent = `(${code})(${json})`;
				document.documentElement.append(el);
				el.remove();
			},
			fn.toString(),
			JSON.stringify(arg ?? null),
		);
	await mainWorld(() => {
		document.documentElement.dataset.guard = String(window.__veyyonPopupGuard);
	});
	receipt.steps.guardInstalledInMainWorld = await page.evaluate(() => document.documentElement.dataset.guard);

	const t3 = performance.now();
	await page.type("#name", "QA-live");
	await page.click("#b");
	await sleep(300);
	receipt.steps.titleAfter = await page.title();
	lap("fillAndClick", t3);

	const t4 = performance.now();
	const png = await page.screenshot({ type: "png" });
	lap("screenshot", t4);
	receipt.steps.screenshotBytes = png.length;
	fs.writeFileSync(process.env.VEYYON_EXT_SHOT ?? path.join(agentDir, "live.png"), png);

	// Refused origin: the relay must stop it before Chrome sees it.
	const refused = await browser.newPage().then(
		() => "opened",
		error => String(error.message).slice(0, 200),
	);
	receipt.steps.nonAllowlistedAboutBlank = refused;
	const blocked = await page.goto("https://example.com/", { waitUntil: "domcontentloaded" }).then(
		() => "navigated",
		error => String(error.message).slice(0, 200),
	);
	receipt.steps.nonAllowlistedNavigation = blocked;

	await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
	// Each case to a refused host (127.0.0.2 reaches the same server, so any request that leaves Chrome shows
	// up in `hits` under its Host header). Refused means zero hits. Cases run one after the other.
	const refusedBase = `http://127.0.0.2:${web.port}/`;
	const crossSite = `http://${farHost}:${web.port}/`;
	const refusedKey = `127.0.0.2:${web.port}`;
	const refusedHits = () => hits.get(refusedKey) ?? 0;
	const cases = {};
	await page.evaluate(src => {
		const frame = document.createElement("iframe");
		frame.src = src;
		document.body.append(frame);
	}, crossSite);
	await sleep(2000);
	receipt.steps.oopifAllowedHits = hits.get(`${farHost}:${web.port}`) ?? 0;
	await page.evaluate(src => {
		const frame = document.createElement("iframe");
		frame.src = src;
		document.body.append(frame);
	}, refusedBase);
	await sleep(3000);
	cases.crossSiteIframe = refusedHits();
	await mainWorld(src => window.open(src, "_blank"), refusedBase);
	await sleep(3000);
	cases.popup = refusedHits() - cases.crossSiteIframe;
	await page.evaluate(src => {
		location.href = src;
	}, refusedBase);
	await sleep(3000);
	cases.scriptNavigation = refusedHits() - cases.crossSiteIframe - cases.popup;
	const mark = () => refusedHits();
	const resetPage = async () => {
		await page.goto(pageUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
		await sleep(500);
	};
	const probe = async (name, run) => {
		await resetPage();
		const before = mark();
		await run();
		await sleep(3000);
		cases[name] = mark() - before;
	};
	await probe("formSubmitTargetBlank", () =>
		mainWorld(src => {
			const form = document.createElement("form");
			form.method = "post";
			form.action = src;
			form.target = "_blank";
			document.body.append(form);
			form.submit();
		}, refusedBase),
	);
	await probe("formRequestSubmitFormtarget", () =>
		mainWorld(src => {
			const form = document.createElement("form");
			form.method = "post";
			form.action = src;
			const button = document.createElement("button");
			button.setAttribute("formtarget", "_blank");
			form.append(button);
			document.body.append(form);
			form.requestSubmit(button);
		}, refusedBase),
	);
	await probe("baseTargetBlank", () =>
		page.evaluate(src => {
			const base = document.createElement("base");
			base.target = "_blank";
			document.head.append(base);
			const link = document.createElement("a");
			link.href = src;
			link.textContent = "go";
			document.body.append(link);
			link.click();
		}, refusedBase),
	);
	const shadowLink = src =>
		page.evaluate(href => {
			const host = document.createElement("div");
			host.style.cssText = "position:fixed;left:200px;top:200px;width:200px;height:60px";
			document.body.append(host);
			const root = host.attachShadow({ mode: "open" });
			const link = document.createElement("a");
			link.href = href;
			link.target = "_blank";
			link.style.cssText = "display:block;width:200px;height:60px";
			link.textContent = "shadow";
			root.append(link);
		}, src);
	await probe("shadowDomCtrlClick", async () => {
		await shadowLink(refusedBase);
		await page.keyboard.down("Control");
		await page.mouse.click(250, 220);
		await page.keyboard.up("Control");
	});
	await probe("middleClick", async () => {
		await shadowLink(refusedBase);
		await page.mouse.click(250, 220, { button: "middle" });
	});
	await resetPage();
	receipt.steps.refusedRequestsReceivedPerCase = cases;
	receipt.steps.refusedHostRequestsReceived = refusedHits();
	receipt.steps.audits = audits;
	receipt.steps.refusedPopupTabsLeft = (await owner.pages()).filter(p => p.url().includes("127.0.0.2")).length;

	// Workers and service workers (https://github.com/Wladefant/veyyon/issues/493). Chrome has no Fetch gate
	// for either, so a controlled tab must not create one, from any realm or by any constructor path.
	// qa.test is treated as a secure context (a service worker needs one) and is a public host, so it gets
	// the response header; localhost is a secure context too but a local-network page, so it does not.
	const localUrl = `http://localhost:${web.port}/`;
	const probeWorkers = async () => {
		await mainWorld(() => {
			const out = document.documentElement.dataset;
			for (const key of Object.keys(out)) delete out[key];
			const watch = (key, make) => {
				try {
					const worker = make();
					out[key] = "created";
					worker.onmessage = () => {
						out[key] = "ran";
					};
					worker.onerror = () => {
						out[key] = "error";
					};
				} catch (error) {
					out[key] = `rejected:${error.name}`;
				}
			};
			watch("dedicated", () => new Worker("/worker.js"));
			watch("blob", () => new Worker(URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" }))));
			watch("data", () => new Worker("data:text/javascript,postMessage(1)"));
			watch("shared", () => new SharedWorker("/worker.js"));
			const frame = document.createElement("iframe");
			frame.srcdoc = "<!doctype html>";
			frame.onload = () => watch("iframe", () => new frame.contentWindow.Worker("/worker.js"));
			document.body.append(frame);
			const register = (key, call) => {
				if (!navigator.serviceWorker) {
					out[key] = "no serviceWorker API";
					return;
				}
				call().then(
					() => {
						out[key] = "registered";
					},
					error => {
						out[key] = `rejected:${error.name}`;
					},
				);
			};
			register("swInstance", () => navigator.serviceWorker.register("/sw.js"));
			register("swPrototype", () =>
				ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/sw.js"),
			);
		});
		await sleep(3000);
		return page.evaluate(() => ({ ...document.documentElement.dataset }));
	};
	await resetPage();
	receipt.steps.workersGuardOnPublic = await probeWorkers();
	await page.goto(localUrl, { waitUntil: "domcontentloaded" });
	receipt.steps.workersGuardOnLocal = await probeWorkers();
	// A client must not be able to switch the service worker bypass back off.
	const bypassSession = await page.createCDPSession();
	receipt.steps.bypassUndoRefused = await bypassSession.send("Network.setBypassServiceWorker", { bypass: false }).then(
		() => false,
		error => String(error.message).slice(0, 120),
	);

	// Negative control: a real click (user gesture, so Chrome's popup blocker allows it) opens a popup to the
	// refused host. Guard on: it must send nothing. Guard removed: the response sandbox alone must still send
	// nothing, also for a `noopener` popup that no auto-attach reaches. Before the sandbox existed, the
	// guard-removed case leaked 2 requests (measured 2026-10-05, base 676e14674635b342156397d65f5a6e4725665658).
	const popupDetails = [];
	const popupByClick = async (features = "") => {
		await resetPage();
		await mainWorld(({ src, features }) => {
			const button = document.createElement("button");
			button.id = "popbtn";
			button.textContent = "pop";
			button.style.cssText = "position:fixed;left:50px;top:300px;width:200px;height:60px";
			button.onclick = () => {
				document.documentElement.dataset.clicked = "yes";
				const opened = window.open(src, "_blank", features);
				document.documentElement.dataset.opened = String(opened);
			};
			document.body.append(button);
		}, { src: refusedBase, features });
		const before = refusedHits();
		let created = 0;
		const onCreated = () => created++;
		owner.on("targetcreated", onCreated);
		await page.mouse.click(150, 330);
		await sleep(3000);
		owner.off("targetcreated", onCreated);
		const state = await page
			.evaluate(() => ({ clicked: document.documentElement.dataset.clicked, opened: document.documentElement.dataset.opened }))
			.catch(() => "evaluate failed");
		popupDetails.push({ ...state, newTargets: created });
		return refusedHits() - before;
	};
	const guardOn = await popupByClick();
	const control = await page.createCDPSession();
	const removed = [];
	for (let id = 1; id <= 8; id++) {
		const done = await control.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: String(id) }).then(
			() => true,
			() => false,
		);
		if (done) removed.push(id);
	}
	const guardOff = await popupByClick();
	const guardOffNoopener = await popupByClick("noopener");
	await mainWorld(() => {
		document.documentElement.dataset.guard = String(window.__veyyonPopupGuard);
	});
	receipt.steps.negativeControl = {
		guardOn,
		guardOff,
		guardOffNoopener,
		removedScriptIds: removed,
		popupDetails,
		guardPresentAfterRemoval: await page.evaluate(() => document.documentElement.dataset.guard),
	};

	// Guard removed (the script ids were removed above, so new documents get none). On a public page the
	// response header alone must still stop every worker and every service worker. On a local-network page
	// there is no header: a worker is created, but the relay cannot pause it, so it must be closed and
	// never run; a service worker registers there, which is the documented gap of a local-network page.
	await resetPage();
	const offPublic = await probeWorkers();
	await page.goto(localUrl, { waitUntil: "domcontentloaded" });
	const offLocal = await probeWorkers();
	receipt.steps.workersGuardOff = { public: offPublic, local: offLocal };
	const noneCreated = r => !Object.values(r).some(v => ["ran", "registered", "created"].includes(v));
	const refusedAll = r => Object.values(r).every(v => String(v).startsWith("rejected") || v === "error");
	receipt.steps.workersOk =
		refusedAll(receipt.steps.workersGuardOnPublic) &&
		refusedAll(receipt.steps.workersGuardOnLocal) &&
		typeof receipt.steps.bypassUndoRefused === "string" &&
		noneCreated(offPublic) &&
		!["dedicated", "blob", "data", "iframe"].some(key => offLocal[key] === "ran") &&
		["dedicated", "blob", "data"].every(key => offLocal[key] === "created") &&
		offLocal.swInstance === "registered" &&
		relayLog.some(line => line.includes("could not gate a child session"));

	// User tabs untouched.
	const userTitles = await Promise.all((await owner.pages()).map(p => p.title().catch(() => "?")));
	receipt.steps.userTabStillThere = userTitles.includes("user-tab");

	// Idle service worker: stop it and record what the relay and the client see.
	const worker = owner.targets().find(t => t.type() === "service_worker" && t.url().includes(PLAYWRIGHT_EXTENSION_ID));
	if (worker) {
		const session = await worker.createCDPSession();
		const tIdle = performance.now();
		await session.send("ServiceWorker.enable").catch(() => {});
		await session.send("ServiceWorker.stopAllWorkers").catch(() => {});
		await sleep(3000);
		lap("idleObserve", tIdle);
		receipt.steps.afterWorkerStop = {
			extensionConnected: relay.extensionConnected,
			clientConnected: browser.connected,
			nextCommand: await page.title().then(
				title => `ok:${title}`,
				error => String(error.message).slice(0, 200),
			),
		};
	} else {
		receipt.steps.afterWorkerStop = "no extension service worker target found";
	}

	const t5 = performance.now();
	const detached = await relay.disconnect();
	lap("disconnect", t5);
	receipt.steps.detachedTabs = detached;
	receipt.steps.relayLog = relayLog.slice(0, 20);
	receipt.ok =
		receipt.steps.titleBefore === "before" &&
		receipt.steps.titleAfter === "clicked:QA-live" &&
		receipt.steps.screenshotBytes > 500 &&
		receipt.steps.nonAllowlistedNavigation !== "navigated" &&
		receipt.steps.userTabStillThere === true &&
		receipt.steps.oopifAllowedHits > 0 &&
		receipt.steps.refusedHostRequestsReceived === 0 &&
		receipt.steps.negativeControl.guardOn === 0 &&
		receipt.steps.negativeControl.guardOff === 0 &&
		receipt.steps.negativeControl.guardOffNoopener === 0 &&
		receipt.steps.workersOk === true;
} catch (error) {
	receipt.error = String(error?.message ?? error);
	receipt.ok = false;
} finally {
	await relay?.close().catch(() => {});
	await owner?.close().catch(() => {});
	web.stop(true);
	fs.rmSync(profile, { recursive: true, force: true });
	fs.rmSync(agentDir, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
process.exit(receipt.ok ? 0 : 1);
