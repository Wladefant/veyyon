import { describe, expect, it } from "bun:test";
import { version } from "../package.json" with { type: "json" };
import { APP_DISPLAY_NAME } from "../src/app-identity";
import { USER_AGENT, VERSION } from "../src/dirs";

describe("USER_AGENT", () => {
	it("formats as <APP_DISPLAY_NAME>/<VERSION>", () => {
		expect(USER_AGENT).toBe(`${APP_DISPLAY_NAME}/${VERSION}`);
		expect(USER_AGENT).toBe(`Veyyon/${version}`);
	});

	it("carries no upstream brand names", () => {
		expect(USER_AGENT.toLowerCase()).not.toContain("omp");
		expect(USER_AGENT.toLowerCase()).not.toContain("oh-my-pi");
		expect(USER_AGENT.toLowerCase()).not.toContain("codingagent");
	});
});
