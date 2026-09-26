/**
 * WHY: the v1.5.1 bump refreshed `Cargo.lock` with `cargo generate-lockfile`,
 * which re-resolves every dependency to its newest compatible release. It moved
 * `find-msvc-tools` from 0.1.12 to 0.1.13, whose `FILE_ATTRIBUTE_TEMPORARY` is
 * an `i32` that `cc` 1.2.67 cannot pass on Windows, and the tag's Windows
 * installer job failed to compile. A version bump is reviewed as a version
 * bump, so nothing in it may change a dependency.
 *
 * THE CLASS: any third-party lock entry a release refresh changes, whether a
 * version, a re-published checksum, a git revision, or an entry added or
 * dropped. `thirdPartyLockDrift` is what `prepareReleaseTree` checks after
 * `cargo update --workspace`, and it fails the cut on any line it returns.
 *
 * WHAT THIS DOES NOT CATCH: whether `cargo update --workspace` itself leaves
 * third-party entries alone. The drift check runs on its real output at cut
 * time, so a cargo that did move them fails the release rather than this
 * suite; `bun.lock` drift from `bun install` is not covered here.
 */
import { describe, expect, it } from "bun:test";
import { thirdPartyLockDrift } from "./release";

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";

function lock(entries: string[]): string {
	return ["version = 4", "", ...entries].join("\n");
}

const workspace = (version: string) => `[[package]]\nname = "veyyon-natives"\nversion = "${version}"\n`;
const registry = (name: string, version: string, checksum: string) =>
	`[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${REGISTRY}"\nchecksum = "${checksum}"\n`;
const git = (name: string, rev: string) =>
	`[[package]]\nname = "${name}"\nversion = "0.1.0"\nsource = "git+https://example.com/${name}.git#${rev}"\n`;

describe("a release bump moves no third-party lock entry", () => {
	it("accepts a refresh that moves only workspace members", () => {
		const before = lock([workspace("1.5.0"), registry("cc", "1.2.67", "aa"), git("fork", "111")]);
		const after = lock([workspace("1.5.1"), registry("cc", "1.2.67", "aa"), git("fork", "111")]);

		expect(thirdPartyLockDrift(before, after)).toEqual([]);
	});

	it("reports a registry dependency that moved to a newer release", () => {
		const before = lock([workspace("1.5.0"), registry("find-msvc-tools", "0.1.12", "3e")]);
		const after = lock([workspace("1.5.1"), registry("find-msvc-tools", "0.1.13", "ef")]);

		expect(thirdPartyLockDrift(before, after)).toEqual([
			`removed find-msvc-tools 0.1.12 (${REGISTRY}) 3e`,
			`added find-msvc-tools 0.1.13 (${REGISTRY}) ef`,
		]);
	});

	it("reports a version whose checksum changed", () => {
		const before = lock([registry("cc", "1.2.67", "aa")]);
		const after = lock([registry("cc", "1.2.67", "bb")]);

		expect(thirdPartyLockDrift(before, after)).toEqual([
			`removed cc 1.2.67 (${REGISTRY}) aa`,
			`added cc 1.2.67 (${REGISTRY}) bb`,
		]);
	});

	it("reports a git dependency that moved to another revision", () => {
		const before = lock([git("fork", "111")]);
		const after = lock([git("fork", "222")]);

		expect(thirdPartyLockDrift(before, after)).toEqual([
			"removed fork 0.1.0 (git+https://example.com/fork.git#111)",
			"added fork 0.1.0 (git+https://example.com/fork.git#222)",
		]);
	});

	it("reports a dependency the refresh added or dropped", () => {
		const before = lock([registry("cc", "1.2.67", "aa"), registry("shlex", "2.0.1", "cc")]);
		const after = lock([registry("cc", "1.2.67", "aa"), registry("jobserver", "0.1.35", "dd")]);

		expect(thirdPartyLockDrift(before, after)).toEqual([
			`removed shlex 2.0.1 (${REGISTRY}) cc`,
			`added jobserver 0.1.35 (${REGISTRY}) dd`,
		]);
	});

	it("rejects a lockfile with no package entries instead of reporting no drift", () => {
		expect(() => thirdPartyLockDrift("version = 4\n", lock([registry("cc", "1.2.67", "aa")]))).toThrow(
			"Cargo.lock must contain package entries.",
		);
	});
});
