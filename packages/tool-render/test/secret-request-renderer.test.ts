import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { genericRenderer } from "../src/generic";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

const renderer = resolveToolRenderer("secret_request");

function render(component: "Summary" | "Body", props: Partial<ToolRenderProps>): string {
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`secret_request renderer has no ${component}`);
	return renderToStaticMarkup(
		createElement(Component, { name: "secret_request", args: {}, ...props } as ToolRenderProps),
	);
}

function makeMetadataResult(overrides: Record<string, unknown> = {}, secretRef?: string): ToolResultLike {
	const request = {
		version: 1,
		requestId: "req-123",
		ownerSessionId: "sess-1",
		projectId: "proj-1",
		purpose: "publish package",
		label: "NPM deploy token",
		provider: "npm",
		vaultCollection: "Shared",
		deliveryPolicy: "private-operation",
		expiresAt: "2026-11-24T12:00:00.000Z",
		nonce: "SENSITIVE-NONCE-SHOULD-NOT-APPEAR",
		serverPublicKeyJwk: { kty: "EC", crv: "P-256", x: "SENSITIVE-JWK-X", y: "SENSITIVE-JWK-Y" },
		status: "pending",
		...overrides,
	};
	const payload = { request, ...(secretRef ? { secretRef } : {}) };
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details: payload,
	};
}

describe("secret_request renderer", () => {
	it("resolves a dedicated renderer rather than the generic fallback", () => {
		expect(renderer).not.toBe(genericRenderer);
		expect(renderer.Summary).toBeDefined();
		expect(renderer.Body).toBeDefined();
	});

	it("renders create summary and body with safe metadata", () => {
		const args = {
			action: "create",
			purpose: "publish package",
			label: "NPM deploy token",
			provider: "npm",
			approvedTool: "bash",
		};
		const result = makeMetadataResult({ status: "pending" });

		const summary = render("Summary", { args, result });
		expect(summary).toContain("create");
		expect(summary).toContain("pending");
		expect(summary).toContain("NPM deploy token");
		expect(summary).toContain("npm");
		expect(summary).toContain("bash");

		const body = render("Body", { args, result });
		expect(body).toContain("NPM deploy token");
		expect(body).toContain("npm");
		expect(body).toContain("publish package");
		expect(body).toContain("bash");
		expect(body).toContain("req-123");
		expect(body).toContain("private-operation");
		expect(body).toContain("Shared");
		expect(body).toContain("2026-11-24T12:00:00.000Z");
	});

	it("never dumps raw payloads, handshake keys, or unexpected secret fields", () => {
		const args = {
			action: "create",
			purpose: "publish",
			label: "Deploy key",
			provider: "github",
			approvedTool: "bash",
			value: "SUPER-SECRET-VALUE",
			password: "ANOTHER-SECRET-PASSWORD",
		};
		const result = makeMetadataResult({ status: "saved" }, "ref-opaque-456");

		const summary = render("Summary", { args, result });
		const body = render("Body", { args, result });
		for (const html of [summary, body]) {
			expect(html).not.toContain("SUPER-SECRET-VALUE");
			expect(html).not.toContain("ANOTHER-SECRET-PASSWORD");
			expect(html).not.toContain("SENSITIVE-NONCE-SHOULD-NOT-APPEAR");
			expect(html).not.toContain("SENSITIVE-JWK-X");
			expect(html).not.toContain("serverPublicKeyJwk");
			expect(html).not.toContain("ownerSessionId");
			expect(html).not.toContain("ref-opaque-456");
		}
	});

	it("renders consume and get/cancel actions without label or provider", () => {
		const consumeSummary = render("Summary", {
			args: { action: "consume", secretRef: "ref-999", tool: "bash", purpose: "deploy" },
			result: makeMetadataResult({ status: "consumed", label: undefined, provider: undefined }, "ref-999"),
		});
		expect(consumeSummary).toContain("consume");
		expect(consumeSummary).toContain("consumed");
		expect(consumeSummary).toContain("bash");
		expect(consumeSummary).toContain("deploy");

		const cancelSummary = render("Summary", {
			args: { action: "cancel", requestId: "req-777" },
		});
		expect(cancelSummary).toContain("cancel");
		expect(cancelSummary).toContain("req-777");
	});

	it("renders a refusal without showing the raw error payload", () => {
		const result: ToolResultLike = {
			content: [{ type: "text", text: "unexpected private error payload" }],
			isError: true,
		};
		const summary = render("Summary", { args: { action: "get", requestId: "req-123" }, result });
		expect(summary).toContain("refused");

		const body = render("Body", { args: { action: "get", requestId: "req-123" }, result });
		expect(body).toContain("Secret request refused");
		expect(body).not.toContain("unexpected private error payload");
	});

	it("tolerates malformed or empty args and details", () => {
		const summary = render("Summary", {
			args: { action: 123 as unknown as string },
			result: { content: [], details: "bad" },
		});
		expect(summary).toContain("[invalid action]");

		const body = render("Body", {
			args: {},
			result: { content: [{ type: "text", text: '{"secret":"should-not-dump"}' }], details: null },
		});
		expect(body).not.toContain("should-not-dump");
	});
});
