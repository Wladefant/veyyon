/**
 * The canonical order of a credential's block snapshots, shared by the broker server and the client store.
 *
 * WHY THIS SUITE EXISTS. Block lists are compared positionally, so the server and the client
 * must sort the same blocks into the same order. The server once kept its own comparator that
 * dropped the `updatedAtMs` tiebreak, and the client's kept it. Two blocks that tie on provider,
 * scope and expiry then sorted one way on one side and another way on the other. Nothing threw;
 * the snapshot just looked changed on every poll. This suite pins the one order both sides use.
 *
 * It does not catch a future third comparator that happens to agree with this one on these
 * inputs, nor a caller that sorts without the comparator at all.
 */

import { describe, expect, it } from "bun:test";
import { compareCredentialBlockSnapshots } from "../src/auth-broker/protocol";
import type { CredentialBlockSnapshot } from "../src/auth-broker/types";

function block(over: Partial<CredentialBlockSnapshot>): CredentialBlockSnapshot {
	return {
		providerKey: "openai",
		blockScope: "model",
		blockedUntilMs: 1_000,
		updatedAtMs: 1,
		...over,
	} as CredentialBlockSnapshot;
}

describe("canonical block snapshot order", () => {
	it("breaks an expiry tie by updatedAtMs, so identical expiries still sort stably", () => {
		const older = block({ blockedUntilMs: 1_000, updatedAtMs: 10 });
		const newer = block({ blockedUntilMs: 1_000, updatedAtMs: 20 });
		const sorted = [newer, older].sort(compareCredentialBlockSnapshots);
		expect(sorted).toEqual([older, newer]);
	});

	it("orders by blockedUntilMs before it reaches the updatedAtMs tiebreak", () => {
		const laterExpiry = block({ blockedUntilMs: 2_000, updatedAtMs: 1 });
		const earlierExpiry = block({ blockedUntilMs: 1_000, updatedAtMs: 99 });
		const sorted = [laterExpiry, earlierExpiry].sort(compareCredentialBlockSnapshots);
		expect(sorted).toEqual([earlierExpiry, laterExpiry]);
	});
});
