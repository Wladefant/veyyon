import { describe, expect, it } from "bun:test";
import {
	extractProviderRetryHint,
	formatErrorMessageWithRetryAfter,
	getHeadersFromError,
	getRetryAfterMsFromHeaders,
} from "@veyyon/ai/utils/retry-after";

describe("retry-after parsing", () => {
	/**
	 * RFC Retry-After permits zero, and providers use it to authorize an immediate
	 * retry; treating zero as missing changes a guided 429 into a terminal error.
	 */
	it("preserves explicit zero-delay retry guidance", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "0" })).toBe(0);
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "0" })).toBe(0);
	});

	/**
	 * Error formatting runs while another operation is already failing, so unusual
	 * thrown values must not replace the provider failure with a formatter TypeError.
	 */
	it("formats primitive and undefined thrown values without throwing", () => {
		expect(formatErrorMessageWithRetryAfter(undefined, { "retry-after": "1" })).toBe("undefined retry-after-ms=1000");
		expect(formatErrorMessageWithRetryAfter(1n, { "retry-after-ms": "25" })).toBe("1 retry-after-ms=25");
	});

	/**
	 * JavaScript Error causes can be cyclic; header discovery must terminate rather
	 * than overflow the stack and mask the original request error.
	 */
	it("terminates on cyclic error causes while retaining nested headers", () => {
		const first = new Error("first", { cause: undefined });
		const second = Object.assign(new Error("second", { cause: first }), {
			headers: { "retry-after-ms": "12" },
		});
		Object.defineProperty(first, "cause", { value: second, configurable: true });

		expect(getHeadersFromError(first)).toEqual({ "retry-after-ms": "12" });
		Object.defineProperty(second, "headers", { value: undefined, configurable: true });
		expect(getHeadersFromError(first)).toBeUndefined();
	});

	it("extracts provider retry hint with catalog timezone offset", () => {
		const targetMs = Date.parse("2099-09-01T09:44:51+08:00");
		const expected = targetMs - Date.now();
		const hint = extractProviderRetryHint("zai", "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。");
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("reads naive reset stamp as UTC when provider has no timezone policy", () => {
		const targetMs = Date.parse("2099-09-01T09:44:51Z");
		const expected = targetMs - Date.now();
		const hint = extractProviderRetryHint("unknown-provider", "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。");
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("handles undefined provider gracefully", () => {
		const targetMs = Date.parse("2099-09-01T09:44:51Z");
		const expected = targetMs - Date.now();
		const hint = extractProviderRetryHint(undefined, "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。");
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});
});
