import { describe, expect, it } from "bun:test";
import { APPROVAL_MODE_VALUES, resolveApproval } from "../src/tools/core/approval";
import { bashApprovalDecision } from "../src/tools/shell/bash";
import { findBroadProcessStopDenial } from "../src/tools/shell/bash-guard";

describe("host process stop guard", () => {
	const denied = [
		"taskkill /IM tool.exe",
		"TASKKILL.EXE /F //im tool.exe /T",
		String.raw`'C:\Windows\System32\taskkill.exe' /IM tool.exe`,
		'taskkill /FI "IMAGENAME eq tool.exe"',
		"taskkill /PID 4242 /IM tool.exe",
		"echo preparing && taskkill /IM tool.exe",
		"if true; then command taskkill /IM tool.exe; fi",
		`cmd.exe /d /c 'taskkill /IM "tool name.exe"'`,
		"cmd /c taskkill /IM tool.exe",
		`pwsh -NoProfile -Command 'Stop-Process -Name tool'`,
		"powershell.exe -Command Stop-Process -Name tool",
		"spps -Name:tool",
		"pkill -f tool",
		"killall tool",
		"pkill -- --help",
		`bash -lc 'pkill tool'`,
		`eval 'killall tool'`,
		"taskkill $SELECTOR tool.exe",
	];
	for (const command of denied) {
		it(`denies ${command}`, () => {
			const denial = findBroadProcessStopDenial(command, { SELECTOR: "/IM" }, "/home/agent");
			expect(denial).toContain("verified process ID");
		});
	}

	const allowed = [
		"taskkill /PID 4242 /T /F",
		"taskkill.exe //pid 4242 //t",
		"taskkill /PID 4242 # use /IM only as a negative example",
		"kill -TERM 4242",
		`cmd.exe /c 'taskkill /PID 4242 /T'`,
		"pwsh -Command Stop-Process -Id 4242",
		"pgrep tool",
		"pkill --help",
		"killall -l",
		"echo taskkill /IM tool.exe",
		`printf '%s\n' 'pkill tool'`,
		"command -v pkill",
		"# example; taskkill /IM tool.exe\necho ready",
		"docker run --rm alpine pkill tool",
	];
	for (const command of allowed) {
		it(`does not deny ${command}`, () => {
			expect(findBroadProcessStopDenial(command, {}, "/home/agent")).toBeUndefined();
		});
	}
});

describe("process stop approval", () => {
	const bash = { name: "bash", approval: bashApprovalDecision };

	for (const mode of APPROVAL_MODE_VALUES) {
		it(`denies image-wide commands in ${mode}, even with an explicit allow`, () => {
			for (const image of ["bun.exe", "python.exe"]) {
				const args = { command: `taskkill /F /IM ${image} /T` };
				const result = resolveApproval(bash, args, mode, { bash: "allow" }, { bypassAllApprovals: true });
				expect(result).toMatchObject({
					policy: "deny",
					reason: expect.stringContaining("verified process ID"),
				});
			}
		});
	}

	it("leaves exact-PID cleanup on the normal exec path", () => {
		const args = { command: "taskkill /F /PID 4242 /T" };
		expect(resolveApproval(bash, args, "yolo")).toMatchObject({ tier: "exec", policy: "allow" });
	});
});
