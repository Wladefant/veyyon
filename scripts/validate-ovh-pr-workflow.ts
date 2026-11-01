import { deepStrictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

interface Step {
	run?: string;
	shell?: string;
	name?: string;
	if?: string;
	uses?: string;
	with?: Record<string, string>;
	env?: Record<string, string>;
}

interface Job {
	if?: string;
	"runs-on": string[];
	steps: Step[];
}

interface Workflow {
	on: {
		pull_request?: { types: string[] };
		workflow_dispatch?: { inputs: Record<string, unknown> };
		push?: unknown;
	};
	jobs: Record<string, Job>;
}

let passed = 0;
let failed = 0;
let assertions = 0;

function equal(actual: unknown, expected: unknown): void {
	assertions++;
	deepStrictEqual(actual, expected);
}

function check(name: string, run: () => void): void {
	try {
		run();
		passed++;
		console.log("PASS", name);
	} catch (error) {
		failed++;
		console.error("FAIL", name, error instanceof Error ? error.message : String(error));
	}
}

/**
 * Read workflow configuration only. The expressions use boolean operations,
 * equality, and property access with typed fixtures; this is not a general
 * GitHub Actions emulator. No app module, runner, checkout, or shell is started.
 */
function evaluate(expression: string | undefined, fixture: Record<string, unknown>): unknown {
	if (typeof expression !== "string") throw new Error("Missing workflow expression");
	const body = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
	return runInNewContext(body, fixture, { timeout: 1000 });
}

const repository = "Wladefant/veyyon";
const head = "a".repeat(40);
const base = "b".repeat(40);
const mergeCommit = "c".repeat(40);
const workflowCommit = "d".repeat(40);

function context({
	event = "pull_request",
	draft = false,
	fork = false,
	admission = "verified",
	typecheck = false,
	target = "",
	pinnedBase = "",
	prepared = "success",
	focusedTests = "",
	workflowChanged = "true",
	installed = "success",
}: {
	event?: string;
	draft?: boolean;
	fork?: boolean;
	admission?: string;
	typecheck?: boolean;
	target?: string;
	pinnedBase?: string;
	prepared?: string;
	focusedTests?: string;
	workflowChanged?: string;
	installed?: string;
} = {}): Record<string, unknown> {
	return {
		github: {
			repository,
			event_name: event,
			sha: mergeCommit,
			workflow_sha: workflowCommit,
			event:
				event === "pull_request"
					? {
							pull_request: {
								draft,
								head: { sha: head, repo: { full_name: fork ? "fork/veyyon" : repository } },
								base: { sha: base },
							},
						}
					: {},
		},
		inputs:
			event === "workflow_dispatch"
				? { typecheck, target_sha: target, base_sha: pinnedBase, test_files: focusedTests }
				: {},
		vars: admission ? { OVH_CI_PR_ADMISSION: admission } : {},
		needs: { prepare: { result: prepared } },
		steps: {
			changed: { outputs: { workflow_changed: workflowChanged } },
			install: { outcome: installed },
		},
	};
}

function validate(workflow: Workflow): void {
	function eligibleJobs(fixture: Record<string, unknown>): string[] {
		return Object.entries(workflow.jobs)
			.filter(([, job]) => Boolean(evaluate(job.if, fixture)))
			.map(([name]) => name);
	}

	check("ready/open/update/reopen subscriptions without duplicate push trigger", () => {
		equal(workflow.on.pull_request?.types.slice().sort(), [
			"opened",
			"ready_for_review",
			"reopened",
			"synchronize",
		]);
		equal(workflow.on.push, undefined);
		equal(typeof workflow.on.workflow_dispatch?.inputs, "object");
	});

	check("draft allocates no job even after admission is activated", () => {
		equal(eligibleJobs(context({ draft: true })), []);
	});

	for (const admission of ["", "pending", "false"]) {
		check("automatic admission fails closed: " + (admission || "(unset)"), () => {
			equal(eligibleJobs(context({ admission })), []);
		});
	}

	check("admitted ready same-repository PR runs related-test path", () => {
		equal(eligibleJobs(context()), ["prepare", "test"]);
	});

	check("fork PR allocates no job", () => {
		equal(eligibleJobs(context({ fork: true })), []);
	});

	for (const event of ["push", "schedule", "pull_request_target"]) {
		check("unexpected event allocates no job: " + event, () => {
			equal(eligibleJobs(context({ event })), []);
		});
	}

	for (const prepared of ["failure", "cancelled", "skipped"]) {
		check("shards cannot start after preparation is " + prepared, () => {
			equal(evaluate(workflow.jobs.test!.if, context({ prepared })), false);
		});
	}

	check("controlled manual tests remain available while automatic admission is closed", () => {
		equal(eligibleJobs(context({ event: "workflow_dispatch", admission: "" })), ["prepare", "test"]);
	});

	check("full workspace typecheck remains an explicit manual-only choice", () => {
		equal(eligibleJobs(context({ event: "workflow_dispatch", admission: "", typecheck: true })), ["typecheck"]);
	});

	check("every job keeps the fixed Veyyon runner boundary", () => {
		for (const job of Object.values(workflow.jobs)) {
			equal(job["runs-on"], ["self-hosted", "Linux", "X64", "veyyon"]);
		}
	});

	for (const [name, fixture, expected] of [
		["automatic PR", context(), head],
		["manual exact source", context({ event: "workflow_dispatch", target: head }), head],
		["manual workflow source", context({ event: "workflow_dispatch" }), mergeCommit],
	] as const) {
		check("checkout and identity assertion use exact " + name + " commit in every job", () => {
			for (const job of Object.values(workflow.jobs)) {
				const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
				const identity = job.steps.find(step => step.name === "Record checkout identity");
				equal(evaluate(checkout?.with?.ref, fixture), expected);
				equal(evaluate(identity?.env?.EXPECTED_SHA, fixture), expected);
			}
		});
	}

	check("all cleanup jobs execute the workflow-pinned reaper for an older checked-out SHA", () => {
		for (const job of Object.values(workflow.jobs)) {
			const cleanup = job.steps.find(step => step.name === "Clean orphaned processes");
			equal(cleanup?.shell, "bash");
			equal(cleanup?.if, "always()");
			equal(evaluate(cleanup?.env?.WORKFLOW_SHA,
				context({ event: "workflow_dispatch", target: head })), workflowCommit);
			if (typeof cleanup?.run !== "string") throw new Error("Cleanup command missing");
			const sandbox = mkdtempSync(join(tmpdir(), "veyyon-ovh-reaper-"));
			try {
				const bin = join(sandbox, "bin");
				mkdirSync(bin);
				const git = join(bin, "git");
				writeFileSync(git, [
					"#!/bin/sh",
					'if [ "$1" = "cat-file" ] && [ "$2" = "-e" ]; then',
					'  printf "cat:%s\\n" "$3" >> "$RUNNER_TEMP/trace"',
					'  [ "$TEST_MISSING_WORKFLOW_COMMIT" != "1" ] || exit 88',
					"  exit 0",
					"fi",
					'if [ "$1" = "show" ]; then',
					'  printf "show:%s\\n" "$2" >> "$RUNNER_TEMP/trace"',
					'  printf \'echo "executed:$1" >> "$RUNNER_TEMP/trace"\\n\'',
					"  exit 0",
					"fi",
					"exit 89",
				].join("\n") + "\n");
				chmodSync(git, 0o755);
				const env = {
					...process.env,
					PATH: bin + ":" + process.env.PATH,
					RUNNER_TEMP: sandbox,
					WORKFLOW_SHA: workflowCommit,
				};
				const run = spawnSync("bash", ["-c", cleanup.run], {
					cwd: sandbox, env, encoding: "utf8", timeout: 10_000,
				});
				equal(run.status, 0);
				equal(readFileSync(join(sandbox, "trace"), "utf8").trim().split("\n"), [
					"cat:" + workflowCommit + "^{commit}",
					"show:" + workflowCommit + ":scripts/ovh-process-group.sh",
					"executed:--cleanup",
				]);
				writeFileSync(join(sandbox, "trace"), "");
				const missing = spawnSync("bash", ["-c", cleanup.run], {
					cwd: sandbox, env: { ...env, TEST_MISSING_WORKFLOW_COMMIT: "1" },
					encoding: "utf8", timeout: 10_000,
				});
				equal(missing.status === 0, false);
				equal(readFileSync(join(sandbox, "trace"), "utf8").trim(),
					"cat:" + workflowCommit + "^{commit}");
			} finally {
				rmSync(sandbox, { recursive: true, force: true });
			}
		}
	});

	check("selection uses the PR event base or explicitly pinned manual base", () => {
		const selection = workflow.jobs.prepare!.steps.find(step => step.name === "Detect changed paths");
		equal(evaluate(selection?.env?.PINNED_BASE, context()), base);
		equal(evaluate(selection?.env?.PINNED_BASE, context({ event: "workflow_dispatch", pinnedBase: base })), base);
	});

	for (const [name, fixture, expected] of [
		["changed workflow", context(), true],
		["unrelated change", context({ workflowChanged: "false" }), false],
		["failed install", context({ installed: "failure" }), false],
		["explicit focused tests", context({ event: "workflow_dispatch", focusedTests: '["scripts/example.test.ts"]' }), false],
	] as const) {
		check("configuration validator respects scope: " + name, () => {
			const step = workflow.jobs.prepare!.steps.find(candidate => candidate.name === "Validate OVH pull-request workflow");
			equal(evaluate(step?.if, fixture), expected);
		});
	}
}

// An optional YAML path supports an old-workflow negative control without
// modifying the checked-out source. The default always reads this repository's
// actual workflow. Parsing/shape errors are failures, never empty success.
try {
	if (process.argv.length > 3) throw new Error("Usage: bun scripts/validate-ovh-pr-workflow.ts [workflow.yml]");
	const source = process.argv[2] ?? new URL("../.github/workflows/ovh-ci.yml", import.meta.url);
	const workflow = Bun.YAML.parse(readFileSync(source, "utf8")) as Workflow;
	validate(workflow);
} catch (error) {
	failed++;
	console.error("FAIL workflow input", error instanceof Error ? error.message : String(error));
}

console.log(
	"OVH_WORKFLOW_VALIDATION cases=" + (passed + failed) +
		" pass=" + passed + " fail=" + failed + " assertions=" + assertions,
);
process.exitCode = failed === 0 && passed > 0 && assertions > 0 ? 0 : 1;
