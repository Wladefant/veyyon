/**
 * DS-8 shimmer dead-path audit, locked as a test: after the composer hairline
 * went static (chrome never animates), shimmer.ts must carry no orphaned
 * machinery. Every export must be consumed by NON-TEST production code —
 * directly by another src module, or internally by shimmer.ts itself with the
 * export kept only as test visibility (the documented tuning/introspection
 * allowlist below).
 *
 * Why a scan test: an unused export is invisible to the type checker and to
 * reviewers of later diffs. When a surface stops using a motion path, this
 * suite fails loudly instead of leaving a half-dead engine behind (Review
 * Vector 11: utilization).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ACTIVITY_PROFILES, livingIntensity, type ShimmerActivity } from "@veyyon/coding-agent/theme/shimmer";

const PKG_ROOT = path.resolve(import.meta.dir, "../..");
const SRC_ROOT = path.join(PKG_ROOT, "src");
const SHIMMER_PATH = path.join(SRC_ROOT, "theme/shimmer.ts");

/** Exports that exist FOR TESTS (tuning constants, state introspection) but
 *  whose logic is exercised internally by shimmer.ts production paths. Each
 *  entry must still have an internal (non-export-line) use, verified below. */
const TEST_VISIBILITY_ALLOWLIST = new Set(["LAVA_TUNING", "getShimmerActivity"]);

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
	}
	return out;
}

function shimmerExports(source: string): string[] {
	const names: string[] = [];
	for (const m of source.matchAll(/^export (?:const|function|type|interface|class) ([A-Za-z0-9_]+)/gm)) {
		names.push(m[1]!);
	}
	return names;
}

describe("shimmer.ts utilization — no orphaned machinery", () => {
	const shimmerSource = fs.readFileSync(SHIMMER_PATH, "utf8");
	const exports = shimmerExports(shimmerSource);
	const otherSources = listSourceFiles(SRC_ROOT)
		.filter(f => f !== SHIMMER_PATH)
		.map(f => fs.readFileSync(f, "utf8"));

	it("parses a plausible export surface (guards the scanner itself)", () => {
		expect(exports).toContain("shimmerText");
		expect(exports).toContain("lavaText");
		expect(exports.length).toBeGreaterThanOrEqual(10);
	});

	it("every export is used by production code (or is documented test visibility)", () => {
		const orphans: string[] = [];
		for (const name of exports) {
			if (TEST_VISIBILITY_ALLOWLIST.has(name)) continue;
			const usedExternally = otherSources.some(src => new RegExp(`\\b${name}\\b`).test(src));
			// Internal use: any reference beyond the export/declaration lines.
			const internalRefs = [...shimmerSource.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
			const declRefs = [
				...shimmerSource.matchAll(new RegExp(`export (?:const|function|type|interface|class) ${name}\\b`, "g")),
			].length;
			const usedInternally = internalRefs > declRefs + (shimmerSource.includes(`@link ${name}`) ? 1 : 0);
			if (!usedExternally && !usedInternally) orphans.push(name);
		}
		expect(orphans).toEqual([]);
	});

	/**
	 * The regression DS-8 exists for: motionForActivity was exported but its
	 * lookup was duplicated inline in livingIntensity, production-dead with a
	 * same-logic copy. Proven by moving a state onto another state's motion in
	 * the table: a livingIntensity that reads the table follows, one with its own
	 * copy of the mapping does not. The allowlisted exports are driven by
	 * `shimmer-living.test.ts` (getShimmerActivity) and `shimmer-lava.test.ts`
	 * (LAVA_TUNING's period and depth).
	 */
	it("livingIntensity takes each state's motion from ACTIVITY_PROFILES", () => {
		const states = Object.keys(ACTIVITY_PROFILES) as ShimmerActivity[];
		const samples = (state: ShimmerActivity) =>
			[0, 137, 900, 2_400].flatMap(time => [0, 3, 7].map(index => livingIntensity(state, time, 0, index, 12)));
		for (const moved of states) {
			for (const target of states) {
				if (ACTIVITY_PROFILES[moved].motion === ACTIVITY_PROFILES[target].motion) continue;
				const original = ACTIVITY_PROFILES[moved].motion;
				ACTIVITY_PROFILES[moved].motion = ACTIVITY_PROFILES[target].motion;
				try {
					expect(samples(moved), `${moved} on ${target}'s motion`).toEqual(samples(target));
				} finally {
					ACTIVITY_PROFILES[moved].motion = original;
				}
			}
		}
	});
});
