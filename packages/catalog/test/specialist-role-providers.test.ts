import { describe, expect, test } from "bun:test";
import { CATALOG_PROVIDERS } from "../src/provider-models/descriptors";
import {
	LOCAL_STATIC_MODELS,
	localModelManagerOptions,
	WEB_STATIC_MODELS,
	webModelManagerOptions,
} from "../src/provider-models/special";

describe("Specialist synthetic role providers", () => {
	test("local provider configures audio and tiny language models", () => {
		const options = localModelManagerOptions();
		expect(options.providerId).toBe("local");
		expect(options.staticModels).toBe(LOCAL_STATIC_MODELS);
		expect(LOCAL_STATIC_MODELS).toHaveLength(13);

		const kinds = new Set(LOCAL_STATIC_MODELS.map((model) => model.kind));
		expect([...kinds].sort()).toEqual(["stt", "tiny", "tts"]);

		const kokoro = LOCAL_STATIC_MODELS.find((model) => model.id === "kokoro");
		expect(kokoro).toMatchObject({
			kind: "tts",
			api: "local-inference",
			provider: "local",
		});

		const whisper = LOCAL_STATIC_MODELS.find(
			(model) => model.id === "whisper-base",
		);
		expect(whisper).toMatchObject({
			kind: "stt",
			api: "local-inference",
			provider: "local",
		});

		const tiny = LOCAL_STATIC_MODELS.find(
			(model) => model.id === "lfm2.5-230m",
		);
		expect(tiny).toMatchObject({
			kind: "tiny",
			api: "local-inference",
			provider: "local",
		});
	});

	test("web provider configures search specialist models", () => {
		const options = webModelManagerOptions();
		expect(options.providerId).toBe("web");
		expect(options.staticModels).toBe(WEB_STATIC_MODELS);
		expect(WEB_STATIC_MODELS).toHaveLength(20);

		for (const model of WEB_STATIC_MODELS) {
			expect(model.kind).toBe("search");
			expect(model.api).toBe("web-search");
			expect(model.provider).toBe("web");
		}

		expect(WEB_STATIC_MODELS.map((m) => m.id)).toContain("public");
		expect(WEB_STATIC_MODELS.map((m) => m.id)).toContain("duckduckgo");
		expect(WEB_STATIC_MODELS.map((m) => m.id)).toContain("parallel");
	});

	test("descriptors wire local and web providers into catalog registry", () => {
		const localDesc = CATALOG_PROVIDERS.find((p) => p.id === "local");
		expect(localDesc).toBeDefined();
		expect(localDesc?.defaultModel).toBe("lfm2.5-230m");
		expect(localDesc?.createModelManagerOptions?.({} as never).providerId).toBe(
			"local",
		);

		const webDesc = CATALOG_PROVIDERS.find((p) => p.id === "web");
		expect(webDesc).toBeDefined();
		expect(webDesc?.defaultModel).toBe("public");
		expect(webDesc?.createModelManagerOptions?.({} as never).providerId).toBe(
			"web",
		);
	});
});
