/**
 * The shipped placement reads the shared harness across sessions only when the
 * marker asks for it. Nothing in this product asks: every breakpoint is
 * session-scoped today, so an agent reads nothing its parent wrote.
 *
 * WHY THE CONTRACT CHANGED. Production marks the deepest stable system block as
 * well as system[0] (`cacheSystemPrefixBreakpoints`, packages/ai/src/providers/anthropic.ts:3158-3183).
 * An earlier version of this file asked whether a one-block-deeper anchor could pay
 * for itself, and assumed the deeper arm was not shipped. Under session scope the
 * shipped code already ties that arm, so those rows now assert the tie. Under shared
 * scope the rows compare the block-1 marker alone, which is the only difference.
 *
 * `scope: "global"` is the prompt-caching-scope beta. This repo sends that beta header on
 * both Anthropic layouts (anthropic.ts:180,188), and the field is first-class on the wire
 * type (anthropic-wire.ts:23-24), but nothing sets it. Shared scope is therefore a
 * counterfactual arm (`sharedGlobally`), not a description of production. The public
 * Messages API doc does not document the field
 * (https://platform.claude.com/docs/en/api/beta/messages/create), so nothing here claims
 * how a provider prices a shared write.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - Whether the provider scopes a breakpoint by default. Session scope is modelled
 *     from this repo's own wire notes, not from traffic.
 *   - Real agent fan-out. Every row sweeps the same fixed range; none claims a
 *     typical workload.
 *   - The premium on a shared write. The pessimistic rows bound it; they do not measure it.
 *
 * NUMBERS. Earlier MEASURED figures predate the placement change and are removed.
 * The rows assert order and ties; exact costs come from the run.
 *
 * REMOTE VERIFICATION. Not run locally (repo policy). The ties and orderings are
 * derived from the builder source, [INFERENCE] until the cf-ci run names these rows
 * with pass counts.
 */
import { describe, expect, it } from "bun:test";
import {
	type Arm,
	armPayloads,
	conversationAfter,
	deepAnchor,
	PRICE,
	PRODUCTION,
	prefixesOf,
	runFleet,
	type Step,
	sharedGlobally,
	systemPrompt,
} from "./harness";

const PARENT_TURNS = 6;
const AGENT_TURNS = 3;
const GAP_MS = 20_000;
/** The parent is already running when an agent starts; that is what sharing means. */
const AGENT_START_MS = 30_000;

/** A system prompt sharing the harness block and differing from block 1 onward. */
function systemFor(project: string, volatileSuffix: string): string[] {
	const blocks = systemPrompt({ volatileSuffix });
	blocks[1] = `PROJECT ${project}\n${"repository conventions that change when the project changes. ".repeat(120)}`;
	return blocks;
}

/** The parent: a long session whose trailing system block changes every turn. */
function parentSession(): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= PARENT_TURNS; turn++) {
		steps.push({
			context: {
				systemPrompt: systemFor("parent", `handle table revision ${turn}`),
				messages: conversationAfter(turn),
			},
			gapMs: turn === 1 ? 0 : GAP_MS,
		});
	}
	return steps;
}

/** An agent: its own project block, its own short history, starting mid-parent. */
function agentSession(id: number): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= AGENT_TURNS; turn++) {
		steps.push({
			context: {
				systemPrompt: systemFor(`agent-${id}`, `handle table revision ${turn}`),
				messages: conversationAfter(turn),
			},
			gapMs: turn === 1 ? AGENT_START_MS : GAP_MS,
		});
	}
	return steps;
}

/** A fleet of one parent and `fanOut` agents. */
function fleetOf(fanOut: number): Record<string, Step[]> {
	const fleet: Record<string, Step[]> = { parent: parentSession() };
	for (let id = 1; id <= fanOut; id++) fleet[`agent-${id}`] = agentSession(id);
	return fleet;
}

/** What an arm costs across the whole fleet at one fan-out. */
async function fleetCost(arm: Arm, fanOut: number): Promise<number> {
	return (await runFleet(arm, fleetOf(fanOut))).cost;
}

/** The fan-out range every row sweeps. */
const MAX_FAN_OUT = 14;

/**
 * How much more the shipped anchor costs than a one-block-deeper one, at each
 * fan-out from zero. Positive means the shipped anchor is the expensive one.
 */
async function deltasAcrossFanOut(shipped: Arm, deeper: Arm): Promise<number[]> {
	const deltas: number[] = [];
	for (let fanOut = 0; fanOut <= MAX_FAN_OUT; fanOut++) {
		deltas.push((await fleetCost(shipped, fanOut)) - (await fleetCost(deeper, fanOut)));
	}
	return deltas;
}

describe("a harness prefix shared between a parent and its agents", () => {
	it("is not shared at all while the marker leaves the scope unset", async () => {
		const sessionScoped = await runFleet(PRODUCTION, fleetOf(1));
		const globallyScoped = await runFleet(sharedGlobally(PRODUCTION), fleetOf(1));

		// The agent's first request carries a harness prefix the parent cached
		// thirty seconds earlier, byte for byte. Session-keyed, it reads none of it.
		expect(sessionScoped.sessions["agent-1"].turns[0].read).toBe(0);
		expect(globallyScoped.sessions["agent-1"].turns[0].read).toBeGreaterThan(0);
		// And what it reads is the harness prefix, not something deeper: the parent's
		// project block differs, so nothing past block 0 can match.
		const harness = await harnessPrefixTokens();
		expect(globallyScoped.sessions["agent-1"].turns[0].read).toBe(harness);
		expect(globallyScoped.cost).toBeLessThan(sessionScoped.cost);
	});

	it("ties production and a one-block-deeper anchor at every fan-out while the scope is unset", async () => {
		const deltas = await deltasAcrossFanOut(PRODUCTION, deepAnchor(1));

		// Production already marks the stable project block, so a deeper anchor has
		// nothing to add to a session-keyed cache. Every fan-out must tie.
		expect(deltas.every(delta => Math.abs(delta) < 1e-6)).toBe(true);
	});

	it("differs from production at every fan-out when the shallow anchor is session-scoped", async () => {
		// Negative control for the tie above: a layout known to differ. Without the block-1
		// marker, each parent turn after the first reads only the harness, while production
		// reads the harness plus the project block. Derived from PrefixCache.serve, not measured.
		const deltas = await deltasAcrossFanOut(deepAnchor(0), PRODUCTION);

		expect(deltas.every(delta => delta > 0)).toBe(true);
	});

	it("saves the block-1 marker's share at every fan-out once the scope is set", async () => {
		const deltas = await deltasAcrossFanOut(sharedGlobally(deepAnchor(0)), sharedGlobally(PRODUCTION));

		// Only the block-1 marker differs between these arms, and it is session-owned. Both
		// arms share the global block-0 entry, so both read the harness. Production's block-1
		// entry is read on every later turn; the shallow arm must bill that block as a write
		// instead. Derived from PrefixCache.serve, so the sign is positive at every fan-out.
		// The magnitude is not asserted.
		expect(deltas.every(delta => delta > 0)).toBe(true);
	});

	/**
	 * Setting the field is the cheap candidate this file produces, so it is worth
	 * knowing what would have to be true for it to be wrong. No published number
	 * says what a shared write costs; the pessimistic case is that it costs what the
	 * dearest write in the price table costs, and even then the switch has to pay
	 * for itself from the first sharing session or it is not a switch worth making.
	 */
	it("still pays for itself if a shared write turns out to cost the dearest write in the table", async () => {
		const pessimistic = PRICE.write1h / PRICE.write5m;
		const withoutSharing = await fleetCost(PRODUCTION, 1);
		const free = (await runFleet(sharedGlobally(PRODUCTION), fleetOf(1))).cost;
		const dear = (await runFleet(sharedGlobally(PRODUCTION), fleetOf(1), { globalWritePremium: pessimistic })).cost;

		expect(pessimistic).toBeGreaterThan(1);
		// The premium is real money, so the pessimistic arm must cost more than the
		// free one, or the sensitivity is not being applied at all.
		expect(dear).toBeGreaterThan(free);
		// And it still beats not sharing, from one agent: the parent publishes the
		// prefix once per lifetime and each agent skips a whole write of it.
		expect(dear).toBeLessThan(withoutSharing);
	});

	/**
	 * And the mistake the row above nearly shipped as its recommendation: scope
	 * every system marker rather than the anchor. The deepest one sits on the block
	 * that changes every turn, so it publishes a shared entry per turn that no
	 * session can ever match, and any premium at all turns the switch into a loss.
	 */
	it("is turned into a loss by scoping the marker on the block that changes", async () => {
		const pessimistic = PRICE.write1h / PRICE.write5m;
		const withoutSharing = await fleetCost(PRODUCTION, 1);
		const anchorOnly = (await runFleet(sharedGlobally(PRODUCTION), fleetOf(1), { globalWritePremium: pessimistic }))
			.cost;
		const everywhere = (
			await runFleet(sharedGlobally(PRODUCTION, { everySystemMarker: true }), fleetOf(1), {
				globalWritePremium: pessimistic,
			})
		).cost;

		expect(everywhere).toBeGreaterThan(anchorOnly);
		expect(everywhere).toBeGreaterThan(withoutSharing);
	});

	/**
	 * A guard on the fixture: the two sessions must actually share the harness
	 * block and actually differ after it, or every row above passes by measuring
	 * two unrelated prompts.
	 */
	it("keeps the parent and the agent sharing the harness and nothing past it", async () => {
		const [parent] = await armPayloads(PRODUCTION, [parentSession()[0]]);
		const [child] = await armPayloads(PRODUCTION, [agentSession(1)[0]]);

		const parentBlocks = (parent.system ?? []).map(block => block.text);
		const childBlocks = (child.system ?? []).map(block => block.text);
		expect(childBlocks[0]).toBe(parentBlocks[0]);
		expect(childBlocks[1]).not.toBe(parentBlocks[1]);
		expect(await harnessPrefixTokens()).toBeGreaterThan(2048);
	});
});

/** The size of the prefix the shipped anchor closes: block 0 and nothing else. */
async function harnessPrefixTokens(): Promise<number> {
	const [first] = await armPayloads(PRODUCTION, [parentSession()[0]]);
	return prefixesOf(first)[0]?.tokens ?? 0;
}
