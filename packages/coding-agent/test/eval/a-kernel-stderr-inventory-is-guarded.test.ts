/**
 * Raw fd 2 bypasses the runner's framed stdout protocol, so it must be guarded before
 * the process logger writes it. The kernel drain is process-scoped: this test proves
 * inventory filtering, split writes, and the final unterminated record with a real
 * Python kernel and the real logger file sink. It does not prove owner-specific
 * literal redaction for unframed stderr.
 */
import { expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { executePython, disposeKernelSessionsByOwner } from "@veyyon/coding-agent/eval/py/executor";
import { TempDir } from "@veyyon/utils";
import { setTransports } from "@veyyon/utils/logger";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";

const OWNER = "kernel-stderr-inventory-test";

async function readLogDirectory(directory: string): Promise<string> {
	const names = await readdir(directory).catch(() => [] as string[]);
	const logs = await Promise.all(
		names.filter(name => name.endsWith(".log")).map(name => readFile(path.join(directory, name), "utf8")),
	);
	return logs.join("\n");
}

describeRequiringTool("python3", "kernel OS stderr logging", () => {
	it("filters split inventory records and preserves ordinary and final stderr", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-stderr-");
		const logs = path.join(tempDir.path(), "logs");
		setTransports({ file: logs });
		try {
			const result = await executePython(
				"import os; os.write(2, b'ALPHA=fake-a\\n'); os.write(2, b'BETA=fake-b\\n'); os.write(2, b'GAMMA=fake-c\\n')",
				{ sessionId: `kernel-stderr-inventory:${crypto.randomUUID()}`, kernelOwnerId: OWNER },
			);
			expect(result.exitCode).toBe(0);
			const safeResult = await executePython(
				"import os; os.write(2, b'ordinary diagnostic\\n'); os.write(2, b'final diagnostic without newline')",
				{ sessionId: `kernel-stderr-safe:${crypto.randomUUID()}`, kernelOwnerId: OWNER },
			);
			expect(safeResult.exitCode).toBe(0);
			await disposeKernelSessionsByOwner(OWNER);
			const content = await readLogDirectory(logs);

			expect(content).toContain("ordinary diagnostic");
			expect(content).toContain("final diagnostic without newline");
			expect(content).not.toContain("ALPHA=fake-a");
			expect(content).not.toContain("BETA=fake-b");
			expect(content).not.toContain("GAMMA=fake-c");
		} finally {
			await disposeKernelSessionsByOwner(OWNER);
			setTransports({ file: false, console: false });
		}
	}, 30_000);
});
