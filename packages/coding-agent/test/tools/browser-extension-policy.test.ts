import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertLoopbackUrl,
	checkCdpMethod,
	checkNavigation,
	isLoopbackHost,
	isProductionUrl,
	readExtensionToken,
	redactSecrets,
	removeExtensionToken,
	secretsEqual,
	writeExtensionToken,
} from "@veyyon/coding-agent/tools/web/browser/extension-policy";
import { setAgentDir } from "@veyyon/utils";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-ext-policy-"));
	setAgentDir(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("loopback guard", () => {
	test("accepts only loopback hosts", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("192.168.1.5")).toBe(false);
		expect(isLoopbackHost("example.com")).toBe(false);
	});

	test("a non-loopback relay URL is refused", () => {
		expect(() => assertLoopbackUrl("ws://127.0.0.1:4000/extension/x")).not.toThrow();
		expect(() => assertLoopbackUrl("ws://0.0.0.0:4000/extension/x")).toThrow("loopback");
		expect(() => assertLoopbackUrl("ws://example.com:4000/extension/x")).toThrow("loopback");
		expect(() => assertLoopbackUrl("wss://127.0.0.1/x")).toThrow("ws: or http:");
	});
});

describe("navigation policy", () => {
	test("allows unlisted HTTPS origins regardless of obsolete policy.json allow entries", () => {
		fs.mkdirSync(path.join(dir, "browser-extension"), { recursive: true });
		fs.writeFileSync(path.join(dir, "browser-extension", "policy.json"), JSON.stringify({ allow: [] }));
		expect(checkNavigation("https://unlisted.example.com/")).toEqual({ allowed: true });
	});

	test("about:blank passes; unsupported schemes and malformed URLs fail", () => {
		expect(checkNavigation("about:blank")).toEqual({ allowed: true });
		expect(checkNavigation("file:///etc/passwd")).toMatchObject({ allowed: false });
		expect(checkNavigation("chrome://settings")).toMatchObject({ allowed: false });
		expect(checkNavigation("not a url")).toMatchObject({ allowed: false });
	});

	test("production hosts are refused", () => {
		for (const url of [
			"https://zaraprptkegxqpvnsubu.supabase.co/rest",
			"https://akamai-iad-prod.example.com/",
			"https://polysimulator.com/",
			"https://www.polysimulator.com/",
		]) {
			const decision = checkNavigation(url);
			expect(decision).toMatchObject({ allowed: false });
			expect(decision.allowed ? "" : decision.reason).toContain("production host");
		}
	});

	test("only allowlisted CDP domains pass; Target, Browser, storage and cookie commands are refused", () => {
		for (const method of [
			"Page.printToPDF",
			"Network.getAllCookies",
			"Network.getCookies",
			"Storage.getCookies",
			"Target.createTarget",
			"Target.attachToTarget",
			"Target.setAutoAttach",
			"Target.setDiscoverTargets",
			"Browser.setDownloadBehavior",
			"Browser.getVersion",
			"DOMStorage.getDOMStorageItems",
			"IndexedDB.requestData",
			"Storage.clearDataForOrigin",
			"Fetch.disable",
			"Fetch.enable",
			"Page",
			"NoDotMethod",
		]) {
			expect(checkCdpMethod(method)).toMatchObject({ allowed: false });
		}
		for (const method of ["Runtime.evaluate", "Page.captureScreenshot", "Input.dispatchMouseEvent"]) {
			expect(checkCdpMethod(method)).toEqual({ allowed: true });
		}
	});

	test("production host normalization also applies to redirects", () => {
		for (const url of [
			"https://polysimulator.com./",
			"https://POLYSIMULATOR.COM../",
			"https://www.polysimulator.com.:8443/x",
			"https://zaraprptkegxqpvnsubu.supabase.co./rest",
			"https://x.akamai-iad-prod.example.",
		]) {
			const decision = checkNavigation(url);
			expect(decision.allowed).toBe(false);
			expect(decision.allowed ? "" : decision.reason).toContain("production host");
		}
		expect(checkNavigation("https://STAGING.example.com:443/")).toEqual({ allowed: true });
		expect(isProductionUrl("https://app.polysimulator.com./")).toBe(true);
		expect(isProductionUrl("https://example.com/")).toBe(false);
	});
});

describe("secrets", () => {
	test("comparison needs an exact, present value", () => {
		expect(secretsEqual("abcdefgh", "abcdefgh")).toBe(true);
		expect(secretsEqual("abcdefgh", "abcdefgx")).toBe(false);
		expect(secretsEqual("abcdefgh", undefined)).toBe(false);
		expect(secretsEqual("abcdefgh", "")).toBe(false);
	});

	test("token round trip uses one file per instance", () => {
		expect(readExtensionToken(undefined)).toBeUndefined();
		writeExtensionToken(undefined, " tok-default-123 \n");
		writeExtensionToken("work/profile", "tok-work-456");
		expect(readExtensionToken(undefined)).toBe("tok-default-123");
		expect(readExtensionToken("work/profile")).toBe("tok-work-456");
		expect(removeExtensionToken(undefined)).toBe(true);
		expect(removeExtensionToken(undefined)).toBe(false);
	});

	test("redaction removes every listed secret", () => {
		expect(
			redactSecrets("ws://x/extension/SECRET-VALUE-1 and SECRET-VALUE-2", ["SECRET-VALUE-1", "SECRET-VALUE-2"]),
		).toBe("ws://x/extension/[redacted] and [redacted]");
	});
});
