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
				'import os; os.write(2, b\'{\\n  "ALPHA": "fake-structured",\\n\\n  "BETA": ["quoted } brace", {"deep": [true, null]}],\\n\\n  "GAMMA": {"array": [{"text": "fake-map"}]}\\n}\\n\\nsafe after structured inventory\\n\\n\')',
			);
			const earlyRejectedStructuredResult = await kernel.execute(
				'import os; os.write(2, b\'{\\n"ALPHA":"fake-a", "BETA":"fake-b", "GAMMA":"fake-c",\\n\\n"DELTA":"fake-tail-value"\\n}\\n\\nsafe after early rejection\\n\\n\')',
			);
			expect(earlyRejectedStructuredResult.status).toBe("ok");
			const earlyRejectedCredentialResult = await kernel.execute(
				'import os; os.write(2, b\'{\\n"API_TOKEN":"fake-token",\\n\\n"ORDINARY_A":"fake-a",\\n\\n"ORDINARY_B":"fake-b"\\n}\\n\\nsafe after credential rejection\\n\\n\')',
			);
			expect(earlyRejectedCredentialResult.status).toBe("ok");
			const fourAssignmentsResult = await kernel.execute(
				"import os; os.write(2, b'ASSIGN_A=fake-a\\n\\nASSIGN_B=fake-b\\n\\nASSIGN_C=fake-c\\n\\nASSIGN_D=fake-tail-value\\n\\nsafe after fourth assignment\\n\\n')",
			);
			expect(fourAssignmentsResult.status).toBe("ok");
			expect(structuredResult.status).toBe("ok");
			expect(await readLogDirectory(logs)).not.toContain("fake-tail-value");
			expect(structuredResult.status).toBe("ok");
			const ordinaryAssignmentsResult = await kernel.execute(
				"import os; [os.write(2, bytes([byte])) for byte in b'ORDINARY_A=fake-ordinary-a\\n\\nORDINARY_B=fake-ordinary-b\\n\\nORDINARY_C=fake-ordinary-c\\n\\nsafe after ordinary assignments\\n\\n']",
			);
			expect(ordinaryAssignmentsResult.status).toBe("ok");
			const normalizedAssignmentsResult = await kernel.execute(
				"import os; os.write(2, b'CTRL_A=fake-ctrl-a\\n \\t\\nCTRL_B=fake-ctrl-b\\n \\nCTRL_C=fake-ctrl-c\\n\\nsafe after normalized assignments\\n\\n')",
			);
			expect(normalizedAssignmentsResult.status).toBe("ok");
			const prefixedStructuredResult = await kernel.execute(
				"import os; os.write(2, b'\\x00\\x1b[31m{\\n\\x00\\x1b[31m\"ALPHA\":\"fake-prefixed-a\",\\n\\n\\x00\\x1b[31m\"BETA\":\"fake-prefixed-b\",\\n\\x00\\x1b[31m\"GAMMA\":\"fake-prefixed-c\"\\n}\\n\\nsafe after prefixed structured inventory\\n\\n')",
			);
			expect(prefixedStructuredResult.status).toBe("ok");
			const prefixedAssignmentsResult = await kernel.execute(
				"import os; os.write(2, b'\\x00\\x1b[31mPREF_A=fake-prefixed-a\\n\\x00\\x1b[31mPREF_B=fake-prefixed-b\\n\\x00\\x1b[31mPREF_C=fake-prefixed-c\\n\\nsafe after prefixed assignments\\n\\n')",
			);
			expect(prefixedAssignmentsResult.status).toBe("ok");
			const mixedNormalizedResult = await kernel.execute(
				"import os; [os.write(2, bytes([byte])) for byte in b'MIX_A=fake-mix-a\\n\\x00 \\t\\nMIX_B=fake-mix-b\\n\\x00\\x1b[31mMIX_C=fake-mix-c\\n\\nsafe after mixed normalized assignments\\n\\n']",
			);
			expect(mixedNormalizedResult.status).toBe("ok");
			const ansiStructuredResult = await kernel.execute(
				"import os; os.write(2, b'\\x1b[31m{\\n\\x1b[31m\"ANSI_A\":\"fake-ansi-struct-a\",\\n\\n\\x1b[31m\"ANSI_B\":\"fake-ansi-struct-b\",\\n\\x1b[31m\"ANSI_C\":\"fake-ansi-struct-c\"\\n}\\n\\nsafe after ANSI structured inventory\\n\\n')",
			);
			expect(ansiStructuredResult.status).toBe("ok");
			const ansiAssignmentsResult = await kernel.execute(
				"import os; [os.write(2, bytes([byte])) for byte in b'\\x1b[31mANSI_A=fake-ansi-a\\n\\x1b[31mANSI_B=fake-ansi-b\\n\\x1b[31mANSI_C=fake-ansi-c\\n\\nsafe after ANSI assignments\\n\\n']",
			);
			expect(ansiAssignmentsResult.status).toBe("ok");
			for (const opening of ["{", "["]) {
				for (const bytewise of [false, true]) {
					const payload = opening === "{"
						? '\x00CONFIG={"ALPHA":"fake-assigned-a",\n  "BETA":"fake-assigned-b",\n  "GAMMA":"fake-assigned-c"}\n\nsafe after assigned inventory\n\n'
						: '\x1b[31mexport CONFIG=[{"ALPHA":"fake-assigned-a",\n  "BETA":"fake-assigned-b",\n  "GAMMA":"fake-assigned-c"}]\n\nsafe after assigned inventory\n\n';
					const encoded = JSON.stringify(payload);
					const write = bytewise
						? `[os.write(2, bytes([byte])) for byte in ${encoded}.encode()]`
						: `os.write(2, ${encoded}.encode())`;
					const assignedResult = await kernel.execute(`import os; ${write}`);
					expect(assignedResult.status).toBe("ok");
					const assignedContent = await readLogDirectory(logs);
					for (const value of ["fake-assigned-a", "fake-assigned-b", "fake-assigned-c"]) {
						expect(assignedContent).not.toContain(value);
					}
					expect(assignedContent).toContain("safe after assigned inventory");
				}
			}
			
			const normalizedContent = await readLogDirectory(logs);
			expect(normalizedContent).not.toContain("fake-ctrl-a");
			expect(normalizedContent).not.toContain("fake-prefixed-a");
			expect(normalizedContent).not.toContain("fake-prefixed-b");
			expect(normalizedContent).not.toContain("fake-prefixed-c");
			expect(normalizedContent).not.toContain("fake-mix-a");
			expect(normalizedContent).not.toContain("fake-mix-b");
			expect(normalizedContent).not.toContain("fake-mix-c");
			expect(normalizedContent).toContain("safe after normalized assignments");
			expect(normalizedContent).toContain("safe after prefixed structured inventory");
			expect(normalizedContent).toContain("safe after prefixed assignments");
			expect(normalizedContent).toContain("safe after mixed normalized assignments");
			expect(normalizedContent).not.toContain("fake-ansi-struct-a");
			expect(normalizedContent).not.toContain("fake-ansi-struct-b");
			expect(normalizedContent).not.toContain("fake-ansi-struct-c");
			expect(normalizedContent).not.toContain("fake-ansi-a");
			expect(normalizedContent).not.toContain("fake-ansi-b");
			expect(normalizedContent).not.toContain("fake-ansi-c");
			expect(normalizedContent).toContain("safe after ANSI structured inventory");
			expect(normalizedContent).toContain("safe after ANSI assignments");
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
				'import os; os.write(2, b\'{\\n  "ALPHA": "fake-incomplete-structured",\\n\\nfresh kernel incomplete safe tail\')',
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
