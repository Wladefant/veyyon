import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, Model } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";
import { sseFetch } from "./helpers/fetch-mock";

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

describe("issue #959 - deepseek chat-template token leakage", () => {
	const model: Model<"openai-completions"> = {
		...getBundledModel("deepseek", "deepseek-v4-flash"),
	};

	it("strips leaked deepseek chat-template markers from visible text for deepseek providers", async () => {
		const fetchMock = sseFetch([
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "去改前端交互描述：" } }],
			},
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "<｜Assistant｜>\n\n" } }],
			},
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "让我找到对应位置并修改。" } }],
			},
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block as { text: string }).text)
			.join("");

		expect(text).toBe("去改前端交互描述：让我找到对应位置并修改。");
		expect(text).not.toContain("<｜Assistant｜>");
	});

	it("holds partial deepseek markers across chunks before stripping them", async () => {
		const fetchMock = sseFetch([
			{
				id: "chatcmpl-deepseek-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "去改前端交互描述：<｜Ass" } }],
			},
			{
				id: "chatcmpl-deepseek-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "istant｜>\n\n让我找到对应位置并修改。" } }],
			},
			{
				id: "chatcmpl-deepseek-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block as { text: string }).text)
			.join("");

		expect(text).toBe("去改前端交互描述：让我找到对应位置并修改。");
		expect(text).not.toContain("<｜Assistant｜>");
	});
});
