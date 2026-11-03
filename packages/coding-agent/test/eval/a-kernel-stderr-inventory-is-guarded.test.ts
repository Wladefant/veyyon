/**
 * Raw fd 2 groups end only at blank physical records, not at cell completion or chunk boundaries.
 * This proves blocked inventory-shaped maps, credential and oversized groups do not poison later
 * safe groups, split CRLF delimiters work across executions, and incomplete safe, structured and
 * blocked tails stay withheld at EOF. It does not prove owner-specific literal redaction for
 * unframed stderr.
 */
import { expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { setTransports } from "@veyyon/utils/logger";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";
import { PythonKernel } from "../../src/eval/py/kernel";

const OWNER = "kernel-stderr-inventory-test";

async function readLogDirectory(directory: string): Promise<string> {
	const names = await readdir(directory).catch(() => [] as string[]);
	const logs = await Promise.all(
		names.filter(name => name.endsWith(".log")).map(name => readFile(path.join(directory, name), "utf8")),
	);
	return logs.join("\n");
}

describeRequiringTool("python3", "kernel OS stderr logging", () => {
	it("filters blocked records and preserves later stderr on the same kernel", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-stderr-");
		const logs = path.join(tempDir.path(), "logs");
		setTransports({ file: logs });
		const kernels: PythonKernel[] = [];
		try {
			const kernel = await PythonKernel.start({
				cwd: tempDir.path(),
				sessionId: `kernel-stderr-inventory:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER,
			});
			kernels.push(kernel);

			const firstResult = await kernel.execute(
				"import os; os.write(2, b'ALPHA=fake-a\\nBETA=fake-b\\nGAMMA=fake-c\\n\\nsafe after inventory\\n\\nAPI_TOKEN=fake-token-value\\n\\nsafe after credential\\n\\n')",
			);
			const structuredResult = await kernel.execute(
				"import os; os.write(2, b'{\\n  \"ALPHA\": \"fake-structured\",\\n\\n  \"BETA\": [\"quoted } brace\", {\"deep\": [true, null]}],\\n\\n  \"GAMMA\": {\"array\": [{\"text\": \"fake-map\"}]}\\n}\\n\\nsafe after structured inventory\\n\\n')",
			);
			expect(structuredResult.status).toBe("ok");
			const ordinaryAssignmentsResult = await kernel.execute(
				"import os; [os.write(2, bytes([byte])) for byte in b'ORDINARY_A=fake-ordinary-a\\n\\nORDINARY_B=fake-ordinary-b\\n\\nORDINARY_C=fake-ordinary-c\\n\\nsafe after ordinary assignments\\n\\n']",
			);
			expect(ordinaryAssignmentsResult.status).toBe("ok");
			expect(firstResult.status).toBe("ok");
			const pendingGroupResult = await kernel.execute("import os; os.write(2, b'safe split delimiter\\n')");
			expect(pendingGroupResult.status).toBe("ok");
			expect(await readLogDirectory(logs)).not.toContain("safe split delimiter");
			const splitDelimiterResult = await kernel.execute(
				"import os, time; os.write(2, b'\\r'); time.sleep(0.05); os.write(2, b'\\n\\r\\n')",
			);
			expect(splitDelimiterResult.status).toBe("ok");

			const laterResult = await kernel.execute("import os; os.write(2, b'safe in later execution\\n\\n')");
			expect(laterResult.status).toBe("ok");
			const oversizedResult = await kernel.execute(
				"import os; os.write(2, b'x'*65537 + b'\\nhidden single-line continuation\\n\\nsafe after oversized group\\n\\n')",
			);
			expect(oversizedResult.status).toBe("ok");
			const oversizedMultilineResult = await kernel.execute(
				"import os; os.write(2, b'a'*40000 + b'\\n' + b'b'*30000 + b'\\nhidden multiline continuation\\n\\nsafe after oversized multiline group\\n\\n')",
			);
			const blankSplitOverflowResult = await kernel.execute(
				"import os; os.write(2, b'{\\n  \"ALPHA\": \"fake-blank-split-inventory\",\\n\\n' + b' '*65537 + b'\\nfake-blank-split-continuation\\n\\nsafe after blank-split overflow\\n\\n')",
			);
			expect(blankSplitOverflowResult.status).toBe("ok");
			const blankOnlyOverflowResult = await kernel.execute(
				"import os; os.write(2, b'{\\n  \"ALPHA\": \"fake-blank-only-inventory\",\\n\\n' + b'\\n'*65537 + b'safe after blank-only overflow\\n\\n')",
			);
			expect(blankOnlyOverflowResult.status).toBe("ok");
			expect(oversizedMultilineResult.status).toBe("ok");
			expect(oversizedResult.status).toBe("ok");

			const eofResult = await kernel.execute("import os; os.write(2, b'incomplete safe tail\\n')");
			expect(eofResult.status).toBe("ok");
			expect(await readLogDirectory(logs)).not.toContain("incomplete safe tail");
			await Promise.all(kernels.map(kernel => kernel.shutdown()));
			kernels.length = 0;
			const incompleteSafeKernel = await PythonKernel.start({
				cwd: tempDir.path(),
				sessionId: `kernel-stderr-inventory:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER,
			});
			kernels.push(incompleteSafeKernel);
			const incompleteSafeResult = await incompleteSafeKernel.execute(
				"import os; os.write(2, b'{\\n  \"ALPHA\": \"fake-incomplete-structured\",\\n\\nfresh kernel incomplete safe tail')",
			);
			expect(incompleteSafeResult.status).toBe("ok");
			await Promise.all(kernels.map(kernel => kernel.shutdown()));
			kernels.length = 0;
			expect(await readLogDirectory(logs)).not.toContain("fresh kernel incomplete safe tail");

			const blockedTailKernel = await PythonKernel.start({
				cwd: tempDir.path(),
				sessionId: `kernel-stderr-inventory:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER,
			});
			kernels.push(blockedTailKernel);
			const blockedTailResult = await blockedTailKernel.execute(
				"import os; os.write(2, b'incomplete API_TOKEN=tail-secret')",
			);
			expect(blockedTailResult.status).toBe("ok");
			await Promise.all(kernels.map(kernel => kernel.shutdown()));
			kernels.length = 0;
			const content = await readLogDirectory(logs);

			expect(content).toContain("safe after inventory");
			expect(content).toContain("safe after credential");
			expect(content).toContain("safe split delimiter");
			expect(content).toContain("safe after blank-split overflow");
			expect(content).toContain("safe after blank-only overflow");
			expect(content).not.toContain("fake-blank-only-inventory");
			expect(content).not.toContain("fake-blank-split-inventory");
			expect(content).not.toContain("fake-blank-split-continuation");
			expect(content).toContain("safe after oversized multiline group");
			expect(content).toContain("safe in later execution");
			expect(content).toContain("safe after oversized group");
			expect(content).toContain("safe after structured inventory");
			expect(content).toContain("safe after ordinary assignments");
			expect(content).toContain("[blocked stderr group: size limit]");
			expect(content).not.toContain("incomplete safe tail");
			expect(content).not.toContain("incomplete API_TOKEN=tail-secret");
			expect(content).not.toContain("fake-incomplete-structured");
			expect(content).not.toContain("ALPHA=fake-a");
			expect(content).not.toContain("BETA=fake-b");
			expect(content).not.toContain("GAMMA=fake-c");
			expect(content).not.toContain("API_TOKEN=fake-token-value");
			expect(content).not.toContain("fake-blank-split-inventory");
			expect(content).not.toContain("fake-blank-split-continuation");
			expect(content).not.toContain("fake-structured");
			expect(content).not.toContain("fake-map");
			expect(content).not.toContain("fake-ordinary-a");
			expect(content).not.toContain("fake-ordinary-b");
			expect(content).not.toContain("fake-ordinary-c");
		} finally {
			await Promise.all(kernels.map(kernel => kernel.shutdown()));
			setTransports({ file: false, console: false });
		}
	}, 30_000);
});
