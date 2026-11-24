/**
 * The subagent launch receipt decides which repositories a child may merge or dismiss. These cases
 * pin the exact-shape check, the refusal of duplicate JSON members, and the round trip through the
 * journal line. `session-launch-grants.ts` owns all of them. They run the functions directly, without
 * a session journal.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE, type SubagentLaunchGrant } from "../src/session/session-entries";
import {
	hasDuplicateJsonMemberNames,
	isSubagentLaunchGrantRecord,
	isSubagentRepoGrants,
	parseSubagentLaunchGrantLine,
	serializeSubagentLaunchGrant,
	validateSubagentLaunchGrant,
} from "../src/session/session-launch-grants";

const ROOT = "11111111-2222-3333-4444-555555555555";
const CHILD = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const SESSION_FILE = path.resolve("sessions", "child.jsonl");

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE,
		version: 1,
		rootSessionId: ROOT,
		agentId: "LaunchLane",
		childSessionId: CHILD,
		sessionFile: SESSION_FILE,
		grants: { mergeRepos: ["Example/project"], dismissRepos: ["Example/reviews"] },
		...overrides,
	};
}

function problemOf(value: unknown): string {
	const checked = validateSubagentLaunchGrant(value);
	if (checked.ok) throw new Error("expected the receipt to be refused");
	return checked.problem;
}

describe("validateSubagentLaunchGrant", () => {
	it("accepts the exact v1 receipt and returns a fresh copy in persisted key order", () => {
		const input = receipt();
		const checked = validateSubagentLaunchGrant(input);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(Object.keys(checked.grant)).toEqual([
			"type",
			"version",
			"rootSessionId",
			"agentId",
			"childSessionId",
			"sessionFile",
			"grants",
		]);
		expect(Object.keys(checked.grant.grants)).toEqual(["mergeRepos", "dismissRepos"]);
		expect(checked.grant.grants).toEqual({ mergeRepos: ["Example/project"], dismissRepos: ["Example/reviews"] });

		const inputGrants = input.grants;
		if (!isSubagentRepoGrants(inputGrants)) throw new Error("fixture grants are malformed");
		expect(checked.grant.grants.mergeRepos).not.toBe(inputGrants.mergeRepos);
	});

	it("refuses a receipt with an extra key or a missing key", () => {
		expect(problemOf(receipt({ extra: true }))).toBe("the record keys are not exactly the v1 receipt keys");
		const missing = receipt();
		delete missing.agentId;
		expect(problemOf(missing)).toBe("the record keys are not exactly the v1 receipt keys");
	});

	it("refuses a receipt that is not an object, a wrong type, or a wrong version", () => {
		expect(problemOf("text")).toBe("the record is not a JSON object");
		expect(problemOf(null)).toBe("the record is not a JSON object");
		expect(problemOf(receipt({ type: "message" }))).toBe("the record type is not subagent_launch_grant");
		expect(problemOf(receipt({ version: 2 }))).toBe("the receipt version is not 1");
	});

	it("refuses malformed identifiers and an empty or relative session file", () => {
		expect(problemOf(receipt({ rootSessionId: "not-a-uuid" }))).toBe("`rootSessionId` is not a UUID");
		expect(problemOf(receipt({ childSessionId: "not-a-uuid" }))).toBe("`childSessionId` is not a UUID");
		expect(problemOf(receipt({ agentId: "" }))).toBe("`agentId` is not a non-empty string");
		expect(problemOf(receipt({ sessionFile: "relative/child.jsonl" }))).toBe("`sessionFile` is not absolute");
	});

	it("refuses grant lists that repeat a scope case-insensitively or name a non-repository", () => {
		expect(
			problemOf(receipt({ grants: { mergeRepos: ["Example/project", "example/PROJECT"], dismissRepos: [] } })),
		).toBe("both grant actions must list distinct OWNER/REPO scopes");
		expect(problemOf(receipt({ grants: { mergeRepos: ["Example"], dismissRepos: [] } }))).toBe(
			"both grant actions must list distinct OWNER/REPO scopes",
		);
		expect(problemOf(receipt({ grants: { mergeRepos: ["Example/.."], dismissRepos: [] } }))).toBe(
			"both grant actions must list distinct OWNER/REPO scopes",
		);
	});
});

describe("isSubagentRepoGrants", () => {
	it("accepts empty and well-formed lists and refuses extra keys", () => {
		expect(isSubagentRepoGrants({ mergeRepos: [], dismissRepos: [] })).toBe(true);
		expect(isSubagentRepoGrants({ mergeRepos: ["Example/project.git"], dismissRepos: [] })).toBe(true);
		expect(isSubagentRepoGrants({ mergeRepos: [], dismissRepos: [], extra: [] })).toBe(false);
		expect(isSubagentRepoGrants({ mergeRepos: ["Example/project extra"], dismissRepos: [] })).toBe(false);
	});
});

describe("journal line parsing", () => {
	it("round-trips a serialized receipt into the same record", () => {
		const grant: SubagentLaunchGrant = {
			type: SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE,
			version: 1,
			rootSessionId: ROOT,
			agentId: "LaunchLane",
			childSessionId: CHILD,
			sessionFile: SESSION_FILE,
			grants: { mergeRepos: ["Example/project"], dismissRepos: ["Example/reviews"] },
		};
		const line = serializeSubagentLaunchGrant(grant);
		expect(line.includes("\n")).toBe(false);
		expect(JSON.parse(line)).toEqual(receipt());

		const parsed = parseSubagentLaunchGrantLine(line);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.grant).toEqual(grant);
	});

	it("refuses to serialize a receipt that fails validation", () => {
		const stale = receipt({ version: 2 }) as unknown as SubagentLaunchGrant;
		expect(() => serializeSubagentLaunchGrant(stale)).toThrow(
			"Invalid subagent launch grant: the receipt version is not 1",
		);
	});

	it("refuses a line that is not JSON and a line that repeats a member name", () => {
		expect(parseSubagentLaunchGrantLine("{")).toEqual({ ok: false, problem: "the line is not valid JSON" });

		const line = JSON.stringify(receipt()).replace(
			'"agentId":"LaunchLane"',
			'"agentId":"LaunchLane","agentId":"Other"',
		);
		expect(JSON.parse(line).agentId).toBe("Other");
		expect(parseSubagentLaunchGrantLine(line)).toEqual({ ok: false, problem: "the line repeats a member name" });
	});

	it("keeps every record of the receipt type out of the entry graph, valid or not", () => {
		expect(isSubagentLaunchGrantRecord({ type: SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE, broken: true })).toBe(true);
		expect(isSubagentLaunchGrantRecord({ type: "message" })).toBe(false);
		expect(isSubagentLaunchGrantRecord(null)).toBe(false);
	});
});

describe("hasDuplicateJsonMemberNames", () => {
	it("detects a repeated member name, including an escaped-equivalent one", () => {
		expect(hasDuplicateJsonMemberNames('{"a":1,"a":2}')).toBe(true);
		expect(hasDuplicateJsonMemberNames('{"a":1,"\\u0061":2}')).toBe(true);
	});

	it("keeps member names independent across nested objects and array elements", () => {
		expect(hasDuplicateJsonMemberNames('{"a":{"x":1},"b":{"x":2}}')).toBe(false);
		expect(hasDuplicateJsonMemberNames('[{"a":1},{"a":2}]')).toBe(false);
	});
});
