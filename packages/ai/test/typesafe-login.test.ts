import { afterEach, describe, expect, test, vi } from "bun:test";
import { loginTypeSafe } from "@veyyon/ai/registry/typesafe";
import type { FetchImpl } from "@veyyon/ai/types";

const ORIGINAL_BASE_URL = Bun.env.TYPESAFE_BASE_URL;

afterEach(() => {
	if (ORIGINAL_BASE_URL === undefined) {
		delete Bun.env.TYPESAFE_BASE_URL;
	} else {
		Bun.env.TYPESAFE_BASE_URL = ORIGINAL_BASE_URL;
	}
	vi.restoreAllMocks();
});

function modelsFetch(seen: string[]): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		seen.push(typeof input === "string" ? input : input.toString());
		return new Response(JSON.stringify({ models: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
}

describe("typesafe login", () => {
	test("sends the operator to the console and validates against the default models endpoint", async () => {
		delete Bun.env.TYPESAFE_BASE_URL;
		const seen: string[] = [];
		let authUrl: string | undefined;

		const apiKey = await loginTypeSafe({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => "  ts-test-key  ",
			fetch: modelsFetch(seen),
		});

		expect(authUrl).toBe("https://console.typesafe.ai/");
		expect(seen).toEqual(["https://api.typesafe.ai/v1/models"]);
		expect(apiKey).toBe("ts-test-key");
	});

	test("validates against TYPESAFE_BASE_URL when it is set", async () => {
		Bun.env.TYPESAFE_BASE_URL = "http://gateway.test:4000/";
		const seen: string[] = [];

		await loginTypeSafe({
			onPrompt: async () => "ts-test-key",
			fetch: modelsFetch(seen),
		});

		expect(seen).toEqual(["http://gateway.test:4000/v1/models"]);
	});
});
