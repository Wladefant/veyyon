import { describe, expect, it } from "bun:test";
import { createLegacyMCPToolName, createMCPToolName, mcpToolNamePrefix } from "../src/mcp/tool-bridge";

describe("shared MCP tool name mint pipeline", () => {
	it("mints current tool names keeping digits and stripping redundant prefixes", () => {
		expect(createMCPToolName("github1", "read_issue_2")).toBe("mcp__github1_read_issue_2");
		expect(createMCPToolName("jira2", "jira2_create_ticket")).toBe("mcp__jira2_create_ticket");
		expect(createMCPToolName("server", "tool")).toBe("mcp__server_tool");
	});

	it("mints legacy tool names stripping digits when digits exist, returning undefined when identical", () => {
		expect(createLegacyMCPToolName("github1", "read_issue_2")).toBe("mcp__github_read_issue");
		expect(createLegacyMCPToolName("jira2", "jira2_create_ticket")).toBe("mcp__jira_create_ticket");
		expect(createLegacyMCPToolName("server", "tool")).toBeUndefined();
	});

	it("preserves prefix consistency between prefix helper and minted names", () => {
		expect(mcpToolNamePrefix("github1")).toBe("mcp__github1_");
		expect(mcpToolNamePrefix("github1", false)).toBe("mcp__github_");
		expect(createMCPToolName("github1", "foo").startsWith(mcpToolNamePrefix("github1"))).toBe(true);
		const legacy = createLegacyMCPToolName("github1", "foo");
		expect(legacy).toBeDefined();
		expect(legacy!.startsWith(mcpToolNamePrefix("github1", false))).toBe(true);
	});
});
