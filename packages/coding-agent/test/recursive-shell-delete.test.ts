import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APPROVAL_MODE_VALUES, resolveApproval } from "../src/tools/core/approval";
import { BashTool, bashApprovalDecision } from "../src/tools/shell/bash";
import { LaunchTool } from "../src/tools/shell/launch";
import { useTempDirs } from "./helpers/temp-dirs";
import { makeToolSession } from "./helpers/tool-session";

const tempDir = useTempDirs();
const denial = /Recursive shell deletion is blocked/;
const bash = { name: "bash", approval: bashApprovalDecision };

function approval(command: string) {
	return resolveApproval(bash, { command }, "yolo", { bash: "allow" }, { bypassAllApprovals: true });
}

describe("direct recursive shell deletes", () => {
	it.each([
		"rm -rf ./scratch",
		"rm --recursive -- ./scratch ../fixtures",
		"rm -R ./scratch/*",
		"echo preparing && (command /bin/rm -r ../fixtures) > report.log",
		"find ./fixtures -type f -delete",
		`bash -lc 'rm -rf "./fixture tree"'`,
		String.raw`powershell.exe -NoProfile -Command 'Remove-Item -LiteralPath "C:\fixture tree" -Recurse -Force'`,
		`pwsh -Command Get-ChildItem ./fixtures | Remove-Item -Recur`,
		`pwsh -Command 'RI ./fixtures/* -Recurse'`,
		`pwsh -Command 'Remove-Item ./fixtures -Recurse:$true'`,
		`cmd.exe /d /c 'RD /S /Q "C:\\fixture tree"'`,
		"cmd /c rmdir /s /q ./fixtures",
	])("blocks %s before approval", command => {
		expect(approval(command)).toMatchObject({ policy: "deny", reason: expect.stringMatching(denial) });
	});

	it.each([
		"git status --short",
		"rm -f ./scratch/fixture.txt",
		"rm -- -rf",
		"mkdir -p ./scratch && rmdir ./scratch",
		"find ./fixtures -name example",
		`printf '%s\\n' 'rm -rf ./fixtures'`,
		"echo rm -rf ./fixtures",
		`pwsh -Command 'Get-ChildItem ./fixtures -Recurse'`,
		`pwsh -Command 'Remove-Item ./fixture.txt -Recurse:$false'`,
		"cmd /c echo rd /s /q ./fixtures",
		"docker run --rm alpine rm -rf /scratch",
	])("leaves %s on the normal approval path", command => {
		expect(approval(command).policy).toBe("allow");
	});

	it("does not let any approval mode override the deny", () => {
		for (const mode of APPROVAL_MODE_VALUES) {
			const result = resolveApproval(
				bash,
				{ command: "rm -rf ./fixtures" },
				mode,
				{ bash: "allow" },
				{ bypassAllApprovals: true },
			);
			expect(result.policy).toBe("deny");
		}
	});

	it("refuses the PowerShell form at execution, before a terminal or broker can start", async () => {
		const cwd = tempDir("recursive-shell-delete-");
		const victim = join(cwd, "synthetic victim");
		const control = join(cwd, "control.txt");
		await mkdir(victim);
		const victimFile = join(victim, "keep.txt");
		await writeFile(victimFile, "victim fixture");
		await writeFile(control, "control fixture");
		const script = `Remove-Item -LiteralPath './synthetic victim' -Recurse -Force`;
		const session = makeToolSession({
			cwd,
			getSessionId: () => {
				throw new Error("execution reached process admission");
			},
		});
		const launchTool = new LaunchTool(session);
		const bashTool = new BashTool(session);
		const start = {
			op: "start" as const,
			name: "delete-fixture",
			application: "powershell.exe",
			args: ["-NoProfile", "-Command", script],
		};
		const outcomes = await Promise.allSettled([
			bashTool.execute("test-bash", { command: `powershell.exe -NoProfile -Command "${script}"` }),
			launchTool.execute("test-start", start),
		]);
		for (const outcome of outcomes) {
			expect(outcome).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(denial) } });
		}
		expect(launchTool.approval(start)).toMatchObject({ deny: true, reason: expect.stringMatching(denial) });
		expect(await readFile(victimFile, "utf8")).toBe("victim fixture");
		expect(await readFile(control, "utf8")).toBe("control fixture");
	});

	it("does not interpret launch input as shell source", async () => {
		const tool = new LaunchTool(
			makeToolSession({
				getSessionId: () => {
					throw new Error("input reached process admission");
				},
			}),
		);
		const send = { op: "send", name: "editor", text: "rm -rf ./fixture", enter: false } as const;
		expect(tool.approval(send)).toBe("exec");
		await expect(tool.execute("test-literal-send", send)).rejects.toThrow("input reached process admission");
	});
});
