import { expect, test } from "bun:test";
import { isScrubbedEnvVar } from "./ci-test-ts";

test("Cloudflare build credentials are removed from every test child environment", () => {
	expect(isScrubbedEnvVar("CLOUDFLARE_API_TOKEN")).toBe(true);
});
