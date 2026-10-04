import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import type { FetchImpl, Model } from "@veyyon/catalog/types";
import * as AIError from "../src/error";
import { ImageApiError } from "../src/images/format";
import { postJson, postMultipart } from "../src/images/transport";

function testImageModel(baseUrl = "https://image.example/v1"): Model {
	return buildModel({
		id: "test-image-model",
		name: "test/image-model",
		provider: "test-provider",
		api: "openai-images",
		kind: "image",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
	});
}

describe("image HTTP transport and bearer confinement", () => {
	it("posts JSON payloads with Authorization bearer header and confines token from URL", async () => {
		const model = testImageModel();
		let requestUrl = "";
		let authHeader = "";
		let contentType = "";
		let requestBody = "";

		const fetchStub: FetchImpl = async (input, init) => {
			requestUrl = input.toString();
			const headers = new Headers(init?.headers);
			authHeader = headers.get("authorization") ?? "";
			contentType = headers.get("content-type") ?? "";
			requestBody = String(init?.body);
			return new Response(JSON.stringify({ data: [{ b64_json: "AQID" }] }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await postJson({
			model,
			url: "https://image.example/v1/images/generations",
			body: { prompt: "paint a landscape" },
			apiKey: "secret-bearer-key",
			fetch: fetchStub,
		});
		expect(requestUrl).toBe("https://image.example/v1/images/generations");
		expect(requestUrl).not.toContain("secret-bearer-key");
		expect(authHeader).toEqual("Bearer secret-bearer-key");
		expect(contentType).toEqual("application/json");
		expect(requestBody).toBe(JSON.stringify({ prompt: "paint a landscape" }));
		expect(result).toEqual({ data: [{ b64_json: "AQID" }] });
	});

	it("posts multipart form data with Authorization bearer header", async () => {
		const model = testImageModel();
		let authHeader = "";
		let postedForm: FormData | undefined;

		const fetchStub: FetchImpl = async (_input, init) => {
			const headers = new Headers(init?.headers);
			authHeader = headers.get("authorization") ?? "";
			if (init?.body instanceof FormData) postedForm = init.body;
			return new Response(JSON.stringify({ data: [{ b64_json: "BAUG" }] }), {
				headers: { "content-type": "application/json" },
			});
		};

		const form = new FormData();
		form.set("prompt", "edit this image");
		await postMultipart({
			model,
			url: "https://image.example/v1/images/edits",
			body: form,
			apiKey: "multipart-key",
			fetch: fetchStub,
		});
		expect(authHeader).toEqual("Bearer multipart-key");
		expect(postedForm?.get("prompt")).toBe("edit this image");
	});

	it("redacts echoed active API key from error messages and normalizes case-variant headers", async () => {
		const modelWithVariantHeaders = buildModel({
			...testImageModel(),
			headers: {
				"content-type": "application/json",
				AUTHORIZATION: "stale-token",
			},
		});

		let observedHeaders: Record<string, string> = {};
		const fetchEcho: FetchImpl = async (_url, init) => {
			const headers = init?.headers;
			if (
				headers &&
				typeof headers === "object" &&
				!(headers instanceof Headers) &&
				!Array.isArray(headers)
			) {
				observedHeaders = Object.assign({}, headers as Record<string, string>);
			}
			return new Response(
				"Incorrect API key provided: secret-bearer-review-key",
				{ status: 401 },
			);
		};

		let caughtError: unknown;
		try {
			await postJson({
				model: modelWithVariantHeaders,
				url: "https://image.example/v1/fail",
				body: {},
				apiKey: "secret-bearer-review-key",
				fetch: fetchEcho,
			});
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(ImageApiError);
		if (caughtError instanceof Error) {
			expect(caughtError.message).not.toContain("secret-bearer-review-key");
			expect(caughtError.message).toContain("[REDACTED]");
		}
		expect(observedHeaders.Authorization).toBe(
			"Bearer secret-bearer-review-key",
		);
		expect(observedHeaders["Content-Type"]).toBe("application/json");
		expect(observedHeaders["content-type"]).toBeUndefined();
		expect(observedHeaders.AUTHORIZATION).toBeUndefined();
	});

	it("negative control: throws ImageApiError on upstream HTTP failure and ProviderResponseError on bad JSON", async () => {
		const model = testImageModel();
		const fetchError: FetchImpl = async () =>
			new Response(
				JSON.stringify({ error: { message: "rate limit exceeded" } }),
				{ status: 429 },
			);
		await expect(
			postJson({
				model,
				url: "https://image.example/v1/fail",
				body: {},
				apiKey: "k",
				fetch: fetchError,
			}),
		).rejects.toThrow(ImageApiError);

		const fetchMalformed: FetchImpl = async () =>
			new Response("not-valid-json", { status: 200 });
		await expect(
			postJson({
				model,
				url: "https://image.example/v1/bad-json",
				body: {},
				apiKey: "k",
				fetch: fetchMalformed,
			}),
		).rejects.toThrow(AIError.ProviderResponseError);
	});
});
