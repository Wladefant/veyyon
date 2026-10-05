import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertLoopbackUrl,
	checkCdpMethod,
	checkNavigation,
	EXTENSION_ALLOW_ENV,
	isLoopbackHost,
	isProductionUrl,
	loadExtensionPolicy,
	policyFilePath,
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
	const policy = { allow: ["https://staging.example.com", "docs.example.org", "*.cdn.example.net"] };

	test("denies by default and allows listed origins and hosts", () => {
		expect(checkNavigation({ allow: [] }, "https://example.com/")).toMatchObject({ allowed: false });
		expect(checkNavigation(policy, "https://staging.example.com/a?b=1")).toEqual({ allowed: true });
		expect(checkNavigation(policy, "http://staging.example.com/")).toMatchObject({ allowed: false });
		expect(checkNavigation(policy, "https://docs.example.org/x")).toEqual({ allowed: true });
		expect(checkNavigation(policy, "https://a.cdn.example.net/x")).toEqual({ allowed: true });
		expect(checkNavigation(policy, "https://cdn.example.net/x")).toMatchObject({ allowed: false });
		expect(checkNavigation(policy, "https://evil.com/")).toMatchObject({ allowed: false });
	});

	test("about:blank is always allowed; other schemes are not", () => {
		expect(checkNavigation({ allow: [] }, "about:blank")).toEqual({ allowed: true });
		expect(checkNavigation(policy, "file:///etc/passwd")).toMatchObject({ allowed: false });
		expect(checkNavigation(policy, "chrome://settings")).toMatchObject({ allowed: false });
		expect(checkNavigation(policy, "not a url")).toMatchObject({ allowed: false });
	});

	test("production hosts are refused even when the allowlist names them", () => {
		const hostile = {
			allow: [
				"https://zaraprptkegxqpvnsubu.supabase.co",
				"zaraprptkegxqpvnsubu.supabase.co",
				"akamai-iad-prod.example.com",
				"polysimulator.com",
				"https://www.polysimulator.com",
			],
		};
		for (const url of [
			"https://zaraprptkegxqpvnsubu.supabase.co/rest",
			"https://akamai-iad-prod.example.com/",
			"https://polysimulator.com/",
			"https://www.polysimulator.com/",
		]) {
			const decision = checkNavigation(hostile, url);
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

	test("a trailing dot, upper case, a port or IDNA cannot dodge the production list or change an allow match", () => {
		const allowAll = { allow: ["*.polysimulator.com", "polysimulator.com", "https://staging.example.com"] };
		for (const url of [
			"https://polysimulator.com./",
			"https://POLYSIMULATOR.COM../",
			"https://www.polysimulator.com.:8443/x",
			"https://zaraprptkegxqpvnsubu.supabase.co./rest",
			"https://x.akamai-iad-prod.example.",
		]) {
			const decision = checkNavigation(allowAll, url);
			expect(decision.allowed).toBe(false);
			expect(decision.allowed ? "" : decision.reason).toContain("production host");
		}
		expect(checkNavigation(allowAll, "https://staging.example.com./")).toEqual({ allowed: true });
		expect(checkNavigation({ allow: ["https://staging.example.com"] }, "https://STAGING.example.com:443/")).toEqual({
			allowed: true,
		});
		expect(isProductionUrl("https://app.polysimulator.com./")).toBe(true);
		expect(isProductionUrl("https://example.com/")).toBe(false);
	});
});

describe("allowlist loading", () => {
	test("merges the policy file and the environment", () => {
		fs.mkdirSync(path.dirname(policyFilePath()), { recursive: true });
		fs.writeFileSync(policyFilePath(), JSON.stringify({ allow: ["a.example.com"] }));
		const policy = loadExtensionPolicy({ [EXTENSION_ALLOW_ENV]: " b.example.com , ,https://c.example.com" });
		expect(policy.allow).toEqual(["a.example.com", "b.example.com", "https://c.example.com"]);
	});

	test("a malformed file is an error, not an empty allowlist", () => {
		fs.mkdirSync(path.dirname(policyFilePath()), { recursive: true });
		fs.writeFileSync(policyFilePath(), JSON.stringify({ allow: "nope" }));
		expect(() => loadExtensionPolicy({})).toThrow("not valid");
	});

	test("no file and no variable means default deny", () => {
		expect(loadExtensionPolicy({}).allow).toEqual([]);
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
