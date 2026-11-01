/** A decoded agent:// host must never turn into a path outside registered artifacts. */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { AgentProtocolHandler } from "../src/internal-urls/agent-protocol";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { registerArtifactsDir } from "../src/internal-urls/registry-helpers";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function disposableArtifacts(): Promise<{ directory: string; outside: string }> {
	const temp = TempDir.createSync("agent-url-single-component-");
	const directory = path.join(temp.path(), "scoped", "artifacts");
	const outside = path.join(temp.path(), "outside.md");
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(outside, "synthetic OUTSIDE artifact, not private data");
	const unregister = registerArtifactsDir(directory);
	cleanups.push(async () => { unregister(); await temp.remove(); });
	return { directory, outside };
}

it("refuses percent-decoded slash, backslash, ADS syntax and reserved output IDs before touching disk", async () => {
	const { outside } = await disposableArtifacts();
	const handler = new AgentProtocolHandler();
	for (const uri of [
		"agent://..%2F..%2Foutside",
		"agent://..%5C..%5Coutside",
		"agent://..%2f..%2foutside",
		"agent://Worker%3Astream",
		"agent://con",
		"agent://..",
	] as const) {
		await expect(handler.resolve(parseInternalUrl(uri))).rejects.toThrow("Invalid agent output ID");
	}
	// Nothing outside the artifact root is used or changed by a rejected URL.
	expect(await fs.readFile(outside, "utf8")).toBe("synthetic OUTSIDE artifact, not private data");
});

it("continues to resolve ordinary and versioned native-result IDs from the registered directory", async () => {
	const { directory } = await disposableArtifacts();
	const handler = new AgentProtocolHandler();
	for (const [name, body] of [
		["B20SafeReader852", "immutable original"],
		["B20SafeReader852.phase-deadbeef", "immutable continuation"],
	] as const) {
		await fs.writeFile(path.join(directory, name + ".md"), body);
		const result = await handler.resolve(parseInternalUrl("agent://" + name));
		expect(result.content).toBe(body);
		expect(result.contentType).toBe("text/markdown");
		expect(result.sourcePath).toBe(path.join(directory, name + ".md"));
	}
});
