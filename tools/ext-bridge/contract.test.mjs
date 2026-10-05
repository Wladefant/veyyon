// Pins the Playwright Extension contract in docs/browser-extension-bridge.md to the constants the code uses.
// Run: node --test tools/ext-bridge/contract.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = relative => fs.readFileSync(new URL(relative, root), "utf8");

const doc = read("docs/browser-extension-bridge.md");
const policy = read("packages/coding-agent/src/tools/web/browser/extension-policy.ts");
const relay = read("packages/coding-agent/src/tools/web/browser/extension-relay.ts");

test("the documented extension id is the one the code uses", () => {
	const id = /PLAYWRIGHT_EXTENSION_ID = "([a-p]{32})"/.exec(policy)?.[1];
	assert.ok(id, "extension id constant not found");
	assert.ok(doc.includes(`\`${id}\``), "docs do not name the extension id");
	assert.ok(doc.includes(`/${id}`), "docs do not link the Web Store page for the id");
});

test("the documented protocol version is the one the code sends", () => {
	const version = /EXTENSION_PROTOCOL_VERSION = (\d+)/.exec(policy)?.[1];
	assert.ok(version, "protocol version constant not found");
	assert.ok(doc.includes(`protocolVersion=${version}`), "docs show another protocol version");
});

test("every documented extension method is used by the relay", () => {
	const methods = [
		"chrome.tabs.create",
		"chrome.tabs.remove",
		"chrome.debugger.attach",
		"chrome.debugger.detach",
		"chrome.debugger.sendCommand",
	];
	for (const method of methods) {
		assert.ok(doc.includes(method), `docs omit ${method}`);
		assert.ok(relay.includes(method), `relay never calls ${method}`);
	}
});

test("the documented events are the ones the relay handles", () => {
	for (const event of ["chrome.debugger.onEvent", "chrome.debugger.onDetach", "chrome.tabs.onCreated", "chrome.tabs.onRemoved"]) {
		assert.ok(doc.includes(event), `docs omit ${event}`);
		assert.ok(relay.includes(event), `relay does not handle ${event}`);
	}
});

test("the blocked production fragments are documented", () => {
	for (const fragment of ["zaraprptkegxqpvnsubu", "akamai-iad-prod", "polysimulator.com"]) {
		assert.ok(policy.includes(fragment), `policy does not block ${fragment}`);
		assert.ok(doc.includes(fragment), `docs omit ${fragment}`);
	}
});

test("the operator steps are numbered and name the commands that exist", () => {
	const steps = doc.split("## Operator install steps (one time)")[1]?.split("\n## ")[0] ?? "";
	const numbered = steps.split("\n").filter(line => /^\d+\. /.test(line));
	assert.ok(numbered.length >= 8, "fewer than 8 numbered steps");
	const command = read("packages/coding-agent/src/commands/browser-extension.ts");
	for (const action of ["set-token", "clear-token", "status", "disconnect"]) {
		assert.ok(command.includes(`"${action}"`), `CLI lacks ${action}`);
		assert.ok(doc.includes(`browser-extension ${action}`), `docs omit ${action}`);
	}
});
