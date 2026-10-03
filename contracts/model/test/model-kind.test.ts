/**
 * Model kind and runner API contracts for specialist catalogs.
 *
 * WHY THIS SUITE EXISTS. The model kind vocabulary (`MODEL_KINDS`) and runner
 * protocol union (`RUNNER_APIS`) isolate role-specific runner models from
 * session chat models. The `modelKind` helper resolves absent kind fields to
 * `"chat"` so existing models maintain chat semantics.
 */
import { describe, expect, it } from "bun:test";
import { MODEL_KINDS, modelKind, RUNNER_APIS } from "../src/index";

describe("specialist model kind vocabulary and contracts", () => {
	it("enumerates canonical model kinds in declaration order", () => {
		expect([...MODEL_KINDS]).toEqual([
			"chat",
			"tiny",
			"image",
			"tts",
			"stt",
			"search",
			"judge",
		]);
	});

	it("enumerates runner protocols outside the chat dispatch union", () => {
		expect([...RUNNER_APIS]).toEqual([
			"local-inference",
			"web-search",
			"typesafe",
			"openai-images",
			"openrouter-images",
			"xai-tts",
			"openai-speech",
		]);
	});

	it("resolves modelKind defaulting to chat when kind is unset", () => {
		expect(modelKind({})).toBe("chat");
		expect(modelKind({ kind: undefined })).toBe("chat");
		expect(modelKind({ kind: "image" })).toBe("image");
		expect(modelKind({ kind: "tts" })).toBe("tts");
		expect(modelKind({ kind: "judge" })).toBe("judge");
	});
});
