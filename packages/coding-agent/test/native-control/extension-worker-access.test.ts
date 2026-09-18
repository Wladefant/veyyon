import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ModelRegistry } from "../../src/config/model-registry";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionRuntime as IExtensionRuntime,
} from "../../src/extensibility/extensions/types";
import { type SessionWorkerAccess, sessionWorkerAccess } from "../../src/native-control/telegram-control-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { IrcBus, type IrcMessage } from "../../src/task/irc-bus";

const OWN_SCOPE = "session-own";
const OTHER_SCOPE = "session-other";

let registry: AgentRegistry;
let bus: IrcBus;
let inboxes: Map<string, IrcMessage[]>;

/** A worker whose inbox is observable, so a delivery claim can be checked against it. */
function fakeWorkerSession(id: string): AgentSession {
	inboxes.set(id, []);
	return {
		deliverIrcMessage: async (msg: IrcMessage) => {
			inboxes.get(id)?.push(msg);
			return "woken" as const;
		},
	} as unknown as AgentSession;
}

function access(scope: string | undefined, sender?: string): SessionWorkerAccess {
	return sessionWorkerAccess(() => scope, { registry, bus, ...(sender ? { sender } : {}) });
}

beforeEach(() => {
	registry = new AgentRegistry();
	bus = new IrcBus(registry);
	inboxes = new Map();
});

describe("extension worker access", () => {
	test("lists this conversation's workers only, newest activity first", () => {
		registry.register({
			id: "Older",
			displayName: "Older",
			kind: "sub",
			status: "running",
			model: "google/gemini-3-8-flash",
			session: fakeWorkerSession("Older"),
			scope: OWN_SCOPE,
		});
		registry.register({
			id: "Newer",
			displayName: "Newer",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Newer"),
			scope: OWN_SCOPE,
		});
		registry.register({
			id: "Foreign",
			displayName: "Foreign",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Foreign"),
			scope: OTHER_SCOPE,
		});
		registry.setActivity("Older", "started first");
		registry.setActivity("Newer", "reading the failing test");

		const workers = access(OWN_SCOPE).listWorkers();

		expect(workers.map(worker => worker.id)).toEqual(["Newer", "Older"]);
		expect(workers[0]).toMatchObject({
			id: "Newer",
			status: "running",
			activity: "reading the failing test",
			live: true,
		});
		expect(workers[1]?.model).toBe("google/gemini-3-8-flash");
	});

	test("reports a worker that exited rather than dropping it from the roster", () => {
		registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			status: "parked",
			session: null,
			scope: OWN_SCOPE,
		});

		const workers = access(OWN_SCOPE).listWorkers();

		expect(workers).toHaveLength(1);
		expect(workers[0]).toMatchObject({ id: "Parked", status: "parked", live: false });
	});

	test("omits advisor transcripts unless asked, and refuses to steer one either way", async () => {
		registry.register({
			id: "Advisor",
			displayName: "Advisor",
			kind: "advisor",
			status: "idle",
			session: null,
			scope: OWN_SCOPE,
		});
		const workers = access(OWN_SCOPE);

		expect(workers.listWorkers()).toEqual([]);
		expect(workers.listWorkers({ includeAdvisors: true }).map(worker => worker.id)).toEqual(["Advisor"]);

		const receipt = await workers.steerWorker("Advisor", "take this over");
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("advisor");
	});

	test("delivers a steer to the named worker's inbox under the caller's origin", async () => {
		registry.register({
			id: "Target",
			displayName: "Target",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Target"),
			scope: OWN_SCOPE,
		});
		registry.register({
			id: "Bystander",
			displayName: "Bystander",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Bystander"),
			scope: OWN_SCOPE,
		});

		const receipt = await access(OWN_SCOPE, "TelegramOperator").steerWorker("Target", "stop and rerun the suite");

		// The exact delivered outcome ("woken", "injected", "queued") is IrcBus's
		// vocabulary and depends on what the worker was doing; what this contract
		// owes the caller is that a delivered steer is not reported as failed.
		expect(receipt.to).toBe("Target");
		expect(receipt.outcome).not.toBe("failed");
		expect(receipt.error).toBeUndefined();
		expect(inboxes.get("Target")).toMatchObject([
			{ from: "TelegramOperator", to: "Target", body: "stop and rerun the suite" },
		]);
		expect(inboxes.get("Bystander")).toEqual([]);
	});

	test("refuses a steer aimed outside the conversation without delivering it anywhere", async () => {
		registry.register({
			id: "Foreign",
			displayName: "Foreign",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Foreign"),
			scope: OTHER_SCOPE,
		});
		registry.register({
			id: "Mine",
			displayName: "Mine",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Mine"),
			scope: OWN_SCOPE,
		});

		const receipt = await access(OWN_SCOPE).steerWorker("Foreign", "pick up my task");

		expect(receipt).toMatchObject({ to: "Foreign", outcome: "failed" });
		expect(receipt.error).toContain("not available in the bound session");
		// The point of the refusal: it does not silently land on a worker the
		// caller can reach, and it does not reach the addressee either.
		expect(inboxes.get("Foreign")).toEqual([]);
		expect(inboxes.get("Mine")).toEqual([]);
	});

	test("refuses an unknown worker id and an empty message without delivering", async () => {
		registry.register({
			id: "Target",
			displayName: "Target",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Target"),
			scope: OWN_SCOPE,
		});
		const workers = access(OWN_SCOPE);

		const unknown = await workers.steerWorker("NoSuchWorker", "hello");
		expect(unknown).toMatchObject({ to: "NoSuchWorker", outcome: "failed" });
		expect(unknown.error).toContain("Unknown agent");

		const blank = await workers.steerWorker("Target", "   \n  ");
		expect(blank).toMatchObject({ to: "Target", outcome: "failed" });
		expect(blank.error).toContain("empty message");
		expect(inboxes.get("Target")).toEqual([]);
	});

	test("an unresolved conversation lists nothing and addresses nobody", async () => {
		registry.register({
			id: "Foreign",
			displayName: "Foreign",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Foreign"),
			scope: OTHER_SCOPE,
		});
		const workers = access(undefined);

		// Not "every worker in the process": a host holding several conversations
		// would otherwise hand one extension another operator's roster.
		expect(workers.listWorkers()).toEqual([]);

		const receipt = await workers.steerWorker("Foreign", "pick up my task");
		expect(receipt).toMatchObject({ to: "Foreign", outcome: "failed" });
		expect(receipt.error).toContain("no registered conversation");
		expect(inboxes.get("Foreign")).toEqual([]);
	});

	test("an extension calling either action from the factory body is told to move it into a handler", () => {
		const uninitialized = new ExtensionRuntime();

		expect(() => uninitialized.listWorkers()).toThrow(/cannot be called from the factory body/);
		expect(() => uninitialized.steerWorker()).toThrow(/cannot be called from the factory body/);
	});
});

/**
 * `ExtensionRunner.initialize` installs the host's actions onto the shared
 * runtime one member at a time, and the throwing stub it replaces satisfies the
 * same interface — so an action the copy forgets type-checks clean and throws
 * "cannot be called from the factory body" at an extension that did everything
 * right. That is how these two shipped dead the first time.
 */
describe("extension worker actions survive runner initialization", () => {
	test("an initialized runtime answers with the roster instead of the uninitialized stub", async () => {
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			status: "running",
			session: fakeWorkerSession("Worker"),
			scope: OWN_SCOPE,
		});
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner(
			[],
			runtime,
			"/tmp",
			{} as unknown as SessionManager,
			{} as unknown as ModelRegistry,
		);
		const noop = () => {};
		const actions: ExtensionActions = {
			sendMessage: noop,
			sendUserMessage: noop,
			appendEntry: noop,
			setLabel: noop,
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => true,
			getThinkingLevel: () => undefined,
			setThinkingLevel: noop,
			getSessionName: () => undefined,
			setSessionName: async () => {},
			...access(OWN_SCOPE, "TelegramOperator"),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: noop,
			hasPendingMessages: () => false,
			shutdown: noop,
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		};

		runner.initialize(actions, contextActions);

		// The class declares its uninitialized stubs zero-arg, as every other
		// action does, so calls go through the contract the extension API holds.
		const initialized: IExtensionRuntime = runtime;
		expect(initialized.listWorkers().map(worker => worker.id)).toEqual(["Worker"]);
		const receipt = await initialized.steerWorker("Worker", "rerun the suite");
		expect(receipt.outcome).not.toBe("failed");
		expect(inboxes.get("Worker")).toMatchObject([{ from: "TelegramOperator", body: "rerun the suite" }]);
	});
});
