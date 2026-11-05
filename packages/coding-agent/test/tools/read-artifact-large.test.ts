// Subject module: tools/fs/read-artifact.ts, driven through the read tool.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { toolResultText } from "../helpers/tool-result-text";
import { makeWorkspaceToolSession } from "../helpers/tool-session";

function largeArtifactText(): string {
	return Array.from(
		{ length: 400 },
		(_, index) => `line-${String(index + 1).padStart(3, "0")} ${"x".repeat(256)}`,
	).join("\n");
}

describe("read tool large artifact handling", () => {
	let testDir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-large-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(path.join(artifactDir, "0.mcp.log"), largeArtifactText());
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		tool = new ReadTool(makeWorkspaceToolSession(testDir));
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("blocks unbounded raw reads and points to bounded artifact workflows", async () => {
		const result = await tool.execute("call-raw", { path: "artifact://0:raw" });
		const output = toolResultText(result);

		expect(output).toContain("Unbounded raw read blocked for artifact://0");
		expect(output).toContain("artifact://0:raw:1-3000");
		expect(output).toContain(artifactDir);
		expect(output).not.toContain("line-001");
	});

	it("streams bounded artifact reads without materializing the whole artifact", async () => {
		const result = await tool.execute("call-range", { path: "artifact://0:1-3" });
		const output = toolResultText(result);

		expect(output).toContain("line-001");
		expect(output).toContain("line-003");
		expect(output).toContain("Artifact storage:");
		expect(output).toContain("artifact://0:raw:N-M");
		expect(output).not.toContain("line-400");
	});

	it("keeps bounded raw artifact chunks verbatim (no workflow notice appended)", async () => {
		const result = await tool.execute("call-raw-range", { path: "artifact://0:raw:1-2" });
		const output = toolResultText(result);

		expect(output).toStartWith("line-001");
		expect(output).toContain("line-002");
		expect(output).not.toContain("line-400");
		// Raw chunks must stay verbatim so copy/paste workflows do not eat the
		// workflow notice into the artifact bytes.
		expect(output).not.toContain("Artifact storage:");
		expect(output).not.toContain("artifact://0:raw:N-M");
	});

	it("returns exactly the requested raw artifact range without context padding", async () => {
		const result = await tool.execute("call-raw-exact", { path: "artifact://0:raw:31-31" });
		const output = toolResultText(result);

		expect(output).toContain("line-031");
		expect(output).not.toContain("line-030");
		expect(output).not.toContain("line-032");
	});

	it("shortens artifact paths under the user's home dir instead of leaking the absolute path", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue(testDir);
		try {
			const result = await tool.execute("call-raw-home", { path: "artifact://0:raw" });
			const output = toolResultText(result);
			// artifactDir sits under the (mocked) home, so shortenPath rewrites the
			// prefix to `~` — the notice must NOT leak the absolute artifact path.
			expect(output).toContain(`~${path.sep}session`);
			expect(output).not.toContain(artifactDir);
		} finally {
			homeSpy.mockRestore();
		}
	});
});
