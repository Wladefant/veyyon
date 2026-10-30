import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { handleRpcCommand, type RpcCommandHost } from "../src/modes/rpc/rpc-commands";
import type { RpcCommand } from "../src/modes/rpc/rpc-types";
import { SecretIntakeBroker, type SecretIntakeContext } from "../src/secrets/intake-broker";
import { sealSecretSubmission } from "../src/secrets/intake-crypto";
import { installSessionSecretIntake } from "../src/secrets/intake-session";
import type { IntakeVault } from "../src/secrets/intake-vault";
import {
	interactiveSecretPort,
	runSecretCommandForSurface,
	type SecretPortHost,
	type SecretCommandPort,
} from "../src/slash-commands/helpers/secret";
import type { AgentSession } from "../src/session/agent-session";

/**
 * WHY: Secret intake must never turn a one-time request into prompt history or a plaintext RPC field.
 * Drive both adapters through the same real broker and encrypted submission path.
 * This does not prove the interactive component's terminal masking; that is owned by showHookInput.
 */
describe("secret intake adapters", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	function makeRequest() {
		const context: SecretIntakeContext = {
			ownerSessionId: "session-fixture",
			projectId: "project-fixture",
			actorId: "operator-fixture",
		};
		const database = new Database(":memory:");
		const stored = new Map<string, string>();
		const vault: IntakeVault = {
			async saveVerified(identity, value) {
				const itemId = identity.requestId;
				stored.set(itemId, value);
				return { itemId };
			},
			async readVerified(identity, itemId) {
				if (identity.requestId !== itemId) throw new Error("fixture identity mismatch");
				const value = stored.get(itemId);
				if (value === undefined) throw new Error("fixture item missing");
				return value;
			},
		};
		const broker = new SecretIntakeBroker({
			database,
			vault,
			protection: { register: async () => {}, execute: async () => {} },
			vaultCollection: "fixture-collection",
			context,
			allowedOperations: [{ tool: "fixture-tool", purpose: "fixture-purpose" }],
		});
		const session = {} as AgentSession;
		const uninstall = installSessionSecretIntake(session, broker, context);
		cleanups.push(() => {
			uninstall();
			database.close();
		});
		return { context, session, broker, stored };
	}

	test("native /secret request prompts and submits through the sealed broker path", async () => {
		const { context, session, broker, stored } = makeRequest();
		const created = await broker.create(context, {
			purpose: "fixture-purpose",
			label: "Fixture credential",
			provider: "fixture-provider",
			approvedTool: "fixture-tool",
		});
		const secretValue = "fixture-only-secret-value";
		let maskOption: boolean | undefined;
		const port = interactiveSecretPort({
			session,
			sessionManager: { getCwd: () => "/fixture" },
			settings: {},
			showHookInput: async (
				_title: string,
				_initial: string | undefined,
				options?: { mask?: boolean; hint?: string },
			) => {
				maskOption = options?.mask;
				return secretValue;
			},
		} as unknown as SecretPortHost);
		const outcome = await runSecretCommandForSurface(`request ${created.request.requestId}`, port);

		expect(maskOption).toBe(true);
		expect(outcome.message).toBe("Secret request submitted.");
		expect(outcome.message).not.toContain(secretValue);
		expect(broker.get(context, created.request.requestId).request.status).toBe("saved");
		expect(stored.get(created.request.requestId)).toBe(secretValue);
	});

	test("cancelling the hidden field cancels the same broker request without saving", async () => {
		const { context, session, broker, stored } = makeRequest();
		const created = await broker.create(context, {
			purpose: "fixture-purpose",
			label: "Fixture credential",
			provider: "fixture-provider",
			approvedTool: "fixture-tool",
		});
		const outcome = await runSecretCommandForSurface(`request ${created.request.requestId}`, {
			session,
			promptForValue: async () => undefined,
		} as SecretCommandPort);

		expect(outcome.cancelled).toBe(true);
		expect(broker.get(context, created.request.requestId).request.status).toBe("cancelled");
		expect(stored.has(created.request.requestId)).toBe(false);
	});

	test("RPC get, decline, and cancel operate on the session-bound broker", async () => {
		const { context, session, broker } = makeRequest();
		const create = () =>
			broker.create(context, {
				purpose: "fixture-purpose",
				label: "Fixture credential",
				provider: "fixture-provider",
				approvedTool: "fixture-tool",
			});
		const [toGet, toDecline, toCancel] = await Promise.all([create(), create(), create()]);
		const host = {} as unknown as RpcCommandHost;
		const getReply = await handleRpcCommand(
			{ type: "secret_request", action: "get", requestId: toGet.request.requestId },
			session,
			host,
		);
		expect(getReply).toMatchObject({ command: "secret_request", success: true, data: { request: { status: "pending" } } });
		const declineReply = await handleRpcCommand(
			{ type: "secret_request", action: "decline", requestId: toDecline.request.requestId },
			session,
			host,
		);
		expect(declineReply).toMatchObject({ command: "secret_request", success: true, data: { request: { status: "declined" } } });
		const cancelReply = await handleRpcCommand(
			{ type: "secret_request", action: "cancel", requestId: toCancel.request.requestId },
			session,
			host,
		);
		expect(cancelReply).toMatchObject({ command: "secret_request", success: true, data: { request: { status: "cancelled" } } });
	});

	test("RPC submit shares the broker and refuses any plaintext field", async () => {
		const { context, session, broker, stored } = makeRequest();
		const created = await broker.create(context, {
			purpose: "fixture-purpose",
			label: "Fixture credential",
			provider: "fixture-provider",
			approvedTool: "fixture-tool",
		});
		const secretValue = "fixture-only-secret-value";
		const submission = await sealSecretSubmission(created.request, secretValue);
		const reply = await handleRpcCommand(
			{ type: "secret_request", action: "submit", requestId: created.request.requestId, submission },
			session,
			{} as unknown as RpcCommandHost,
		);
		expect(reply).toMatchObject({ command: "secret_request", success: true });
		if (!reply.success || reply.command !== "secret_request") throw new Error("sealed RPC submission was refused");
		expect(reply.data.request.status).toBe("saved");
		expect("secretRef" in reply.data.request).toBe(false);
		expect(JSON.stringify(reply.data)).not.toContain(secretValue);
		expect(stored.get(created.request.requestId)).toBe(secretValue);

		const another = await broker.create(context, {
			purpose: "fixture-purpose",
			label: "Second fixture credential",
			provider: "fixture-provider",
			approvedTool: "fixture-tool",
		});
		const plaintextFieldReply = await handleRpcCommand(
			{
				type: "secret_request",
				action: "submit",
				requestId: another.request.requestId,
				submission: await sealSecretSubmission(another.request, "another-fixture-value"),
				value: "another-fixture-value",
			} as RpcCommand,
			session,
			{} as unknown as RpcCommandHost,
		);
		expect(plaintextFieldReply).toMatchObject({ success: false, error: "Secret intake operation refused" });
		expect(broker.get(context, another.request.requestId).request.status).toBe("pending");
	});
});
