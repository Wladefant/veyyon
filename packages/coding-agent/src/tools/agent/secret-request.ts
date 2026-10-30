import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { type } from "@veyyon/ai/utils/schema/arktype";
import { lazy } from "@veyyon/utils";
import type { SecretIntakeCreateInput, SecretIntakeOperation, SecretIntakeResult } from "../../secrets/intake-broker";
import { getSessionSecretIntake, getSessionSecretIntakeContext, hasSessionSecretIntakeFactory } from "../../secrets/intake-session";
import type { ToolSession } from "..";

const secretRequestSchema = lazy(() =>
	type({
		action: "'create'",
		purpose: "string",
		label: "string",
		provider: "string",
		approvedTool: "string",
		"+": "reject",
	})
		.or(type({ action: "'get'", requestId: "string", "+": "reject" }))
		.or(type({ action: "'cancel'", requestId: "string", "+": "reject" }))
		.or(type({ action: "'consume'", secretRef: "string", tool: "string", purpose: "string", "+": "reject" })),
);

type SecretRequestParams = typeof secretRequestSchema.value.infer;

const REFUSAL = "Secret request refused";
const KEYS_BY_ACTION = {
	create: ["action", "purpose", "label", "provider", "approvedTool"],
	get: ["action", "requestId"],
	cancel: ["action", "requestId"],
	consume: ["action", "secretRef", "tool", "purpose"],
} as const;

function exactInput(params: unknown): SecretRequestParams {
	if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error(REFUSAL);
	const input = params as Record<string, unknown>;
	if (typeof input.action !== "string" || !Object.hasOwn(KEYS_BY_ACTION, input.action)) throw new Error(REFUSAL);
	const keys = KEYS_BY_ACTION[input.action as keyof typeof KEYS_BY_ACTION];
	if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new Error(REFUSAL);
	for (const key of keys) if (key !== "action" && typeof input[key] !== "string") throw new Error(REFUSAL);
	return input as SecretRequestParams;
}

function toResult(request: SecretIntakeResult): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ request: request.request, ...(request.secretRef ? { secretRef: request.secretRef } : {}) }) }],
		details: { request: request.request, ...(request.secretRef ? { secretRef: request.secretRef } : {}) },
	};
}

export class SecretRequestTool implements AgentTool<typeof secretRequestSchema.value> {
	readonly name = "secret_request";
	readonly label = "Secret request";
	readonly description = "Request, inspect, cancel, or privately consume an operator-approved credential. Never provide a secret value.";
	readonly strict = true;
	readonly approval = "write" as const;

	get parameters(): typeof secretRequestSchema.value { return secretRequestSchema.value; }

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SecretRequestTool | null {
		return hasSessionSecretIntakeFactory(session) ? new SecretRequestTool(session) : null;
	}

	async execute(_id: string, params: SecretRequestParams): Promise<AgentToolResult> {
		try {
			const input = exactInput(params);
			const broker = getSessionSecretIntake(this.session);
			const context = getSessionSecretIntakeContext(this.session);
			if (!broker || !context) throw new Error(REFUSAL);
			let response: SecretIntakeResult;
			switch (input.action) {
				case "create": {
					const createInput: SecretIntakeCreateInput = {
						purpose: input.purpose,
						label: input.label,
						provider: input.provider,
						approvedTool: input.approvedTool,
					};
					response = await broker.create(context, createInput);
					break;
				}
				case "get": response = broker.get(context, input.requestId); break;
				case "cancel": response = broker.cancel(context, input.requestId); break;
				case "consume": {
					const operation: SecretIntakeOperation = { tool: input.tool, purpose: input.purpose };
					response = await broker.consume(context, input.secretRef, operation);
					break;
				}
			}
			return toResult(response);
		} catch {
			return { content: [{ type: "text", text: REFUSAL }], isError: true };
		}
	}
}
