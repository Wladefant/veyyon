import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RELEASE_REPOSITORY } from "../../utils/src/release-source";
import { MCP_CONFIG_SCHEMA_URL } from "../src/mcp/types";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

describe("RELEASE_REPOSITORY", () => {
	it("is an OWNER/REPO scope", () => {
		expect(RELEASE_REPOSITORY).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/);
	});

	it("is the repository the MCP config schema URL resolves against, and that file exists in the tree", () => {
		const prefix = `https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main/`;
		expect(MCP_CONFIG_SCHEMA_URL.startsWith(prefix)).toBe(true);
		const repoPath = MCP_CONFIG_SCHEMA_URL.slice(prefix.length);
		expect(fs.existsSync(path.join(repoRoot, repoPath))).toBe(true);
	});
});
