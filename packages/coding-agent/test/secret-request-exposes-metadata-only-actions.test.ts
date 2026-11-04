import { describe, expect, test } from "bun:test";
import { type } from "@veyyon/ai/utils/schema/arktype";
import { SecretRequestTool } from "../src/tools/agent/secret-request";
import { installSessionSecretIntakeFactory } from "../src/secrets/intake-session";
import type { ToolSession } from "../src/tools";

describe("secret_request metadata contract", () => {
	test("schema accepts only the four exact metadata action shapes", () => {
		const tool = new SecretRequestTool({} as ToolSession);
		const schema = tool.parameters;
		for (const input of [
			{ action: "create", purpose: "publish", label: "Deploy key", provider: "example", approvedTool: "bash" },
			{ action: "get", requestId: "opaque-request" },
			{ action: "cancel", requestId: "opaque-request" },
			{ action: "consume", secretRef: "opaque-reference", tool: "bash", purpose: "publish" },
		]) {
			expect(schema(input) instanceof type.errors).toBe(false);
		}
		expect(schema({
			action: "create",
			purpose: "publish",
			label: "Deploy key",
			provider: "example",
			approvedTool: "bash",
			value: "must never be accepted",
		}) instanceof type.errors).toBe(true);
		expect(schema({ action: "consume", secretRef: "opaque-reference", tool: "bash", purpose: "publish", command: "echo secret" }) instanceof type.errors).toBe(true);
	});

	test("configured tool stays present before actor binding and refuses unbound and raw input", async () => {
		const session = {} as ToolSession;
		expect(SecretRequestTool.createIf(session)).toBeNull();
		const removeFactory = installSessionSecretIntakeFactory(session, "owner-session", async () => {
			throw new Error("not bound in this contract test");
		});
		try {
			const tool = SecretRequestTool.createIf(session);
			expect(tool).toBeInstanceOf(SecretRequestTool);
			const unbound = await tool!.execute("call", {
				action: "get",
				requestId: "opaque-request",
			});
			expect(unbound.isError).toBe(true);
			expect(unbound.content).toEqual([{ type: "text", text: "Secret request refused" }]);
			const raw = await tool!.execute("call", {
				action: "create",
				purpose: "publish",
				label: "Deploy key",
				provider: "example",
				approvedTool: "bash",
				password: "must never enter the broker",
			} as never);
			expect(raw.isError).toBe(true);
			expect(raw.content).toEqual([{ type: "text", text: "Secret request refused" }]);
		} finally {
			removeFactory();
		}
	});
});
