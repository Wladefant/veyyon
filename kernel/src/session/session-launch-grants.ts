import path from "node:path";
import { stringifyJson } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE, type SubagentLaunchGrant } from "./session-entries";

/**
 * JSON.parse silently takes the last duplicate object member. In a strict
 * failed-fork repair this could make a foreign line appear to have our ID.
 * Check raw member names after JSON syntax validation, including escaped-
 * equivalent names; nested objects retain independent name namespaces.
 */
export function hasDuplicateJsonMemberNames(raw: string): boolean {
	const containers: Array<Set<string> | null> = [];
	let index = 0;
	while (index < raw.length) {
		const char = raw[index];
		if (char === '"') {
			const start = index++;
			while (index < raw.length) {
				if (raw[index] === "\\") index += 2;
				else if (raw[index] === '"') {
					index++;
					break;
				} else index++;
			}
			const names = containers[containers.length - 1];
			if (names) {
				let following = index;
				while (
					raw[following] === " " ||
					raw[following] === "\t" ||
					raw[following] === "\r" ||
					raw[following] === "\n"
				)
					following++;
				if (raw[following] === ":") {
					const name = JSON.parse(raw.slice(start, index)) as string;
					if (names.has(name)) return true;
					names.add(name);
				}
			}
			continue;
		}
		if (char === "{") containers.push(new Set<string>());
		else if (char === "[") containers.push(null);
		else if (char === "}" || char === "]") containers.pop();
		index++;
	}
	return false;
}

export type SubagentLaunchGrantCheck = { ok: true; grant: SubagentLaunchGrant } | { ok: false; problem: string };

const RECEIPT_KEYS = ["type", "version", "rootSessionId", "agentId", "childSessionId", "sessionFile", "grants"];
const GRANT_KEYS = ["mergeRepos", "dismissRepos"];
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Whether `value` holds exactly `keys`: no missing key, no extra key. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRepoList(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	const seen = new Set<string>();
	for (const repo of value) {
		if (
			typeof repo !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$(?![\s\S])/u.test(repo) ||
			repo.endsWith("/.") ||
			repo.endsWith("/..")
		) return false;
		const scope = repo.toLowerCase();
		if (seen.has(scope)) return false;
		seen.add(scope);
	}
	return true;
}

export function isSubagentRepoGrants(value: unknown): value is SubagentLaunchGrant["grants"] {
	return isRecord(value) && hasExactKeys(value, GRANT_KEYS) && isRepoList(value.mergeRepos) && isRepoList(value.dismissRepos);
}

function bad(problem: string): SubagentLaunchGrantCheck {
	return { ok: false, problem };
}

/**
 * Whether a decoded JSONL record is a launch receipt line. Any record of that type is
 * kept out of the session entries whether or not it validates, so an invalid receipt
 * can never reach the entry graph.
 */
export function isSubagentLaunchGrantRecord(value: unknown): boolean {
	return isRecord(value) && value.type === SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE;
}

/**
 * Check the exact v1 receipt shape and return a freshly built receipt in the persisted key
 * order. Extra keys, missing keys, wrong types and empty strings are rejected, never repaired.
 */
export function validateSubagentLaunchGrant(value: unknown): SubagentLaunchGrantCheck {
	if (!isRecord(value)) return bad("the record is not a JSON object");
	if (!hasExactKeys(value, RECEIPT_KEYS)) return bad("the record keys are not exactly the v1 receipt keys");
	if (value.type !== SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE) return bad("the record type is not subagent_launch_grant");
	if (value.version !== 1) return bad("the receipt version is not 1");
	if (typeof value.rootSessionId !== "string" || !SESSION_ID.test(value.rootSessionId)) return bad("`rootSessionId` is not a UUID");
	if (!isNonEmptyString(value.agentId)) return bad("`agentId` is not a non-empty string");
	if (typeof value.childSessionId !== "string" || !SESSION_ID.test(value.childSessionId)) return bad("`childSessionId` is not a UUID");
	if (typeof value.sessionFile !== "string" || !path.isAbsolute(value.sessionFile)) return bad("`sessionFile` is not absolute");
	const grants = value.grants;
	if (!isSubagentRepoGrants(grants)) return bad("both grant actions must list distinct OWNER/REPO scopes");
	return {
		ok: true,
		grant: {
			type: SUBAGENT_LAUNCH_GRANT_ENTRY_TYPE,
			version: 1,
			rootSessionId: value.rootSessionId,
			agentId: value.agentId,
			childSessionId: value.childSessionId,
			sessionFile: value.sessionFile,
			grants: { mergeRepos: [...grants.mergeRepos], dismissRepos: [...grants.dismissRepos] },
		},
	};
}

/** Parse one journal line (without its newline) as a receipt. Duplicate member names are rejected. */
export function parseSubagentLaunchGrantLine(raw: string): SubagentLaunchGrantCheck {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return bad("the line is not valid JSON");
	}
	if (hasDuplicateJsonMemberNames(raw)) return bad("the line repeats a member name");
	return validateSubagentLaunchGrant(value);
}

/** The exact journal line (without its newline) for a valid receipt. Throws when the receipt is invalid. */
export function serializeSubagentLaunchGrant(grant: SubagentLaunchGrant): string {
	const checked = validateSubagentLaunchGrant(grant);
	if (!checked.ok) throw new Error(`Invalid subagent launch grant: ${checked.problem}`);
	return stringifyJson(checked.grant) ?? "null";
}
