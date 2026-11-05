import { describe, expect, it } from "bun:test";
import { USAGE_WARNING_FRACTION, usageAmountFromUsedPercent, usageStatusFromUsedFraction } from "../src/usage/shared";

describe("usageStatusFromUsedFraction (the single usage-status owner)", () => {
	it("returns unknown when no fraction is reported", () => {
		expect(usageStatusFromUsedFraction(undefined)).toBe("unknown");
	});

	it("returns ok below the warning threshold", () => {
		expect(usageStatusFromUsedFraction(0)).toBe("ok");
		expect(usageStatusFromUsedFraction(0.5)).toBe("ok");
		expect(usageStatusFromUsedFraction(0.8999)).toBe("ok");
	});

	it("flips to warning exactly at the warning threshold", () => {
		expect(USAGE_WARNING_FRACTION).toBe(0.9);
		expect(usageStatusFromUsedFraction(0.9)).toBe("warning");
		expect(usageStatusFromUsedFraction(0.95)).toBe("warning");
		expect(usageStatusFromUsedFraction(0.9999)).toBe("warning");
	});

	it("flips to exhausted exactly at full consumption", () => {
		expect(usageStatusFromUsedFraction(1)).toBe("exhausted");
		expect(usageStatusFromUsedFraction(1.5)).toBe("exhausted");
	});

	it("treats a negative fraction as ok (below warning), never crashing", () => {
		expect(usageStatusFromUsedFraction(-0.1)).toBe("ok");
	});
});

describe("usageAmountFromUsedPercent (the single percent-used amount owner)", () => {
	it("derives the remaining percent and both fractions from the percent used", () => {
		expect(usageAmountFromUsedPercent(25)).toEqual({
			used: 25,
			limit: 100,
			remaining: 75,
			usedFraction: 0.25,
			remainingFraction: 0.75,
			unit: "percent",
		});
	});

	it("clamps a reported percent past either end to 0..100", () => {
		expect(usageAmountFromUsedPercent(130)).toMatchObject({
			used: 100,
			remaining: 0,
			usedFraction: 1,
			remainingFraction: 0,
		});
		expect(usageAmountFromUsedPercent(-5)).toMatchObject({
			used: 0,
			remaining: 100,
			usedFraction: 0,
			remainingFraction: 1,
		});
	});
});
