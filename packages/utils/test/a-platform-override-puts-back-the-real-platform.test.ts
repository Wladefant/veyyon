/**
 * WHY: twenty suites replace `process.platform` to reach another operating system's branch, and
 * every later file in the same test process reads whatever they leave behind. A restore that puts
 * back the last value a suite set, or nothing, makes an unrelated suite run the Windows branch on
 * Linux and fail far from the cause.
 *
 * Covered: the restore returns the platform this process started with after one set, after several,
 * and when the code under `withPlatform` throws. Not covered: a suite that writes
 * `process.platform` without this helper.
 */
import { describe, expect, it } from "bun:test";
import { restorePlatform, setPlatform, withPlatform } from "./helpers/platform-override";

const REAL = process.platform;
const OTHER: NodeJS.Platform = REAL === "aix" ? "sunos" : "aix";

describe("a platform override puts back the real platform", () => {
	it("reports the set value until the restore", () => {
		setPlatform(OTHER);
		try {
			expect(process.platform).toBe(OTHER);
		} finally {
			restorePlatform();
		}
		expect(process.platform).toBe(REAL);
	});

	it("restores the real platform after several sets, not the first one set", () => {
		setPlatform(OTHER);
		setPlatform("win32");
		restorePlatform();
		expect(process.platform).toBe(REAL);
	});

	it("restores the real platform when the code under withPlatform throws", () => {
		let seen: string | undefined;
		expect(() =>
			withPlatform(OTHER, () => {
				seen = process.platform;
				throw new Error("the code under test failed");
			}),
		).toThrow("the code under test failed");
		expect(seen).toBe(OTHER);
		expect(process.platform).toBe(REAL);
	});
});
