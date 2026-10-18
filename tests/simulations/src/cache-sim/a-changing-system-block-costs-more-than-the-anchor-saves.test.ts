/**
 * When a later system block changes every turn, the shipped placement caches
 * the harness and the stable blocks before it, and nothing after the change.
 * This file prices which placement reads the most when the tail moves.
 *
 * WHY THE CONTRACT CHANGED. An earlier version assumed production marked only
 * system[0] and the last block, so a marker on the deepest stable block would
 * win. `cacheSystemPrefixBreakpoints` (packages/ai/src/providers/anthropic.ts:3158-3183)
 * now places markers on system[0] and on the deepest stable blocks, walking back
 * from `stableSystemSuffixStart` (anthropic.ts:3127) until the system budget of
 * three is spent. Production therefore already ends a marker on the last stable
 * block. The rows assert that, instead of asserting a win the placement no longer has.
 *
 * Placements priced below:
 *   - production:  the shipped builder output, no remark (PRODUCTION).
 *   - simple:      the rule this repo was compared against (SIMPLE_PLACEMENT).
 *   - shallow:     block 0 and the trailing block only (deepAnchor(0)).
 *   - deeper:      the stable block and the trailing block (deepAnchor(1)).
 *   - onto-change: the trailing block (deepAnchor(2)), which reads nothing.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - Nothing here says which block is stable in production. The builder decides
 *     that from `stableSystemSuffixStart`, which recognises only `<memories>` recall
 *     blocks (anthropic.ts:3125). This fixture's trailing block (`SESSION`) is not
 *     one of them. The walk from it reaches block 1 through the system budget of three
 *     (anthropic.ts:3219,3525), not through the recall rule.
 *   - The Argot handle table is described in older comments as the shipped volatile
 *     block. It does not start with `<memories>`, so the builder does not detect it.
 *     That gap is reported, not fixed, by this file.
 *   - Agent sharing. That is modelled in the sibling file, not here.
 *
 * NUMBERS. Earlier MEASURED figures predate the placement change and are removed.
 * The rows assert order and ties; exact costs come from the run.
 *
 * REMOTE VERIFICATION. Not run locally (repo policy). The orderings and ties are
 * derived from the builder source, [INFERENCE] until the cf-ci run names these rows
 * with pass counts.
 */
import { describe, expect, it } from "bun:test";
import {
	type Arm,
	armPayloads,
	conversationAfter,
	deepAnchor,
	growingSession,
	PRODUCTION,
	padding,
	prefixesOf,
	runArm,
	type SessionLedger,
	SIMPLE_PLACEMENT,
	type Step,
	systemPrompt,
} from "./harness";

const TURNS = 6;
const GAP_MS = 20_000;

/** The system prompt every arm sends, with a tail that changes on every turn. */
function volatileTailSession(): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= TURNS; turn++) {
		steps.push({
			context: {
				// Argot's handle table is the shipped block that behaves this way: it
				// is last, and it changes as the session mints handles.
				systemPrompt: systemPrompt({ volatileSuffix: `handle table revision ${turn}` }),
				messages: conversationAfter(turn),
			},
			gapMs: turn === 1 ? 0 : GAP_MS,
		});
	}
	return steps;
}

const STABLE = growingSession({ turns: TURNS, gapMs: GAP_MS });

/** The deepest prefix an arm offers on its last turn, in estimated tokens. */
async function deepestPrefix(arm: Arm, steps: readonly Step[]): Promise<number> {
	const payloads = await armPayloads(arm, steps);
	return prefixesOf(payloads.at(-1) as (typeof payloads)[number]).at(-1)?.tokens ?? 0;
}

/** Tokens an arm read across every turn but the first, which can read nothing. */
function readAfterFirstTurn(ledger: SessionLedger): number {
	return ledger.turns.slice(1).reduce((sum, turn) => sum + turn.read, 0);
}

describe("a system block that changes every turn", () => {
	it("reads exactly what the simpler placement reads once the tail changes, and never costs more", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const simple = await runArm(SIMPLE_PLACEMENT, volatile);

		// Production now marks the deepest stable block, as the simple rule does,
		// so both arms keep the same prefix alive and read the same tokens. The
		// earlier direction (the simple rule reads more) held only while production
		// marked block 0 alone.
		expect(readAfterFirstTurn(production)).toBe(readAfterFirstTurn(simple));
		expect(readAfterFirstTurn(production)).toBeGreaterThan(0);
		expect(production.cost).toBeLessThanOrEqual(simple.cost + 1e-6);
	});

	it("reads past the harness into the stable project block, which a block-0-only anchor cannot", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const harnessOnly = await runArm(deepAnchor(0), volatile);

		// Per-turn reads are flat in a volatile session: every turn falls back to its
		// deepest surviving marker. Production's surviving marker sits on the project
		// block; the block-0 anchor's sits on the harness alone.
		expect(production.turns[TURNS - 1].read).toBeGreaterThan(harnessOnly.turns[TURNS - 1].read);
	});

	it("ties a one-block-deeper anchor on a volatile tail, because production already marks that block", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const deeper = await runArm(deepAnchor(1), volatile);
		// Derived from PrefixCache.serve: both arms end a marker on the trailing block and
		// read the same longest held prefix (blocks 0 and 1), so they bill the same tokens.

		expect(Math.abs(deeper.cost - production.cost)).toBeLessThan(1e-6);
	});

	it("is no dearer with a one-block-deeper anchor when the system prompt is stable", async () => {
		const productionStable = await runArm(PRODUCTION, STABLE);
		const deeperStable = await runArm(deepAnchor(1), STABLE);

		expect(deeperStable.cost).toBeLessThanOrEqual(productionStable.cost + 1e-6);
	});

	/**
	 * And the candidate is not "mark deeper". Anchoring the block that CHANGES
	 * spends the stable marker on a prefix nothing can ever match again, which is
	 * worse than the shallow anchor it replaced. Any patch that moves this marker has
	 * to know which block is stable; moving it by one and hoping is the expensive mistake.
	 */
	it("is made worse, not better, by anchoring the block that changes", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const ontoTheChange = await runArm(deepAnchor(2), volatile);

		expect(readAfterFirstTurn(ontoTheChange)).toBe(0);
		expect(ontoTheChange.cost).toBeGreaterThan(production.cost * 2);
	});

	/**
	 * And the reason the whole file is about the SYSTEM prompt: on a stable system
	 * prompt the shipped placement is already the best of the three, so this is not
	 * an argument for adopting the simpler rule.
	 */
	it("does not indict the shipped placement on a stable system prompt", async () => {
		const production = await runArm(PRODUCTION, STABLE);
		const simple = await runArm(SIMPLE_PLACEMENT, STABLE);

		expect(production.cost).toBeLessThanOrEqual(simple.cost);
	});

	/**
	 * A guard on the fixture rather than the product: if the volatile block ever
	 * stops being deep enough to matter, every row above would pass by measuring
	 * nothing.
	 */
	it("keeps the volatile block behind a prefix worth caching", async () => {
		const deepest = await deepestPrefix(PRODUCTION, volatileTailSession());

		expect(deepest).toBeGreaterThan(2048);
		expect(padding(1).length).toBe(4);
	});
});
