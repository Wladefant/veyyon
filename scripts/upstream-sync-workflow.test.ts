import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/upstream-sync.yml").text()) as {
	concurrency?: { group: string; "cancel-in-progress": boolean };
	jobs: Record<string, { "runs-on": string[]; if: string; steps: { run?: string }[] }>;
};
const job = workflow.jobs["check-and-open-sync-pr"];

test("upstream sync is admitted only on the trusted OVH pool from main", () => {
	expect(job["runs-on"]).toEqual(["self-hosted", "Linux", "X64", "ovh", "veyyon"]);
	expect(job.if).toContain("github.ref == 'refs/heads/main'");
	expect(job.if).toContain("github.repository == 'Wladefant/veyyon'");
});

test("scheduled and manual upstream sync runs share a non-cancelling workflow lock", () => {
	expect(workflow.concurrency).toEqual({ group: "upstream-sync", "cancel-in-progress": false });
});

test.skipIf(process.platform === "win32")("drift pushes only the upstream-tip candidate and opens a draft into unchanged main", async () => {
	const root = mkdtempSync(join(tmpdir(), "upstream-sync-"));
	try {
		const origin = join(root, "origin");
		const upstream = join(root, "upstream");
		const workspace = join(root, "workspace");
		const env = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		};
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
		git(root, "init", "--initial-branch=main", upstream);
		git(upstream, "commit", "--allow-empty", "-m", "common base");
		const base = git(upstream, "rev-parse", "HEAD");
		git(root, "clone", "--bare", upstream, origin);
		git(root, "clone", origin, workspace);
		git(upstream, "commit", "--allow-empty", "-m", "new upstream commit");
		const tip = git(upstream, "rev-parse", "HEAD");
		// A reused checkout may still have a branch from an interrupted attempt.
		writeFileSync(join(root, "date"), "#!/bin/sh\nprintf '2026-11-28\\n'\n", { mode: 0o755 });
		git(workspace, "branch", "sync/upstream-2026-11-28");
		git(workspace, "config", "remote.origin.push", "HEAD:refs/heads/main");
		writeFileSync(join(root, "gh"), `#!/bin/sh
case "$1 $2" in
  'pr list') exit 0 ;;
  'pr create') printf '%s\\n' "$@" > "$PR_ARGS" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
		const prArgs = join(root, "pr-args");
		const script = job.steps.find(step => step.run)?.run;
		if (!script) throw new Error("Upstream sync has no executable step");
		execFileSync("bash", ["-c", script], {
			cwd: workspace,
			env: {
				...env,
				PATH: `${root}${delimiter}${process.env.PATH}`,
				PR_ARGS: prArgs,
				UPSTREAM_REPO: upstream,
				UPSTREAM_BRANCH: "main",
				TARGET_BRANCH: "main",
				GITHUB_REPOSITORY: "Wladefant/veyyon",
			},
		});
		expect(git(origin, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")).toBe(
			`refs/heads/main ${base}\nrefs/heads/sync/upstream-2026-11-28 ${tip}`,
		);
		const args = (await Bun.file(prArgs).text()).split("\n");
		expect(args).toContain("--draft");
		expect(args[args.indexOf("--base") + 1]).toBe("main");
		expect(args[args.indexOf("--head") + 1]).toBe("sync/upstream-2026-11-28");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
