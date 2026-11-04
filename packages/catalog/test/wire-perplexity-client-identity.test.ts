/**
 * ONE-PLACE lock for the client identity veyyon presents to Perplexity's consumer endpoints.
 *
 * Why this suite exists: two packages take part in ONE Perplexity session and each had its own copy of the app
 * identity it claims. `@veyyon/ai`'s `registry/oauth/perplexity.ts` mints the session JWT through the email-OTP
 * flow with `API_VERSION = "2.18"` and `APP_USER_AGENT = "Perplexity/641 ..."`;
 * `@veyyon/coding-agent`'s `tools/web/search/providers/perplexity.ts` spends that session with the same two values
 * under `OAUTH_API_VERSION` and `OAUTH_USER_AGENT`. The version was spelled a third time inside one request,
 * once as the `X-App-ApiVersion` header and once as the ask body's `version` field.
 *
 * A drift is not an error. A session minted while claiming one app version and spent while claiming another is
 * what the Cloudflare managed challenge exists to catch, and the ask endpoint's answer is 200 with the anonymous
 * free `turbo` model regardless of `model_preference`. A user with a Pro account gets free-tier answers and
 * nothing says why. That silent downgrade is documented in the provider itself for the neighbouring case of a
 * bearer sent where a cookie belongs, so it is a known behaviour of this endpoint rather than a guess.
 *
 * The browser half is locked here too. `browser-headers.ts` stated its Chrome version twice, in the `Sec-Ch-Ua`
 * client hint and in the User-Agent, and `perplexity.ts` retyped the User-Agent for its anonymous path, making a
 * third statement. A fingerprint whose version claims disagree with each other is precisely what a bot check
 * looks for.
 *
 * What each consumer SENDS is asserted where the request is made, through a recording `fetch`:
 * `packages/ai/test/a-perplexity-login-claims-the-app-identity-on-every-request.test.ts` for the login,
 * `packages/coding-agent/test/tools/web/search/perplexity.test.ts` for the signed-in and anonymous asks, and
 * `plugins/web/test/scrapers/load-page-attempt-loop.test.ts` for the scraper's Windows rung. This file holds
 * the values and the single-owner census.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { stringConstantsIn } from "@veyyon/utils/source-declarations";
import {
	PERPLEXITY_HEADERS,
	PERPLEXITY_NATIVE_APP_API_VERSION,
	PERPLEXITY_NATIVE_APP_BUNDLE_ID,
	PERPLEXITY_NATIVE_APP_HEADERS,
	PERPLEXITY_NATIVE_APP_USER_AGENT,
	PERPLEXITY_WEB_ORIGIN,
} from "../src/wire/perplexity";

const AI_SRC = path.resolve(import.meta.dir, "../../ai/src");
const CODING_AGENT_SRC = path.resolve(import.meta.dir, "../../coding-agent/src");
const LOGIN = path.join(AI_SRC, "registry/oauth/perplexity.ts");
const SEARCH = path.join(CODING_AGENT_SRC, "tools/web/search/providers/perplexity.ts");
const WEB_SRC = path.resolve(import.meta.dir, "../../../plugins/web/src");
const BROWSER_HEADERS = path.join(WEB_SRC, "browser-fingerprint-constants.ts");

describe("the spoofed Perplexity app identity", () => {
	/**
	 * The User-Agent, verbatim. `Perplexity/641` is the observed app build and the CFNetwork and Darwin tokens are
	 * what a Catalyst app on macOS sends. Pinned as bytes because it is not assembled from the host's real OS
	 * version: a Darwin token that does not match the CFNetwork build is a combination no real client produces.
	 */
	it("reports the macOS app's User-Agent verbatim", () => {
		expect(PERPLEXITY_NATIVE_APP_USER_AGENT).toBe("Perplexity/641 CFNetwork/1568 Darwin/25.2.0");
	});

	/** The API version the same release reports. */
	it("reports the app's API version", () => {
		expect(PERPLEXITY_NATIVE_APP_API_VERSION).toBe("2.18");
	});

	/**
	 * The two travel together. The User-Agent alone gets past the challenge but leaves the request looking like an
	 * app of unknown version, and the version alone contradicts whatever User-Agent is sent instead, so the header
	 * pair is what a caller reaches for rather than either constant on its own.
	 */
	it("pairs the User-Agent with the version in one header set", () => {
		expect(PERPLEXITY_NATIVE_APP_HEADERS).toEqual({
			"User-Agent": "Perplexity/641 CFNetwork/1568 Darwin/25.2.0",
			"X-App-ApiVersion": "2.18",
		});
	});

	/** The header set is keyed by the owner's own header-name constant, not by a retyped string. */
	it("keys the version header by the shared name", () => {
		expect(PERPLEXITY_NATIVE_APP_HEADERS[PERPLEXITY_HEADERS.API_VERSION]).toBe(PERPLEXITY_NATIVE_APP_API_VERSION);
	});

	/** The bundle id, used to read the app's stored token out of NSUserDefaults. */
	it("names the macOS bundle", () => {
		expect(PERPLEXITY_NATIVE_APP_BUNDLE_ID).toBe("ai.perplexity.mac");
	});

	/**
	 * The four header names, pinned because a typo in one is silent: the endpoint ignores an unknown header and
	 * behaves as though the value were never sent.
	 */
	it("names the consumer request headers", () => {
		expect(PERPLEXITY_HEADERS).toEqual({
			API_VERSION: "X-App-ApiVersion",
			API_CLIENT: "X-App-ApiClient",
			REQUEST_ID: "X-Request-ID",
			REQUEST_REASON: "X-Perplexity-Request-Reason",
		});
	});

	/** The web origin both halves talk to, with no trailing slash so a path can be appended directly. */
	it("holds the consumer origin without a trailing slash", () => {
		expect(PERPLEXITY_WEB_ORIGIN).toBe("https://www.perplexity.ai");
		expect(PERPLEXITY_WEB_ORIGIN.endsWith("/")).toBeFalse();
		expect(new URL(PERPLEXITY_WEB_ORIGIN).origin).toBe(PERPLEXITY_WEB_ORIGIN);
	});

	/**
	 * The version appears inside the User-Agent's sibling build number, so a reader can see they describe one
	 * release. Asserted as a reminder that bumping one means bumping the other, since the User-Agent's build is
	 * not derivable from the API version.
	 */
	it("keeps the two identity values independent but paired", () => {
		expect(PERPLEXITY_NATIVE_APP_USER_AGENT).toContain("Perplexity/");
		expect(PERPLEXITY_NATIVE_APP_USER_AGENT).not.toContain(PERPLEXITY_NATIVE_APP_API_VERSION);
	});
});

describe("the Perplexity client identity has one owner", () => {
	/**
	 * The ratchet, keyed on the LITERALS. Both former copies used names of their own, so a name-based rule would
	 * miss a third copy under a fourth spelling.
	 */
	it("spells no identity value outside the owner", async () => {
		const offenders: string[] = [];
		for (const root of [AI_SRC, CODING_AGENT_SRC]) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
				const text = await Bun.file(path.join(root, file)).text();
				for (const value of [
					PERPLEXITY_NATIVE_APP_USER_AGENT,
					PERPLEXITY_NATIVE_APP_BUNDLE_ID,
					PERPLEXITY_WEB_ORIGIN,
				]) {
					// A doc comment may name a host or a bundle; a string literal is the copy that drifts.
					if (text.includes(`"${value}"`)) offenders.push(`${file} spells ${value}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/** Nor declares one of the names the copies used. */
	it("declares none of the retired names", async () => {
		const retired = new Set([
			"API_VERSION",
			"APP_USER_AGENT",
			"OAUTH_API_VERSION",
			"OAUTH_USER_AGENT",
			"NATIVE_APP_BUNDLE",
			"ANONYMOUS_USER_AGENT",
		]);
		const offenders: string[] = [];
		for (const file of [LOGIN, SEARCH]) {
			for (const constant of stringConstantsIn(await Bun.file(file).text())) {
				if (retired.has(constant.name)) offenders.push(`${path.basename(file)}: ${constant.name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/** The non-vacuity twin: the literal scan must actually reach both packages and both former declarers. */
	it("scans both packages", async () => {
		let count = 0;
		for (const root of [AI_SRC, CODING_AGENT_SRC]) {
			count += [...new Bun.Glob("**/*.ts").scanSync(root)].length;
		}
		expect(count).toBeGreaterThan(500);
		for (const file of [LOGIN, SEARCH, BROWSER_HEADERS]) {
			expect(await Bun.file(file).exists(), file).toBeTrue();
		}
	});

	/** The owner is a leaf, so either package pays one module for the identity. */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.resolve(import.meta.dir, "../src/wire/perplexity.ts")).text();
		// The PARSED specifier list, not the characters: the scan this replaced also went red on a doc
		// comment containing `from "..."`, and on a free `import type`, which costs nothing at runtime.
		expect(moduleSpecifiersIn(owner)).toEqual([]);
	});
});

describe("the browser fingerprint states its version once", () => {
	/**
	 * The exported User-Agents and the fallback client hint have to name the same Chrome major version, because a
	 * request whose `Sec-Ch-Ua` and User-Agent disagree is a combination no browser sends. They were independent
	 * literals; the values the module exports are what a request carries, so they are what is compared.
	 */
	it("uses one Chrome version in the User-Agents and the client hint", async () => {
		const { CHROME_DESKTOP_USER_AGENT, CHROME_FALLBACK_HEADERS, CHROME_WINDOWS_USER_AGENT } = await import(
			"@veyyon/web/browser-fingerprint-constants"
		);
		const version = /Chrome\/(\d+)\./.exec(CHROME_DESKTOP_USER_AGENT)?.[1];
		expect(version, "no Chrome version in the User-Agent").toBeDefined();
		expect(/Chrome\/(\d+)\./.exec(CHROME_WINDOWS_USER_AGENT)?.[1]).toBe(version);
		const hint = CHROME_FALLBACK_HEADERS["Sec-Ch-Ua"];
		expect(hint).toContain(`"Google Chrome";v="${version}"`);
		expect(hint).toContain(`"Chromium";v="${version}"`);
		expect(CHROME_FALLBACK_HEADERS["User-Agent"]).toBe(CHROME_DESKTOP_USER_AGENT);
	});

	/** The two User-Agents describe one browser on two platforms. */
	it("names the platform each User-Agent claims", async () => {
		const { CHROME_DESKTOP_USER_AGENT, CHROME_WINDOWS_USER_AGENT } = await import(
			"@veyyon/web/browser-fingerprint-constants"
		);
		expect(CHROME_WINDOWS_USER_AGENT).toContain("Windows NT 10.0");
		expect(CHROME_DESKTOP_USER_AGENT).toContain("Macintosh");
	});

	/** No module outside the owner spells a Chrome User-Agent literal. */
	it("spells no Chrome User-Agent outside the fingerprint owner", async () => {
		const offenders: string[] = [];
		for (const root of [AI_SRC, CODING_AGENT_SRC, WEB_SRC]) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
				const full = path.join(root, file);
				if (full === BROWSER_HEADERS) continue;
				const text = await Bun.file(full).text();
				if (/"Mozilla\/5\.0 \([^"]*Chrome\//.test(text)) offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});
