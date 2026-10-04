import { describe, expect, it } from "bun:test";
import { abliterationProvider } from "../src/registry/abliteration";
import { gmiCloudProvider } from "../src/registry/gmi-cloud";
import { stepfunProvider } from "../src/registry/stepfun";
import { getVercelAiGatewayHeaders, VERCEL_AI_GATEWAY_REFERER, VERCEL_AI_GATEWAY_TITLE } from "../src/utils/vercel-headers";

describe("api-key provider entries (registry/abliteration, registry/gmi-cloud, registry/stepfun)", () => {
	it.each([
		[abliterationProvider, "abliteration", "Abliteration"],
		[gmiCloudProvider, "gmi-cloud", "GMI Cloud"],
		[stepfunProvider, "stepfun", "StepFun"],
	] as const)("%# registers %s as an api-key provider with a login", (provider, id, name) => {
		expect(provider.id).toBe(id);
		expect(provider.name).toBe(name);
		expect(provider.credential).toBe("api-key");
		expect(typeof provider.login).toBe("function");
	});
});

describe("Vercel AI Gateway attribution headers (utils/vercel-headers)", () => {
	it("sends the referer and title as the lowercase wire header names", () => {
		expect(getVercelAiGatewayHeaders()).toEqual({
			"http-referer": VERCEL_AI_GATEWAY_REFERER,
			"x-title": VERCEL_AI_GATEWAY_TITLE,
		});
		expect(VERCEL_AI_GATEWAY_REFERER.endsWith("/")).toBe(true);
		expect(VERCEL_AI_GATEWAY_TITLE.length).toBeGreaterThan(0);
	});
});
