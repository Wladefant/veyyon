import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Literal path keeps this CLI regression in the existing script-test graph ("scripts/ovh-related-tests.mjs").
const selector = resolve(dirname(fileURLToPath(import.meta.url)), "ovh-related-tests.mjs");
const repoRoot = resolve(dirname(selector), "..");

interface SelectorRunOptions {
	cwd?: string;
	extraArgs?: string[];
	execPath?: string;
}

function runSelector(changedFiles: string[], options: SelectorRunOptions = {}): string {
	const cwd = options.cwd ?? repoRoot;
	const extraArgs = options.extraArgs ?? [];
	const changedPath = join(mkdtempSync(join(tmpdir(), "ovh-selector-changed-")), "changed.json");
	try {
		writeFileSync(changedPath, JSON.stringify(changedFiles));
		const executable = options.execPath ?? process.execPath ?? "node";
		return execFileSync(executable, [selector, "--dry-run", "--changed-files", changedPath, ...extraArgs], {
			cwd,
			encoding: "utf8",
			timeout: 120000,
			windowsHide: true,
			env: {
				...process.env,
				NODE_PATH: resolve(repoRoot, "node_modules"),
			},
		});
	} finally {
		rmSync(dirname(changedPath), { recursive: true, force: true });
	}
}

function parseSelectedTests(output: string): string[] {
	const match = output.match(/Selected related tests \((\d+)\):\n([\s\S]*?)(?:\n\(none\))?$/);
	if (!match?.[2]) return [];
	return match[2]
		.split("\n")
		.map(line => line.trim())
		.filter(line => Boolean(line) && line !== "(none)");
}

function createGitFixture(files: Record<string, string>): { fixtureDir: string; cleanup: () => void } {
	const fixtureDir = mkdtempSync(join(tmpdir(), "ovh-selector-fixture-"));
	try {
		for (const [relPath, content] of Object.entries(files)) {
			const fullPath = join(fixtureDir, relPath);
			mkdirSync(dirname(fullPath), { recursive: true });
			writeFileSync(fullPath, content, "utf8");
		}
		const gitOpts = { cwd: fixtureDir, encoding: "utf8" as const, timeout: 30000, windowsHide: true };
		execFileSync("git", ["init"], gitOpts);
		execFileSync("git", ["config", "user.name", "fixture-test"], gitOpts);
		execFileSync("git", ["config", "user.email", "fixture@example.com"], gitOpts);
		execFileSync("git", ["config", "core.autocrlf", "false"], gitOpts);
		execFileSync("git", ["add", "-A"], gitOpts);
		execFileSync("git", ["commit", "-m", "fixture init"], gitOpts);
		return {
			fixtureDir,
			cleanup: () => rmSync(fixtureDir, { recursive: true, force: true }),
		};
	} catch (err) {
		rmSync(fixtureDir, { recursive: true, force: true });
		throw err;
	}
}

describe("OVH related-test selector", () => {
	it("selects nearby tests for coding-agent settings without falling back to the package", () => {
		const changedFile = "packages/coding-agent/src/config/settings.ts";
		const output = runSelector([changedFile]);
		const selectedTests = parseSelectedTests(output);
		const count = selectedTests.length;

		// Reaches full transitive related graph without falling back to owning-package (old fallback selected 3423 tests)
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(3423);
		expect(output).not.toContain("owning-package:");
		expect(output).toContain(": transitive;");
		expect(output).toContain("packages/coding-agent/test/config-hot-reload.test.ts");
		expect(selectedTests).toContain("packages/coding-agent/test/config-hot-reload.test.ts");

		// Changed test retention: explicitly changed test files are retained in selected tests
		const changedTest = "packages/coding-agent/test/config-hot-reload.test.ts";
		const outputWithChangedTest = runSelector([changedFile, changedTest]);
		const selectedWithChangedTest = parseSelectedTests(outputWithChangedTest);
		expect(selectedWithChangedTest).toContain(changedTest);

		// Deterministic repeat selection: identical input produces identical selection
		const repeatOutput = runSelector([changedFile]);
		expect(repeatOutput).toBe(output);
	}, 120000);

	describe("git fixture regressions", () => {
		let fixtureDir: string;
		let cleanupFixture: () => void;

		beforeAll(() => {
			const fixture = createGitFixture({
				"package.json": JSON.stringify({ name: "fixture-root", private: true }),
				"tsconfig.json": JSON.stringify({
					compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
				}),
				"packages/pkg-a/package.json": JSON.stringify({ name: "@fixture/pkg-a", version: "1.0.0", changelog: "CHANGELOG.md" }),
				"packages/pkg-a/src/mod-a.ts": 'export const a = "alpha";\n',
				"packages/pkg-a/src/mod-b.ts": 'console.log("barrel side effect");\nexport const b = "beta";\n',
				"packages/pkg-a/src/types.ts": "export type SharedType = { value: string };\n",
				"packages/pkg-a/src/index.ts":
					'export { a } from "./mod-a.js";\nexport { b } from "./mod-b.js";\nexport type { SharedType } from "./types.js";\n',
				"packages/pkg-a/test/consumer-a.test.ts": 'import { a } from "../src/index.js";\nexport const testA = a;\n',
				"packages/pkg-a/test/direct-a.test.ts": 'import { a } from "../src/mod-a.js";\nexport const directA = a;\n',
				"packages/pkg-a/test/same-pkg-type-consumer.test.ts":
					'import type { SharedType } from "../src/types";\nexport const localVal: SharedType = { value: "pkg-a" };\n',
				"packages/pkg-a/test/unrelated.test.ts": "export const standalone = 123;\n",
				"packages/pkg-b/package.json": JSON.stringify({ name: "@fixture/pkg-b", version: "1.0.0" }),
				"packages/pkg-b/test/foreign-type-consumer.test.ts":
					'import type { SharedType } from "../../pkg-a/src/types.js";\nexport const foreignVal: SharedType = { value: "pkg-b" };\n',
				"packages/pkg-b/test/foreign-barrel-type-consumer.test.ts":
					'import type { SharedType } from "../../pkg-a/src/index.js";\nexport const foreignVal: SharedType = { value: "pkg-b" };\n',
				"packages/pkg-b/test/foreign-barrel-binding-consumer.test.ts":
					'import { SharedType } from "../../pkg-a/src/index.js";\nexport const foreignVal: SharedType = { value: "pkg-b" };\n',
				"CHANGELOG.md": "# root\n",
				"packages/pkg-a/CHANGELOG.md": "# package\n",
				"packages/pkg-a/tsconfig.json": JSON.stringify({ include: ["CHANGELOG.md"] }),
				"scripts/root-changelog-reader.test.ts":
					'import { dirname as getDir } from "node:path";\nimport { join as pathJoin } from "node:path";\nimport { fileURLToPath as toPath } from "node:url";\nconst HERE = getDir(toPath(import.meta.url));\nconst REPO_ROOT = pathJoin(HERE, "..");\nconst ROOT_PATH = pathJoin(REPO_ROOT, "CHANGELOG.md");\nexport const rootChangelog = ROOT_PATH;\n',
				"packages/pkg-a/test/package-changelog-reader.test.ts":
					'import { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst HERE = dirname(fileURLToPath(import.meta.url));\nconst ROOT = join(HERE, "../../..");\nconst PACKAGE_CHANGELOG = join(ROOT, "packages", "pkg-a", "CHANGELOG.md");\nexport const packageChangelog = PACKAGE_CHANGELOG;\n',
				"packages/pkg-a/test/package-metadata-reader.test.ts":
					'import metadata from "../package.json";\nexport const changelogMetadata = metadata.changelog;\n',
				"packages/pkg-a/test/unresolved-prefix.test.ts":
					'import { join } from "node:path";\nconst first = second;\nconst second = first;\nconst runtimeDir = first;\nexport const possibleChangelog = join(runtimeDir, "CHANGELOG.md");\n',
				"packages/pkg-b/test/changelog-unrelated.test.ts": "export const unrelatedChangelog = true;\n",
			});
			fixtureDir = fixture.fixtureDir;
			cleanupFixture = fixture.cleanup;
		});

		afterAll(() => {
			cleanupFixture?.();
		});

		it("retains consumer when importing a value re-exported by a barrel from changed module", () => {
			const output = runSelector(["packages/pkg-a/src/mod-a.ts"], { cwd: fixtureDir });
			const selected = parseSelectedTests(output);
			expect(selected).toContain("packages/pkg-a/test/consumer-a.test.ts");
			expect(selected).toContain("packages/pkg-a/test/direct-a.test.ts");
			expect(selected).not.toContain("packages/pkg-a/test/unrelated.test.ts");
		});

		it("retains consumer importing from barrel when a side-effectful sibling module changes without purity proof", () => {
			const output = runSelector(["packages/pkg-a/src/mod-b.ts"], { cwd: fixtureDir });
			const selected = parseSelectedTests(output);
			expect(selected).toContain("packages/pkg-a/test/consumer-a.test.ts");
			expect(selected).not.toContain("packages/pkg-a/test/direct-a.test.ts");
			expect(selected).not.toContain("packages/pkg-a/test/unrelated.test.ts");
		});

		it("retains type-only imports by default, but excludes them with --typecheck-planned within the owning changed package", () => {
			const outputDefault = runSelector(["packages/pkg-a/src/types.ts"], { cwd: fixtureDir });
			const selectedDefault = parseSelectedTests(outputDefault);
			expect(selectedDefault).toContain("packages/pkg-a/test/same-pkg-type-consumer.test.ts");

			const outputTypecheck = runSelector(["packages/pkg-a/src/types.ts"], {
				cwd: fixtureDir,
				extraArgs: ["--typecheck-planned"],
			});
			const selectedTypecheck = parseSelectedTests(outputTypecheck);
			expect(selectedTypecheck).not.toContain("packages/pkg-a/test/same-pkg-type-consumer.test.ts");
		});

		it("retains type-only imports from foreign packages even when --typecheck-planned is passed", () => {
			const output = runSelector(["packages/pkg-a/src/types.ts"], {
				cwd: fixtureDir,
				extraArgs: ["--typecheck-planned"],
			});
			const selected = parseSelectedTests(output);
			expect(selected).toContain("packages/pkg-b/test/foreign-type-consumer.test.ts");
			expect(selected).toContain("packages/pkg-b/test/foreign-barrel-type-consumer.test.ts");
			expect(selected).toContain("packages/pkg-b/test/foreign-barrel-binding-consumer.test.ts");
		});
		it("resolves whole static path calls without treating manifest metadata as root references", () => {
			const rootSelected = parseSelectedTests(runSelector(["CHANGELOG.md"], { cwd: fixtureDir }));
			expect(rootSelected).toEqual(["scripts/root-changelog-reader.test.ts"]);
			expect(rootSelected).not.toContain("packages/pkg-a/test/package-changelog-reader.test.ts");
			expect(rootSelected).not.toContain("packages/pkg-a/test/package-metadata-reader.test.ts");
			expect(rootSelected).not.toContain("packages/pkg-a/test/unresolved-prefix.test.ts");

			const packageSelected = parseSelectedTests(runSelector(["packages/pkg-a/CHANGELOG.md"], { cwd: fixtureDir }));
			expect(packageSelected).toContain("packages/pkg-a/test/package-changelog-reader.test.ts");
			expect(packageSelected).toContain("packages/pkg-a/test/package-metadata-reader.test.ts");
			expect(packageSelected).not.toContain("scripts/root-changelog-reader.test.ts");
			expect(packageSelected).not.toContain("packages/pkg-b/test/changelog-unrelated.test.ts");
		});
	});
});
