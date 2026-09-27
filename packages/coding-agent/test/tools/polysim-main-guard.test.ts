import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { resolveApproval } from "@veyyon/coding-agent/tools/core/approval";
import {
	POLYSIM_MAIN_DENIAL_MESSAGE,
	checkGithubToolPolysimMainDenial,
	checkPolysimMainDenial,
	isMainRefspec,
	isPolysimulatorRemoteUrl,
	isPolysimulatorRepo,
} from "@veyyon/coding-agent/tools/core/polysim-main-guard";
import { BashTool, bashApprovalDecision } from "@veyyon/coding-agent/tools/shell/bash";
import { GithubTool } from "@veyyon/coding-agent/tools/web/gh";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

const POLYSIM_REMOTES = {
	origin: "git@github.com:Bavariance/polysimulator.git",
};

const UNRELATED_REMOTES = {
	origin: "git@github.com:Wladefant/veyyon.git",
};

const mockPolysimOptions = (overrides?: {
	branch?: string | undefined;
	prBase?: string;
	remotes?: Record<string, string>;
}) => ({
	getRemotes: () => overrides?.remotes ?? POLYSIM_REMOTES,
	getCurrentBranch: () => (overrides && Object.prototype.hasOwnProperty.call(overrides, "branch") ? overrides.branch : "feature-test"),
	resolvePrBase: () => overrides?.prBase,
});

function createMockSession(cwd: string) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "polysim-guard-test",
		allocateOutputArtifact: async () => ({ id: "out-1", path: "/tmp/out-1.txt" }),
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

describe("Polysimulator main guard", () => {
	describe("Helper predicate utilities", () => {
		it("detects Polysimulator repo slugs and URLs", () => {
			expect(isPolysimulatorRepo("Bavariance/polysimulator")).toBe(true);
			expect(isPolysimulatorRepo("bavariance/polysimulator.git")).toBe(true);
			expect(isPolysimulatorRepo("https://github.com/Bavariance/polysimulator")).toBe(true);
			expect(isPolysimulatorRepo("Wladefant/veyyon")).toBe(false);

			expect(isPolysimulatorRemoteUrl("git@github.com:Bavariance/polysimulator.git")).toBe(true);
			expect(isPolysimulatorRemoteUrl("https://github.com/Bavariance/polysimulator.git")).toBe(true);
			expect(isPolysimulatorRemoteUrl("https://github.com/Wladefant/veyyon.git")).toBe(false);
		});

		it("detects main refspecs", () => {
			expect(isMainRefspec("main")).toBe(true);
			expect(isMainRefspec("refs/heads/main")).toBe(true);
			expect(isMainRefspec("+main")).toBe(true);
			expect(isMainRefspec("HEAD:main")).toBe(true);
			expect(isMainRefspec("+HEAD:main")).toBe(true);
			expect(isMainRefspec("feat:main")).toBe(true);
			expect(isMainRefspec("feat:refs/heads/main")).toBe(true);
			expect(isMainRefspec(":main")).toBe(true);

			expect(isMainRefspec("staging")).toBe(false);
			expect(isMainRefspec("HEAD:staging")).toBe(false);
			expect(isMainRefspec("+feat/my-branch")).toBe(false);
		});
	});

	describe("Form 1: git push to main in Polysimulator", () => {
		const testDir = os.tmpdir();

		it("denies explicit push to main", () => {
			const commands = [
				"git push origin main",
				"git push origin HEAD:main",
				"git push origin refs/heads/main",
				"git push origin +main",
				"git push origin +HEAD:main",
				"git push origin :main",
				"git push origin --force main",
				"git push -u origin main",
				"git push origin +refs/heads/main:refs/heads/main",
				"git push origin feat:main",
				"git push origin feat:refs/heads/main",
				"git push origin --all",
				"git push origin --mirror",
				"git push git@github.com:Bavariance/polysimulator.git main",
				"git push https://github.com/Bavariance/polysimulator.git HEAD:main",
			];

			for (const cmd of commands) {
				const denial = checkPolysimMainDenial(cmd, testDir, undefined, mockPolysimOptions());
				expect(denial).toBeDefined();
				expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
			}
		});

		it("denies bare git push when current branch is main", () => {
			const denial = checkPolysimMainDenial(
				"git push",
				testDir,
				undefined,
				mockPolysimOptions({ branch: "main" }),
			);
			expect(denial).toBeDefined();
			expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("denies bare git push when current branch is unknown (fail-closed)", () => {
			const denial = checkPolysimMainDenial(
				"git push origin",
				testDir,
				undefined,
				mockPolysimOptions({ branch: undefined }),
			);
			expect(denial).toBeDefined();
			expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("allows push to staging or feature branches in Polysimulator", () => {
			const allowedCommands = [
				"git push origin staging",
				"git push origin HEAD:staging",
				"git push origin feat/my-feature",
				"git push origin +feat/my-feature",
				"git push origin HEAD:feat/my-feature",
			];

			for (const cmd of allowedCommands) {
				const denial = checkPolysimMainDenial(cmd, testDir, undefined, mockPolysimOptions());
				expect(denial).toBeUndefined();
			}
		});

		it("allows git push origin main in unrelated repositories", () => {
			const denial = checkPolysimMainDenial(
				"git push origin main",
				testDir,
				undefined,
				mockPolysimOptions({ remotes: UNRELATED_REMOTES }),
			);
			expect(denial).toBeUndefined();
		});
	});

	describe("Form 2: gh pr merge targeting main in Polysimulator", () => {
		const testDir = os.tmpdir();

		it("denies gh pr merge when base is main", () => {
			const commands = [
				"gh pr merge 123",
				"gh pr merge 123 --auto",
				"gh pr merge 123 -m",
				"gh pr merge https://github.com/Bavariance/polysimulator/pull/123",
				"gh pr merge 123 --repo Bavariance/polysimulator",
				"gh pr merge 123 -R Bavariance/polysimulator",
			];

			for (const cmd of commands) {
				const denial = checkPolysimMainDenial(
					cmd,
					testDir,
					undefined,
					mockPolysimOptions({ prBase: "main" }),
				);
				expect(denial).toBeDefined();
				expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
			}
		});

		it("denies gh pr merge when base is unknown (fail-closed)", () => {
			const denial = checkPolysimMainDenial(
				"gh pr merge 123",
				testDir,
				undefined,
				mockPolysimOptions({ prBase: undefined }),
			);
			expect(denial).toBeDefined();
			expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("allows gh pr merge when base is staging", () => {
			const denial = checkPolysimMainDenial(
				"gh pr merge 123",
				testDir,
				undefined,
				mockPolysimOptions({ prBase: "staging" }),
			);
			expect(denial).toBeUndefined();
		});

		it("allows gh pr merge in unrelated repository even if base is main", () => {
			const denial = checkPolysimMainDenial(
				"gh pr merge 123",
				testDir,
				undefined,
				mockPolysimOptions({ remotes: UNRELATED_REMOTES, prBase: "main" }),
			);
			expect(denial).toBeUndefined();
		});
	});

	describe("Form 3: gh api mutating calls for Polysimulator", () => {
		const testDir = os.tmpdir();

		it("denies gh api PUT to pulls/<n>/merge", () => {
			const commands = [
				"gh api -X PUT repos/Bavariance/polysimulator/pulls/123/merge",
				"gh api --method PUT repos/Bavariance/polysimulator/pulls/123/merge",
				"gh api -X PUT /repos/Bavariance/polysimulator/pulls/123/merge",
				"gh api repos/Bavariance/polysimulator/pulls/123/merge",
				"gh api -R Bavariance/polysimulator -X PUT pulls/123/merge",
			];

			for (const cmd of commands) {
				const denial = checkPolysimMainDenial(cmd, testDir, undefined, mockPolysimOptions());
				expect(denial).toBeDefined();
				expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
			}
		});

		it("denies gh api PATCH/POST to git/refs/heads/main", () => {
			const commands = [
				"gh api -X PATCH repos/Bavariance/polysimulator/git/refs/heads/main",
				"gh api -X POST repos/Bavariance/polysimulator/git/refs/heads/main",
				"gh api --method=PATCH repos/Bavariance/polysimulator/git/refs/heads/main",
				"gh api -R Bavariance/polysimulator -X PATCH git/refs/heads/main",
			];

			for (const cmd of commands) {
				const denial = checkPolysimMainDenial(cmd, testDir, undefined, mockPolysimOptions());
				expect(denial).toBeDefined();
				expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
			}
		});

		it("allows gh api calls to unrelated repositories", () => {
			const allowed = [
				"gh api -X PUT repos/Wladefant/veyyon/pulls/123/merge",
				"gh api -X PATCH repos/Wladefant/veyyon/git/refs/heads/main",
			];

			for (const cmd of allowed) {
				const denial = checkPolysimMainDenial(
					cmd,
					testDir,
					undefined,
					mockPolysimOptions({ remotes: UNRELATED_REMOTES }),
				);
				expect(denial).toBeUndefined();
			}
		});
	});

	describe("Form 4: github tool op check", () => {
		const testDir = os.tmpdir();

		it("denies github tool pr_merge with base main or unresolved base", () => {
			const denialExplicit = checkGithubToolPolysimMainDenial(
				{ op: "pr_merge", repo: "Bavariance/polysimulator", base: "main" },
				testDir,
				mockPolysimOptions(),
			);
			expect(denialExplicit).toBeDefined();
			expect(denialExplicit?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);

			const denialUnresolved = checkGithubToolPolysimMainDenial(
				{ op: "pr_merge", repo: "Bavariance/polysimulator", pr: "123" },
				testDir,
				mockPolysimOptions({ prBase: undefined }),
			);
			expect(denialUnresolved).toBeDefined();
			expect(denialUnresolved?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("denies github tool pr_push to main", () => {
			const denial = checkGithubToolPolysimMainDenial(
				{ op: "pr_push", repo: "Bavariance/polysimulator", branch: "main" },
				testDir,
				mockPolysimOptions(),
			);
			expect(denial).toBeDefined();
			expect(denial?.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("allows github tool pr_merge with base staging", () => {
			const allowed = checkGithubToolPolysimMainDenial(
				{ op: "pr_merge", repo: "Bavariance/polysimulator", base: "staging" },
				testDir,
				mockPolysimOptions(),
			);
			expect(allowed).toBeUndefined();
		});

		it("allows github tool operations on unrelated repositories", () => {
			const allowed = checkGithubToolPolysimMainDenial(
				{ op: "pr_merge", repo: "Wladefant/veyyon", base: "main" },
				testDir,
				mockPolysimOptions({ remotes: UNRELATED_REMOTES }),
			);
			expect(allowed).toBeUndefined();
		});
	});

	describe("Approval engine integration", () => {
		it("resolves to deny policy even under yolo mode", () => {
			const tool = {
				name: "test-guard",
				approval: () => ({
					tier: "exec" as const,
					deny: true,
					reason: POLYSIM_MAIN_DENIAL_MESSAGE,
				}),
			};

			const decision = resolveApproval(tool, {}, { level: "yolo", userConfig: {} });
			expect(decision.policy).toBe("deny");
			expect(decision.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("resolves to deny policy under allow mode", () => {
			const tool = {
				name: "test-guard",
				approval: () => ({
					tier: "exec" as const,
					deny: true,
					reason: POLYSIM_MAIN_DENIAL_MESSAGE,
				}),
			};

			const decision = resolveApproval(tool, {}, { level: "auto-edit", userConfig: { "test-guard": "allow" } });
			expect(decision.policy).toBe("deny");
			expect(decision.reason).toBe(POLYSIM_MAIN_DENIAL_MESSAGE);
		});
	});
	describe("Tool execute integration", () => {
		const session = createMockSession(os.tmpdir());

		it("BashTool.execute throws hard denial for git push to Polysimulator main", async () => {
			const tool = new BashTool(session as never);
			await expect(
				tool.execute("b1", {
					command: "git push git@github.com:Bavariance/polysimulator.git main",
					timeout: 5,
				}),
			).rejects.toThrow(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("BashTool.execute throws hard denial for gh api PUT pulls/merge to Polysimulator", async () => {
			const tool = new BashTool(session as never);
			await expect(
				tool.execute("b2", {
					command: "gh api -X PUT repos/Bavariance/polysimulator/pulls/42/merge",
					timeout: 5,
				}),
			).rejects.toThrow(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("BashTool.execute throws hard denial for gh api PATCH git/refs/heads/main to Polysimulator", async () => {
			const tool = new BashTool(session as never);
			await expect(
				tool.execute("b3", {
					command: "gh api -X PATCH repos/Bavariance/polysimulator/git/refs/heads/main",
					timeout: 5,
				}),
			).rejects.toThrow(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("bashApprovalDecision returns deny: true for Polysimulator main push", () => {
			const decision = bashApprovalDecision(
				{ command: "git push git@github.com:Bavariance/polysimulator.git main" },
				[],
				os.tmpdir(),
			);
			expect(typeof decision === "object" && "deny" in decision && decision.deny).toBe(true);
			expect(typeof decision === "object" && "reason" in decision && decision.reason).toBe(
				POLYSIM_MAIN_DENIAL_MESSAGE,
			);
		});

		it("GithubTool.execute throws hard denial for pr_merge targeting Polysimulator main", async () => {
			const tool = new GithubTool(session as never);
			await expect(
				tool.execute("g1", {
					op: "pr_merge" as never,
					repo: "Bavariance/polysimulator",
					base: "main",
				}),
			).rejects.toThrow(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("GithubTool.execute throws hard denial for pr_push targeting Polysimulator main", async () => {
			const tool = new GithubTool(session as never);
			await expect(
				tool.execute("g2", {
					op: "pr_push",
					repo: "Bavariance/polysimulator",
					branch: "main",
				}),
			).rejects.toThrow(POLYSIM_MAIN_DENIAL_MESSAGE);
		});

		it("GithubTool.approval returns deny: true for Polysimulator main pr_merge", () => {
			const tool = new GithubTool(session as never);
			const decision = tool.approval({
				op: "pr_merge" as never,
				repo: "Bavariance/polysimulator",
				base: "main",
			});
			expect(typeof decision === "object" && "deny" in decision && decision.deny).toBe(true);
			expect(typeof decision === "object" && "reason" in decision && decision.reason).toBe(
				POLYSIM_MAIN_DENIAL_MESSAGE,
			);
		});
	});
});
