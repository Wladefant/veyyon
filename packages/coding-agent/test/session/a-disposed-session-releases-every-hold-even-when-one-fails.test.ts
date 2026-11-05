/**
 * WHY: a session's disposal releases what it holds outside itself through one collaborator,
 * `SessionRelease`: the jobs it and its spawned agents started, the job manager it owns, its eval
 * runs, the resources keyed by its eval-kernel owner id and by its session id, and its hold on the MCP
 * manager. The defects at that boundary share one shape, a hold that outlives the session: a release
 * that throws skips the ones after it, a release keyed by the other owner id matches nothing, the
 * process-global job manager is cleared when it belongs to another session or kept after its owner
 * disposed it, and an MCP peer that never answers holds `/exit` open.
 *
 * Each case drives the real collaborator against real `AsyncJobManager` instances, and observes the
 * owner-scoped registry at its one entry point, `disposeOwnedResources`, which is where a subsystem's
 * disposer receives the owner id.
 *
 * What it does not catch: the disposers the registry holds (`owned-resources.test.ts`), and whether a
 * real session's dispose reaches these releases
 * (`a-conversation-left-running-by-new-is-disposed-when-it-goes-quiet.test.ts` disposes real sessions
 * and observes both scopes and the MCP disconnect).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { SessionRelease } from "@veyyon/coding-agent/session/runtime/session-release";
import * as ownedResources from "@veyyon/kernel/session/owned-resources";
import { drainMicrotasks } from "../../../utils/test/helpers/drain-microtasks";

const EVAL_OWNER = "eval-owner-1";
const SESSION_ID = "session-1";

interface Script {
	/** The session's transcript id; a session that never had one passes `null`. */
	sessionId?: string | null;
	/** Whether the eval runs settle; `false` is a run still going after its abort. */
	evalSettles?: boolean;
	/** The owner-scoped registry call that throws, the way it does when a disposer failed. */
	failingScope?: ownedResources.OwnedResourceScope;
	/** Whether the session owns a job manager. */
	ownsManager?: boolean;
	releaseMcp?: () => Promise<void>;
}

function harness(script: Script = {}) {
	const events: string[] = [];
	vi.spyOn(ownedResources, "disposeOwnedResources").mockImplementation(async (scope, ownerId) => {
		events.push(`release ${scope} ${ownerId}`);
		if (scope === script.failingScope) throw new AggregateError([new Error("close failed")], "release failed");
	});
	const manager = script.ownsManager ? new AsyncJobManager({ onJobComplete: () => {} }) : undefined;
	if (manager) {
		const dispose = manager.dispose.bind(manager);
		vi.spyOn(manager, "dispose").mockImplementation(options => {
			events.push(`dispose manager within ${options?.timeoutMs}`);
			return dispose(options);
		});
	}
	const release = new SessionRelease(
		{
			ownedJobs: { cancelOwn: () => void events.push("cancel own jobs") },
			executions: {
				settleEvalForDispose: async () => {
					events.push("settle eval");
					return script.evalSettles ?? true;
				},
			},
			config: { ownedAsyncJobManager: manager, releaseMcpManager: script.releaseMcp },
			sessionId: () => (script.sessionId === null ? undefined : (script.sessionId ?? SESSION_ID)),
		},
		EVAL_OWNER,
	);
	return { events, release, manager };
}

const EVERY_RELEASE = [
	"cancel own jobs",
	"settle eval",
	`release eval-kernel-owner ${EVAL_OWNER}`,
	`release session ${SESSION_ID}`,
];

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	AsyncJobManager.resetForTests();
});

describe("the work a disposed session started", () => {
	it("is released jobs first, then the owned manager, the eval runs, and each scope by its own owner id", async () => {
		const { events, release, manager } = harness({ ownsManager: true });

		await release.releaseWork();

		expect(events).toEqual([
			"cancel own jobs",
			"dispose manager within 3000",
			"settle eval",
			`release eval-kernel-owner ${EVAL_OWNER}`,
			`release session ${SESSION_ID}`,
		]);
		// A disposed manager takes no new job.
		expect(manager?.atCapacity).toBe(true);
	});

	it.each([
		["an eval run outlives its abort", { evalSettles: false }],
		["an eval kernel fails to close", { failingScope: "eval-kernel-owner" }],
		["a session-scoped resource fails to close", { failingScope: "session" }],
	] satisfies [string, Script][])("is released in full when %s, and dispose does not throw", async (_, script) => {
		const { events, release } = harness(script);

		await expect(release.releaseWork()).resolves.toBeUndefined();

		expect(events).toEqual(EVERY_RELEASE);
	});

	it("releases no session-scoped resource for a session that never had a transcript id", async () => {
		const { events, release } = harness({ sessionId: null });

		await release.releaseWork();

		expect(events).toEqual(["cancel own jobs", "settle eval", `release eval-kernel-owner ${EVAL_OWNER}`]);
	});

	it.each([
		["the manager it owned", true],
		["another session's manager", false],
	])("clears the process-global job manager only when it is %s", async (_, globalIsOwned) => {
		const { release, manager } = harness({ ownsManager: true });
		const other = new AsyncJobManager({ onJobComplete: () => {} });
		AsyncJobManager.setInstance(globalIsOwned ? manager : other);

		await release.releaseWork();

		expect(AsyncJobManager.instance()).toBe(globalIsOwned ? undefined : other);
	});
});

describe("the MCP hold of a disposed session", () => {
	it("is dropped through the callback the session was given", async () => {
		const { events, release } = harness({
			releaseMcp: async () => void events.push("release mcp"),
		});

		await release.releaseMcpHold();

		expect(events).toEqual(["release mcp"]);
	});

	it("is not awaited past three seconds when its release never settles", async () => {
		vi.useFakeTimers();
		const { release } = harness({ releaseMcp: () => new Promise<void>(() => {}) });
		let settled = false;
		const done = release.releaseMcpHold().then(() => {
			settled = true;
		});

		vi.advanceTimersByTime(2_998);
		await drainMicrotasks(20);
		expect(settled).toBe(false);

		vi.advanceTimersByTime(2);
		await done;
		expect(settled).toBe(true);
	});

	it("does not throw out of dispose when its release fails", async () => {
		const { release } = harness({ releaseMcp: () => Promise.reject(new Error("transport closed")) });

		await expect(release.releaseMcpHold()).resolves.toBeUndefined();
	});
});
