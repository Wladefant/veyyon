// The preloads every `bun test` process the repository starts receives on its command line.
//
// Bun reads bunfig.toml from the cwd only. Suites run with their member directory as cwd, so the
// repository-root preload is invisible from packages/<name>, and a member whose bunfig.toml omits a
// preload runs without it. Relying on the root bunfig alone left every chunk of a real run
// unprotected, which surfaced when the tripwire's own suite wrote its probe files into the real
// config root. Passing the paths explicitly makes the set independent of the cwd.
//
// This module has no side effects, so the suite runner (`ci-test-ts.ts`) and the leak tracer
// (`test-sandbox/find-test-leaks.ts`) both import it without importing each other.

import * as path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..");

/** Refuses any write that reaches the real veyyon config root. */
const TRIPWIRE_PRELOAD = path.join(repoRoot, "packages", "utils", "test", "helpers", "real-data-tripwire.ts");

/**
 * The second tripwire: a suite that replaces a provider module process-wide and never restores it
 * answers every later file in the same bucket, so the failure lands on an innocent suite. It fails
 * the test that ends with an override it did not inherit, and puts the inherited value back so one
 * leak is one failure.
 */
const PROVIDER_OVERRIDE_PRELOAD = path.join(
	repoRoot,
	"packages",
	"ai",
	"test",
	"helpers",
	"provider-override-tripwire.ts",
);

/** Absolute `--preload` arguments; bun resolves a bare relative preload as a package specifier. */
export const testPreloadArgs: readonly string[] = [
	"--preload",
	TRIPWIRE_PRELOAD,
	"--preload",
	PROVIDER_OVERRIDE_PRELOAD,
];
