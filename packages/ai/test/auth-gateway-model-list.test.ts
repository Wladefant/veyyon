import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";

describe("auth-gateway model list", () => {
	it("returns deduplicated models with provider-qualified IDs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-models-list-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const mockAnthropic = createMockModel({ provider: "anthropic", id: "shared-model" });
		const mockDevin1 = createMockModel({ provider: "devin", id: "shared-model" });
		const mockDevin2 = createMockModel({ provider: "devin", id: "shared-model" });

		const models = [mockAnthropic.model, mockDevin1.model, mockDevin2.model];

		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mockAnthropic.model,
			listModels: () => models,
			version: "test",
		});

		try {
			const res = await fetch(`${handle.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { object: string; data: Record<string, unknown>[] };
			expect(body.object).toBe("list");
			expect(body.data).toEqual([
				{
					id: "anthropic/shared-model",
					object: "model",
					owned_by: "anthropic",
					api: mockAnthropic.model.api,
					display_name: "shared-model",
					context_length: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
				},
				{
					id: "devin/shared-model",
					object: "model",
					owned_by: "devin",
					api: mockDevin1.model.api,
					display_name: "shared-model",
					context_length: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
				},
			]);
		} finally {
			await handle.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("advertises catalog metadata and explicit false tool support", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-models-list-meta-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const mockNoTools = Object.assign(
			createMockModel({ provider: "custom", id: "no-tools-model", contextWindow: 128_000, maxTokens: 4096 }).model,
			{ supportsTools: false },
		);

		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mockNoTools,
			listModels: () => [mockNoTools],
			version: "test",
		});

		try {
			const res = await fetch(`${handle.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { object: string; data: Record<string, unknown>[] };
			expect(body.data).toEqual([
				{
					id: "custom/no-tools-model",
					object: "model",
					owned_by: "custom",
					api: mockNoTools.api,
					display_name: "no-tools-model",
					context_length: 128_000,
					max_output_tokens: 4096,
					input_modalities: ["text"],
					supports_tools: false,
				},
			]);
		} finally {
			await handle.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
