import { expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSessionAt } from "../helpers/tool-session";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

useIsolatedGlobalSettings();
const tempDir = useTrackedTempDirs("bash-long-record-");
const START = "SYNTHETIC_START_";
const END = "_SYNTHETIC_END";
const FOOTER = /\[raw output: (artifact:\/\/\d+)\]/;

async function fixture() {
	const cwd = tempDir();
	const artifacts = path.join(cwd, "artifacts");
	await mkdir(artifacts);
	let nextId = 0;
	const session = makeToolSessionAt(cwd, {
		getSessionId: () => cwd,
		localProtocolOptions: { getArtifactsDir: () => artifacts },
		allocateOutputArtifact: async kind => {
			const id = String(nextId++);
			return { id, path: path.join(artifacts, `${id}.${kind}.txt`) };
		},
	});
	return { artifacts, session };
}

function longLine(length: number, suffix = ""): string {
	return `printf '${START}'; head -c ${length} /dev/zero | tr '\\0' x; printf '${suffix}${END}'; exit 2`;
}

async function recover(session: ToolSession, text: string): Promise<string> {
	const link = FOOTER.exec(text)?.[1];
	if (!link) throw new Error(`Expected a raw output artifact link, got: ${text.slice(0, 200)}`);
	return toolResultText(await new ReadTool(session).execute("recover", { path: `${link}:raw:1-160` }));
}

test("Bash keeps both ends of a single long record from a failed command", async () => {
	const { session } = await fixture();
	const result = await new BashTool(session).execute("long", { command: longLine(70_000), timeout: 20 });
	const text = toolResultText(result);
	expect(result.isError).toBe(true);
	expect(result.details?.exitCode).toBe(2);
	expect(text).not.toContain(END);
	const captured = await recover(session, text);
	expect(captured).toBe(`${START}${"x".repeat(70_000)}${END}`);
});

test("Bash scans the tail of a long record before it can enter the artifact", async () => {
	const { session } = await fixture();
	const syntheticValue = "synthetic-fixture-not-a-real-credential";
	const result = await new BashTool(session).execute("credential", {
		command: longLine(70_000, ` password=\"${syntheticValue}\" `),
		timeout: 20,
	});
	const text = toolResultText(result);
	expect(text).not.toContain(syntheticValue);
	const captured = await recover(session, text);
	expect(captured).toContain(START);
	expect(captured).toContain(END);
	expect(captured).not.toContain(syntheticValue);
});

test("Bash reports an unscannable record without claiming to have captured it", async () => {
	const { artifacts, session } = await fixture();
	const result = await new BashTool(session).execute("withheld", {
		command: longLine(1_100_000),
		timeout: 20,
	});
	const text = toolResultText(result);
	expect(result.details?.exitCode).toBe(2);
	expect(text).toMatch(/not scanned|withheld/);
	expect(text).not.toContain("artifact://");
	expect(await readdir(artifacts)).toEqual([]);
});

test("Bash keeps the exit and reports a failed artifact write without a link", async () => {
	const { artifacts, session } = await fixture();
	const result = await new BashTool({
		...session,
		allocateOutputArtifact: async () => ({ id: "0", path: artifacts }),
	}).execute("failed-write", { command: longLine(70_000), timeout: 20 });
	expect(result.details?.exitCode).toBe(2);
	expect(result.details?.meta?.artifactError).toBeDefined();
	expect(toolResultText(result)).not.toContain("artifact://");
});
