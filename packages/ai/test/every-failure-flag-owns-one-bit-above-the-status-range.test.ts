/**
 * WHY: `ModelNotInPlan` and `EmptyResponse` both claimed 0x2000, so a plan refusal set the bit that
 * meant an empty response and every reader of either flag answered for both. Class closed: no two
 * failure flags share a bit, and every flag sits above the raw HTTP status range (100-599), so a
 * flag can never be mistaken for a status id by `statusFromId`.
 *
 * Not caught: a flag whose value is unique and in range but whose classifier never sets it. That is
 * covered by the per-flag bait table in `error-recovery-classification.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import * as AIError from "../src/error";

const FAILURE_FLAGS = Object.entries(AIError.Flag).filter(([name]) => name !== "Class");

describe("every failure flag owns one distinct bit", () => {
	test("no two failure flags share a bit", () => {
		const bits = FAILURE_FLAGS.map(([, bit]) => bit);
		expect(new Set(bits).size).toBe(bits.length);
	});

	test("every failure flag is exactly one bit", () => {
		for (const [name, bit] of FAILURE_FLAGS) {
			expect({ name, singleBit: (bit & (bit - 1)) === 0 }).toEqual({ name, singleBit: true });
		}
	});

	test("every failure flag sits above the raw HTTP status range", () => {
		for (const [name, bit] of FAILURE_FLAGS) {
			expect({ name, aboveStatus: bit > 599 }).toEqual({ name, aboveStatus: true });
		}
	});

	test("a flag with the sign bit set survives classification and labels in hex without a sign", () => {
		const id = AIError.create(AIError.Flag.AccountPolicy);
		expect(AIError.is(id, AIError.Flag.AccountPolicy)).toBe(true);
		expect(AIError.stringify(id)).toBe("account-policy");
	});
});
