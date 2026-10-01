/**
 * Locks the shape of the Rust gate commands (scripts/run-rs-task.ts).
 *
 * The gate decides what CI and the pre-push hook actually compile, and a flag missing from one of
 * these argv lists is invisible: the command still succeeds, it just checks less. That happened.
 * `cargo clippy --workspace` builds libs and bins only, so nineteen `ScopeIo` literals across the
 * vendored uutils sat un-compilable after the struct gained a field while `lint:rs` and `check:rs`
 * both reported green; the break only surfaced in `test:rs`, as a build error rather than a lint one.
 * These assert the argv lists directly, because that is the whole interface: what a task runs.
 */

import { describe, expect, it } from "bun:test";
import { RUST_TASK_COMMANDS } from "./run-rs-task";

describe("Rust gate commands", () => {
	it("declares exactly the five tasks package.json calls", () => {
		expect(Object.keys(RUST_TASK_COMMANDS).sort()).toEqual(["check:rs", "fix:rs", "fmt:rs", "lint:rs", "test:rs"]);
	});

	it("passes --all-targets to every clippy run, so tests and benches are compiled too", () => {
		const clippyRuns = Object.entries(RUST_TASK_COMMANDS).flatMap(([task, commands]) =>
			commands.filter(command => command[1] === "clippy").map(command => [task, command] as const),
		);
		// check:rs and lint:rs also run the two out-of-workspace shell crates; fix:rs only the workspace.
		expect(clippyRuns.map(([task]) => task)).toEqual([
			"check:rs",
			"check:rs",
			"check:rs",
			"fix:rs",
			"lint:rs",
			"lint:rs",
			"lint:rs",
		]);
		for (const [, command] of clippyRuns) {
			expect(command).toContain("--all-targets");
		}
	});

	it("runs the workspace linting with -D warnings, so a warning is a failure and not a note", () => {
		const workspaceRun = ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"];
		expect(RUST_TASK_COMMANDS["lint:rs"][0]).toEqual(workspaceRun);
		expect(RUST_TASK_COMMANDS["check:rs"][1]).toEqual(workspaceRun);
	});

	it("lints the in-process shell crates the workspace excludes for the exit ban, in both gates", () => {
		// brush-core and brush-builtins are not workspace members, so `--workspace` never reaches them, yet
		// they are the shell that runs inside the host (issue #73). The lane denies only disallowed_methods.
		for (const task of ["check:rs", "lint:rs"] as const) {
			const manifests = RUST_TASK_COMMANDS[task]
				.filter(command => command.includes("--manifest-path"))
				.map(command => command[command.indexOf("--manifest-path") + 1]);
			expect(manifests).toEqual([
				"natives/vendor/brush-core/Cargo.toml",
				"natives/vendor/brush-builtins/Cargo.toml",
			]);
			for (const command of RUST_TASK_COMMANDS[task].filter(entry => entry.includes("--manifest-path"))) {
				expect(command.slice(command.indexOf("--") + 1).join(" ")).toContain("-D clippy::disallowed_methods");
			}
		}
	});

	it("checks formatting before linting in check:rs, so a format diff is not reported as lint noise", () => {
		expect(RUST_TASK_COMMANDS["check:rs"][0]).toEqual(["cargo", "fmt", "--all", "--", "--check"]);
	});

	it("runs the whole workspace under nextest and reports only failures", () => {
		expect(RUST_TASK_COMMANDS["test:rs"]).toEqual([
			["cargo", "nextest", "run", "--workspace", "--status-level=fail", "--final-status-level=fail"],
		]);
	});

	it("never mutates the tree from a checking task", () => {
		// `fix:rs` and `fmt:rs` write; the three gates must not, or a green CI run could be green
		// because it edited the code it was judging.
		for (const task of ["check:rs", "lint:rs", "test:rs"] as const) {
			for (const command of RUST_TASK_COMMANDS[task]) {
				expect(command).not.toContain("--fix");
			}
		}
	});
});
