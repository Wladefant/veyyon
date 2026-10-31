import { afterEach, beforeEach, vi } from "bun:test";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import * as git from "@veyyon/coding-agent/utils/git";

/**
 * A status-row factory for a suite whose rows render a directory that holds a `.git`.
 *
 * A row in a repository runs `git status`, looks up the default branch and, on any other branch,
 * runs `gh pr view`. Each lookup lands after the render that started it. A suite that left its
 * rows alive and the processes real spawned one `gh` per fixture branch, and the answer landed in
 * the file that ran next: the row read `git.enabled` there before that file had initialised its
 * settings, and the rejection failed an unrelated test.
 *
 * `useStatusRowsInARepo` registers `beforeEach` and `afterEach` at the importing file's module
 * scope. Before each test, `git status` answers null, the default branch is unknown, and `gh`
 * exits 1, which is how a repository with no remote answers. After each test, every row the
 * factory built is disposed and every spy is restored.
 *
 * A row built with `new StatusLineComponent` directly is outside this factory and keeps the real
 * processes.
 *
 * @example
 * const statusRow = useStatusRowsInARepo();
 * // then, in a test:
 * const row = statusRow(makeStatusLineProducer({ cwd: () => repoDir }));
 */
export function useStatusRowsInARepo(): (source: unknown) => StatusLineComponent {
	const rows: StatusLineComponent[] = [];

	beforeEach(() => {
		vi.spyOn(git.status, "summary").mockResolvedValue(null);
		vi.spyOn(git.branch, "default").mockResolvedValue(null);
		vi.spyOn(git.github, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
	});

	afterEach(() => {
		for (const row of rows.splice(0)) row.dispose();
		vi.restoreAllMocks();
	});

	return source => {
		const row = new StatusLineComponent(source);
		rows.push(row);
		return row;
	};
}
