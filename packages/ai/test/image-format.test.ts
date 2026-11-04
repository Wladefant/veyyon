import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import type { FetchImpl, Model } from "@veyyon/catalog/types";
import * as AIError from "../src/error";
import {
	decodeImageResponse,
	extractImageErrorMessage,
	imageBaseUrl,
	resolveOpenAIImageSize,
	toDataUrl,
	usageFromWire,
} from "../src/images/format";

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

describe("image response formatting and helper utilities", () => {
	it("extracts usage metrics and computes token totals from wire payloads", () => {
		const usage = usageFromWire({
			prompt_tokens: 15,
			completion_tokens: 25,
			cost: 0.05,
		});
		expect(usage.input).toBe(15);
		expect(usage.output).toBe(25);
		expect(usage.totalTokens).toBe(40);
		expect(usage.cost.total).toBe(0.05);
	});

	it("formats data URLs and normalizes image base URLs", () => {
		expect(toDataUrl({ data: "QUJD", mimeType: "image/png" })).toBe("data:image/png;base64,QUJD");
		expect(imageBaseUrl(testImageModel("https://api.example.com/v1/"))).toBe("https://api.example.com/v1");
		expect(() => imageBaseUrl(testImageModel(""))).toThrow(AIError.ValidationError);
	});

	it("resolves OpenAI image dimensions from aspect ratio and explicit imageSize", () => {
		expect(resolveOpenAIImageSize(undefined, "512x512")).toBe("512x512");
		expect(resolveOpenAIImageSize("1:1")).toBe("1024x1024");
		expect(resolveOpenAIImageSize("16:9")).toBe("1536x1024");
		expect(resolveOpenAIImageSize("9:16")).toBe("1024x1536");
		expect(resolveOpenAIImageSize("unknown")).toBeUndefined();
	});

	it("extracts error messages from JSON payload or returns raw text", () => {
		expect(extractImageErrorMessage('{"detail":"quota exceeded"}')).toBe("quota exceeded");
		expect(extractImageErrorMessage('{"error":{"message":"bad request"}}')).toBe("bad request");
		expect(extractImageErrorMessage("gateway timeout")).toBe("gateway timeout");
	});

	it("decodes base64 images and downloads URL images into inline base64 bytes", async () => {
		const inlineB64 = Buffer.from("inline-png").toString("base64");
		const downloadedBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const fetchStub: FetchImpl = async input => {
			if (input.toString() === "https://cdn.example/sample.png") {
				return new Response(downloadedBytes, {
					headers: { "content-type": "image/png" },
				});
			}
			throw new Error("unexpected url");
		};

		const decoded = await decodeImageResponse(
			{
				data: [{ b64_json: inlineB64, media_type: "image/png" }, { url: "https://cdn.example/sample.png" }],
				usage: { input_tokens: 5, output_tokens: 10, cost: 0.02 },
			},
			fetchStub,
		);

		expect(decoded.images).toHaveLength(2);
		expect(decoded.images[0]?.data).toBe(inlineB64);
		expect(decoded.images[0]?.mimeType).toBe("image/png");
		expect(decoded.images[1]?.data).toBe(Buffer.from(downloadedBytes).toString("base64"));
		expect(decoded.usage.totalTokens).toBe(15);
	});

	it("negative control: throws ProviderResponseError on missing data array", async () => {
		const fetchStub: FetchImpl = async () => new Response("ok");
		await expect(decodeImageResponse({}, fetchStub)).rejects.toThrow(AIError.ProviderResponseError);
		await expect(decodeImageResponse(null, fetchStub)).rejects.toThrow(AIError.ProviderResponseError);
	});
});
