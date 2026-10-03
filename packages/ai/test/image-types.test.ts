import { describe, expect, it } from "bun:test";
import type {
	GeneratedImage,
	ImageGenerationRequest,
	ImageGenerationResult,
} from "../src/images/types";

describe("image contracts and data types", () => {
	it("constructs valid image generation requests and results with hosted metadata", () => {
		const request: ImageGenerationRequest = {
			prompt: "an architectural render",
			aspectRatio: "16:9",
			imageSize: "1536x1024",
			count: 1,
		};
		expect(request.prompt).toBe("an architectural render");
		expect(request.aspectRatio).toBe("16:9");

		const image: GeneratedImage = {
			data: "AQIDBA==",
			mimeType: "image/png",
			size: "1536x1024",
			quality: "hd",
		};
		const result: ImageGenerationResult = {
			images: [image],
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 },
			},
			model: "dall-e-3",
		};

		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.size).toBe("1536x1024");
		expect(result.images[0]?.quality).toBe("hd");
		expect(result.model).toBe("dall-e-3");
	});

	it("negative control: asserts required image attributes are preserved", () => {
		const image: GeneratedImage = {
			data: "QUJD",
			mimeType: "image/webp",
		};
		expect(image.data.length).toBeGreaterThan(0);
		expect(image.mimeType).toBe("image/webp");
		expect(image.size).toBeUndefined();
	});
});
