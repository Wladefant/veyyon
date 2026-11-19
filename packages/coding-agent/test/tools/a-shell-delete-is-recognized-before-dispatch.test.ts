import { describe, expect, it } from "bun:test";
import { findShellDelete, MAX_INTERPRETED_SHELL_DEPTH } from "../../src/tools/shell/bash-guard";

describe("findShellDelete", () => {
	describe("single-file deletes", () => {
		const singleCases = [
			"rm synthetic-file.txt",
			"rm -f synthetic-lock.json",
			'rm "dir with spaces/synthetic file.txt"',
			"RM -F synthetic-upper.txt",
			"rm -- --help",
			"/bin/rm synthetic-bin.txt",
			"unlink synthetic-link.txt",
			"UNLINK 'synthetic quoted.txt'",
			"Remove-Item synthetic-ps.txt",
			"remove-item -Force -LiteralPath 'C:\\synthetic\\my file.txt'",
			"ri synthetic-alias.txt",
			"RI -Path:synthetic-inline.txt",
			"del synthetic-win.txt",
			"erase /q /f synthetic-erase.txt",
			"cmd /c del synthetic-tail.txt",
			"cmd.exe /d /c call erase synthetic-call.txt",
			'cmd /c "del \\"synthetic quoted.txt\\""',
			'powershell -NoProfile -Command "Remove-Item synthetic-ps-wrap.txt"',
			"pwsh.exe -c ri synthetic-pwsh-tail.txt",
			'bash -c "rm synthetic-subshell.txt"',
			"sh -lc 'unlink synthetic-sh.txt'",
			'eval "rm synthetic-eval.txt"',
			"yes | rm -i synthetic-piped.txt",
			"env FOO=1 rm synthetic-env.txt",
			"git clean -f -- synthetic-untracked.txt",
		];

		for (const command of singleCases) {
			it(`classifies as single: ${command}`, () => {
				expect(findShellDelete(command, {})).toBe("single");
			});
		}
	});

	describe("recursive and directory/delete-all forms", () => {
		const recursiveCases = [
			"rm -rf synthetic-dir",
			"rm -R synthetic-dir/",
			"rm --recursive synthetic-dir",
			"rm -d synthetic-empty-dir",
			"RM -RF 'synthetic dir with spaces'",
			"rmdir synthetic-dir",
			"RMDIR -p synthetic/nested/dir",
			"rd /s /q synthetic-dir",
			"Remove-Item -Recurse -Force synthetic-dir",
			"REMOVE-ITEM -r synthetic-dir",
			"ri -Recurse synthetic-dir",
			"Remove-Item 'synthetic-dir/*'",
			"del /s /q synthetic-dir",
			"erase //s synthetic-dir",
			"del *.*",
			"cmd /c rd /s /q synthetic-dir",
			"CMD.EXE /D /C DEL /S /Q synthetic-dir",
			'cmd /c "rmdir /s /q synthetic-dir"',
			'powershell -NoProfile -Command "& { Remove-Item -Recurse synthetic-dir }"',
			"pwsh -Command Remove-Item -Recurse synthetic-dir",
			"bash -c 'cmd /c \"rd /s /q synthetic-dir\"'",
			"if true; then rm -rf synthetic-dir; fi",
			"for item in a b; do rmdir \"$item\"; done",
			"echo y | Remove-Item -Recurse synthetic-dir",
			"git clean -fd",
			"git clean -fdx",
			"git clean -f",
			"git -C synthetic-repo clean -fd",
			"git worktree remove synthetic-wt",
			"git worktree remove --force synthetic-wt",
		];

		for (const command of recursiveCases) {
			it(`classifies as recursive: ${command}`, () => {
				expect(findShellDelete(command, {})).toBe("recursive");
			});
		}
	});

	describe("recursive precedence across segments", () => {
		it("returns recursive when single precedes recursive", () => {
			expect(findShellDelete("rm synthetic.txt && rm -rf synthetic-dir", {})).toBe("recursive");
		});

		it("returns recursive when recursive precedes single", () => {
			expect(findShellDelete("cmd /c rd /s /q synthetic-dir; unlink synthetic.txt", {})).toBe("recursive");
		});

		it("returns single when paired with non-delete segments", () => {
			expect(findShellDelete("echo starting && rm synthetic.txt | tee synthetic.log", {})).toBe("single");
		});
	});

	describe("safe reads, dry-runs, and non-delete commands", () => {
		const allowedCases = [
			"echo rm -rf synthetic-dir",
			"echo 'Remove-Item -Recurse synthetic-dir'",
			"printf '%s\\n' 'rm -rf synthetic-dir'",
			'grep "rm -rf" synthetic-notes.txt',
			'rg "Remove-Item" synthetic-src/',
			"cat synthetic-rm-guide.md",
			"head -n 20 synthetic-unlink.log",
			"tail -f synthetic-rmdir.log",
			"ls -la synthetic-rm-dir",
			'find . -name "*rm*"',
			'git log --grep="rm -rf"',
			'git grep "Remove-Item"',
			"git diff -- synthetic-rm.txt",
			"git worktree list",
			"git clean -n",
			"git clean --dry-run",
			"git clean -nd",
			"git clean --help",
			"command -v rm",
			"which rm",
			"where.exe del",
			"Get-Command Remove-Item",
			"Get-Help Remove-Item",
			"rm --help",
			"unlink --version",
			"rmdir /?",
			"Remove-Item -WhatIf synthetic-dir",
			"rm",
			"# rm -rf synthetic-dir\necho ready",
			"docker run --rm alpine rm -rf /tmp/synthetic",
			"sh ./synthetic-script.sh",
			"powershell -File synthetic-script.ps1",
		];

		for (const command of allowedCases) {
			it(`returns undefined for ${command}`, () => {
				expect(findShellDelete(command, {})).toBeUndefined();
			});
		}

		it("stops descending past MAX_INTERPRETED_SHELL_DEPTH", () => {
			let nested = "rm synthetic.txt";
			for (let i = 0; i <= MAX_INTERPRETED_SHELL_DEPTH; i += 1) {
				nested = `sh -c '${nested.replace(/'/g, "'\\''")}'`;
			}
			expect(findShellDelete(nested, {})).toBeUndefined();
		});
	});
});
