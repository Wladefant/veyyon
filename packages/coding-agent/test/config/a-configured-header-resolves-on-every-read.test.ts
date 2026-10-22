/**
 * A header configured as a reference (`${NAME}`, `!command`) is resolved when it is read, not when
 * the model is built, so a rotated value reaches the next request. `config/live-config-headers.ts`
 * builds that object; `resolveConfigHeaders` is the one-shot form for paths that copy headers out.
 *
 * The class: a header object that snapshots its values at construction (the rotation never
 * arrives), that loses a later layer's precedence, that drops the bearer header built from the
 * provider key, or that enumerates differently from what it returns on read, which is how a
 * request builder copying `{ ...headers }` would see stale or missing values.
 *
 * What it does not catch: how the registry layers provider and model headers, which
 * `model-registry-runtime-provider.test.ts` drives through `registerProvider`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createLiveConfigHeaders, resolveConfigHeaders } from "@veyyon/coding-agent/config/live-config-headers";

const VARIABLE = "VEYYON_LIVE_HEADER_TEST_VALUE";
const KEY_VARIABLE = "VEYYON_LIVE_HEADER_TEST_KEY";

describe("a configured header", () => {
	afterEach(() => {
		delete process.env[VARIABLE];
		delete process.env[KEY_VARIABLE];
	});

	it("reads the current value of the variable it references", () => {
		process.env[VARIABLE] = "first";
		const headers = createLiveConfigHeaders([{ "X-Token": `\${${VARIABLE}}` }])!;
		expect(headers["X-Token"]).toBe("first");

		process.env[VARIABLE] = "rotated";

		expect(headers["X-Token"]).toBe("rotated");
		expect({ ...headers }).toEqual({ "X-Token": "rotated" });
	});

	it("takes a later layer over an earlier one, and a written value over both", () => {
		const headers = createLiveConfigHeaders([{ "X-Tier": "provider", "X-Only": "kept" }, { "X-Tier": "model" }])!;
		expect({ ...headers }).toEqual({ "X-Tier": "model", "X-Only": "kept" });

		headers["X-Tier"] = "request";

		expect(headers["X-Tier"]).toBe("request");
		expect("X-Only" in headers).toBe(true);
		expect(Object.keys(headers).sort()).toEqual(["X-Only", "X-Tier"]);
	});

	it("drops a written value when it is deleted, so the configured layer shows through", () => {
		const headers = createLiveConfigHeaders([{ "X-Tier": "provider" }])!;
		headers["X-Tier"] = "request";

		delete headers["X-Tier"];

		expect(headers["X-Tier"]).toBe("provider");
	});

	it("adds a bearer header from the provider key once the key resolves", () => {
		const headers = createLiveConfigHeaders([], { authHeader: true, apiKeyConfig: `\${${KEY_VARIABLE}}` })!;
		expect("Authorization" in headers).toBe(false);

		process.env[KEY_VARIABLE] = "sk-test";

		expect(headers.Authorization).toBe("Bearer sk-test");
	});

	it("adds no bearer header when the auth header is off", () => {
		process.env[KEY_VARIABLE] = "sk-test";
		const headers = createLiveConfigHeaders([{ "X-A": "a" }], {
			authHeader: false,
			apiKeyConfig: `\${${KEY_VARIABLE}}`,
		})!;

		expect({ ...headers }).toEqual({ "X-A": "a" });
	});

	it("is absent when there is no layer and no key to send", () => {
		expect(createLiveConfigHeaders([undefined, undefined])).toBeUndefined();
		expect(createLiveConfigHeaders([], { authHeader: true })).toBeUndefined();
	});

	it("omits a header whose reference resolves to nothing", () => {
		const headers = createLiveConfigHeaders([{ "X-Missing": `\${${VARIABLE}}`, "X-Set": "v" }])!;

		expect({ ...headers }).toEqual({ "X-Set": "v" });
		expect("X-Missing" in headers).toBe(false);
	});
});

describe("headers resolved once", () => {
	afterEach(() => {
		delete process.env[VARIABLE];
	});

	it("hold the value of the read, not of a later one", () => {
		process.env[VARIABLE] = "first";
		const headers = resolveConfigHeaders({ "X-Token": `\${${VARIABLE}}` });

		process.env[VARIABLE] = "rotated";

		expect(headers).toEqual({ "X-Token": "first" });
	});

	it("are absent when nothing resolves", () => {
		expect(resolveConfigHeaders({ "X-Missing": `\${${VARIABLE}}` })).toBeUndefined();
		expect(resolveConfigHeaders(undefined)).toBeUndefined();
	});
});
