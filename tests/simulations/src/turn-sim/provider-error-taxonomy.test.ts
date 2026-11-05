/**
 * Every class of provider failure, and what the session is allowed to do about it.
 *
 * WHY THIS FILE EXISTS. `provider-goes-quiet.test.ts` next door pins one
 * retryable error and one permanent one, which proves the mechanism exists and
 * says nothing about the taxonomy. The taxonomy is where the damage is: a
 * permanent failure that gets retried spends the whole budget before the
 * operator learns anything, and when the permanent failure is a BILLING one
 * (`402 ... depleted your monthly included credits`) each extra attempt is
 * another request against a credential that has already run out. A retryable
 * failure that is treated as permanent is the same defect from the other side: a
 * 503 that would have cleared on the next attempt ends the turn instead.
 *
 * So every error shape a real provider actually returns gets a row here, with the
 * one decision that matters recorded next to it: may this be resampled? A new
 * shape means a new row, which is a decision somebody makes, rather than a case
 * the suite quietly stops covering.
 *
 * The rows are the spec, deliberately. Deriving them from the classifier would
 * assert the classifier agrees with itself; here the expectation is written down
 * independently and the run says whether the product matches it.
 *
 * Two axes: an empty transient failure can be resampled, but visible partial
 * text must survive in the transcript without automatic replay. A user can
 * start a new turn after that terminal failure.
 *
 * Determinism: no sleeps. The harness shrinks retry delays and bounds retries.
 * A test timeout catches an unbounded retry or stalled turn.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { createSimulation, lastAssistantText, type Simulation } from "./harness";
import { describeViolations, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** The retry budget the harness installs: two retries after the first attempt. */
const RETRY_BUDGET = 2;
const ANSWER = "answered on the attempt that worked";

interface ErrorRow {
	readonly name: string;
	/** What the provider says. Real wire text, because that is what gets classified. */
	readonly message: string;
	/** May the session resample this, or is another attempt guaranteed to fail too? */
	readonly resampleable: boolean;
}

const ERROR_ROWS: readonly ErrorRow[] = [
	{ name: "429 rate limit", message: "429 Too Many Requests: rate limit exceeded", resampleable: true },
	{ name: "500 internal", message: "500 Internal Server Error", resampleable: true },
	{ name: "502 bad gateway", message: "502 Bad Gateway", resampleable: true },
	{ name: "503 unavailable", message: "503 Service Unavailable: upstream overloaded", resampleable: true },
	{ name: "504 gateway timeout", message: "504 Gateway Timeout", resampleable: true },
	{ name: "529 overloaded", message: "529 Overloaded: the service is temporarily overloaded", resampleable: true },
	{ name: "http2 stream reset", message: "stream error: NGHTTP2_INTERNAL_ERROR", resampleable: true },
	{ name: "connection reset", message: "read ECONNRESET", resampleable: true },
	{ name: "connect timeout", message: "connect ETIMEDOUT 10.0.0.1:443", resampleable: true },
	{ name: "401 bad credential", message: "401 Unauthorized: invalid api key", resampleable: false },
	{ name: "403 forbidden", message: "403 Forbidden: your account cannot access this model", resampleable: false },
	{
		name: "402 depleted credits",
		message: "402 Payment Required: You have depleted your monthly included credits",
		resampleable: false,
	},
	{
		name: "400 malformed request",
		message: "400 Bad Request: messages.1: tool_use ids must be unique",
		resampleable: false,
	},
	{ name: "404 unknown model", message: "404 Not Found: model does not exist", resampleable: false },
];

/** Whether the turn had already streamed something when the failure landed. */
const ARRIVALS = ["before any content", "after partial text"] as const;

function lastAssistant(simulation: Simulation): AssistantMessage {
	const assistants = simulation.session.messages.filter(
		(message): message is AssistantMessage => message.role === "assistant",
	);
	const tail = assistants.at(-1);
	if (!tail) throw new Error("no assistant message in the transcript");
	return tail;
}

/** A distinguishing fragment of the row's own text, for "the reason is named". */
function reasonFragment(row: ErrorRow): string {
	return row.message.split(":").at(-1)?.trim() ?? row.message;
}

describe("a provider failure is resampled only when resampling could help", () => {
	it("covers both classes of failure and both arrivals", () => {
		expect(ERROR_ROWS.length).toBeGreaterThanOrEqual(14);
		expect(ERROR_ROWS.filter(row => row.resampleable).length).toBeGreaterThanOrEqual(6);
		expect(ERROR_ROWS.filter(row => !row.resampleable).length).toBeGreaterThanOrEqual(5);
		expect(new Set(ERROR_ROWS.map(row => row.name)).size).toBe(ERROR_ROWS.length);
		expect(ARRIVALS.length).toBe(2);
	});

	for (const row of ERROR_ROWS) {
		for (const arrival of ARRIVALS) {
			it(`${row.name}, ${arrival}`, async () => {
				const cell = `${row.name} / ${arrival}`;
				sim = await createSimulation({
					settings: { "retry.enabled": true },
					// Only an empty transient failure may reach the recovery turn.
					// Keep recovery scripted for every cell so an unintended replay
					// after visible output or a permanent failure is observable.
					script: turn => {
						if (turn.call === 1) {
							if (arrival === "after partial text") turn.text("partial answer. ");
							turn.fail(row.message);
							return;
						}
						turn.text(ANSWER);
						turn.finish();
					},
				});

				await sim.session.prompt("go");

				expect(describeViolations(cell, turnViolations(sim))).toEqual([]);
				if (row.resampleable && arrival === "before any content") {
					expect(sim.providerCalls()).toBe(2);
					expect(lastAssistantText(sim.session)).toContain(ANSWER);
					expect(lastAssistant(sim).stopReason).toBe("stop");
					return;
				}
				// One attempt, and the operator is told what upstream said. A
				// permanent failure that spends the budget is the expensive half of
				// this contract; one that reports nothing is the useless half.
				expect(sim.providerCalls()).toBe(1);
				expect(lastAssistant(sim).stopReason).toBe("error");
				expect(lastAssistant(sim).errorMessage ?? "").toContain(reasonFragment(row));
				if (arrival === "after partial text") {
					expect(lastAssistantText(sim.session)).toContain("partial answer.");
				}
			});
		}
	}

	for (const row of ERROR_ROWS.filter(candidate => candidate.resampleable)) {
		it(`${row.name} that never clears costs the budget and stops`, async () => {
			// The other side of the bound. A resampleable error is worth another
			// attempt, and an unbounded number of attempts is a session that never
			// reports anything, so the budget has to be spent exactly.
			sim = await createSimulation({
				settings: { "retry.enabled": true },
				script: turn => {
					turn.fail(`${row.message} (attempt ${turn.call})`);
				},
			});

			await sim.session.prompt("go");

			expect(sim.providerCalls()).toBe(RETRY_BUDGET + 1);
			expect(sim.session.isStreaming).toBe(false);
			expect(sim.session.isRetrying).toBe(false);
			expect(lastAssistant(sim).stopReason).toBe("error");
			expect(lastAssistant(sim).errorMessage ?? "").toContain(reasonFragment(row));
		});
	}

	it("keeps the partial answer a terminally failed turn had already streamed", async () => {
		// Visible output ends automatic replay even for a transient failure.
		// Keep that partial in the transcript so a later user turn can use it.
		sim = await createSimulation({
			settings: { "retry.enabled": true },
			script: turn => {
				turn.text(`half an answer before attempt ${turn.call} died. `);
				turn.fail("stream error: NGHTTP2_INTERNAL_ERROR");
			},
		});

		await sim.session.prompt("go");

		expect(sim.providerCalls()).toBe(1);
		expect(sim.session.isStreaming).toBe(false);
		expect(sim.session.isRetrying).toBe(false);
		const streamed = sim.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join(" ");
		expect(streamed).toContain("half an answer before attempt");
		expect(lastAssistant(sim).stopReason).toBe("error");
	});

	it("keeps a failed partial when the user starts a recovery turn", async () => {
		// A new user turn may recover after a partial failure. It must not erase
		// the visible text from the failed turn.
		sim = await createSimulation({
			settings: { "retry.enabled": true },
			script: turn => {
				if (turn.call === 1) {
					turn.text("abandoned half-reply. ");
					turn.fail("stream error: NGHTTP2_INTERNAL_ERROR");
					return;
				}
				turn.text(ANSWER);
				turn.finish();
			},
		});

		await sim.session.prompt("go");
		expect(sim.providerCalls()).toBe(1);
		expect(lastAssistantText(sim.session)).toContain("abandoned half-reply.");
		expect(lastAssistant(sim).stopReason).toBe("error");

		await sim.session.prompt("continue");

		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toContain(ANSWER);
		expect(lastAssistant(sim).stopReason).toBe("stop");
		const streamed = sim.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join(" ");
		expect(streamed).toContain("abandoned half-reply");
	});
});
