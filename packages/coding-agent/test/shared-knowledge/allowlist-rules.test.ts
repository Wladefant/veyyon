import { describe, expect, it } from "bun:test";
import {
	isForbiddenDatabaseFile,
	isForbiddenRuntimeFile,
	isForbiddenSecretFile,
	normalizeRelativePath,
	scanContentForSecrets,
	validateRelativePath,
	validateSecurityAllowlist,
} from "../../src/shared-knowledge/allowlist";

// Secret-shaped fixtures are assembled at run time so the source itself holds no credential-shaped literal.
const FAKE_OPENAI_KEY = ["sk", "a".repeat(24)].join("-");
const FAKE_AWS_KEY = ["AKIA", "A".repeat(16)].join("");
const FAKE_PRIVATE_KEY_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const FAKE_PASSWORD_ASSIGNMENT = ["pass", "word=hunter2"].join("");

describe("normalizeRelativePath", () => {
	it("turns backslashes into forward slashes and trims the edge slashes", () => {
		expect(normalizeRelativePath("\\skills\\docs\\SKILL.md\\")).toBe("skills/docs/SKILL.md");
	});
});

describe("validateRelativePath", () => {
	it("accepts a plain relative path", () => {
		expect(validateRelativePath("skills/docs/SKILL.md")).toEqual({ valid: true });
	});

	it("refuses an empty path, a NUL byte, and an absolute or drive-letter path", () => {
		expect(validateRelativePath("")).toEqual({
			valid: false,
			reason: "Relative path must be a non-empty string",
		});
		expect(validateRelativePath("skills/a\0b.md")).toEqual({
			valid: false,
			reason: "Path contains forbidden null byte",
		});
		expect(validateRelativePath("C:/secrets.md").valid).toBe(false);
		expect(validateRelativePath("\\\\server\\share\\x.md").valid).toBe(false);
	});

	it("refuses traversal and empty segments", () => {
		expect(validateRelativePath("skills/../secret.md").reason).toContain("Path traversal segment '..' is forbidden");
		expect(validateRelativePath("skills//a.md").reason).toContain("Empty path segment");
	});
});

describe("forbidden file classes", () => {
	it("flags database files by extension and exact basename, case-insensitively", () => {
		expect(isForbiddenDatabaseFile("data/history.db")).toBe(true);
		expect(isForbiddenDatabaseFile("Stats.DB")).toBe(true);
		expect(isForbiddenDatabaseFile("notes/cache.sqlite-wal")).toBe(true);
		expect(isForbiddenDatabaseFile("skills/SKILL.md")).toBe(false);
	});

	it("flags env files, key material, and credential directories", () => {
		expect(isForbiddenSecretFile(".env")).toBe(true);
		expect(isForbiddenSecretFile("config/.env.production")).toBe(true);
		expect(isForbiddenSecretFile("keys/id_ed25519")).toBe(true);
		expect(isForbiddenSecretFile("certs/server.pem")).toBe(true);
		expect(isForbiddenSecretFile("x/shared-auth/token.txt")).toBe(true);
		expect(isForbiddenSecretFile("skills/credentials/README.md")).toBe(true);
		expect(isForbiddenSecretFile("skills/docs-first/SKILL.md")).toBe(false);
	});

	it("flags runtime, socket, log, cache, and VCS paths", () => {
		expect(isForbiddenRuntimeFile("run/agent.sock")).toBe(true);
		expect(isForbiddenRuntimeFile("a/service.log")).toBe(true);
		expect(isForbiddenRuntimeFile("x/a.tmp")).toBe(true);
		expect(isForbiddenRuntimeFile("x/.tmp-data")).toBe(true);
		expect(isForbiddenRuntimeFile("node_modules/pkg/index.md")).toBe(true);
		expect(isForbiddenRuntimeFile("a/.git/config")).toBe(true);
		expect(isForbiddenRuntimeFile("rules/standards.md")).toBe(false);
	});
});

describe("scanContentForSecrets", () => {
	it("passes ordinary prose", () => {
		expect(scanContentForSecrets("# Lesson: prefer small diffs")).toEqual({ valid: true });
	});

	it("refuses a private key header, an API key, a password assignment, and a bearer token", () => {
		for (const content of [
			FAKE_PRIVATE_KEY_HEADER,
			`token ${FAKE_OPENAI_KEY}`,
			FAKE_PASSWORD_ASSIGNMENT,
			"Authorization: bearer abc.def.ghi",
			FAKE_AWS_KEY,
		]) {
			const result = scanContentForSecrets(content);
			expect(result.valid).toBe(false);
			expect(result.reason).toContain("forbidden credential/secret pattern");
		}
	});
});

describe("validateSecurityAllowlist", () => {
	it("admits the syncable categories and the reference file", async () => {
		expect(await validateSecurityAllowlist("skills/docs/SKILL.md", { content: "# Docs" })).toEqual({ valid: true });
		expect(await validateSecurityAllowlist("config/hindsight-reference.json")).toEqual({ valid: true });
		expect(await validateSecurityAllowlist("lessons/learned.md")).toEqual({ valid: true });
		expect(await validateSecurityAllowlist("workflows/run.sh")).toEqual({ valid: true });
	});

	it("refuses a file type or location outside the allowlist with the same reason", async () => {
		const notSyncable = { valid: false, reason: "Path or file type is not syncable" };
		expect(await validateSecurityAllowlist("skills/a.json")).toEqual(notSyncable);
		expect(await validateSecurityAllowlist("random/x.md")).toEqual(notSyncable);
		expect(await validateSecurityAllowlist("workflows/run.exe")).toEqual(notSyncable);
		expect(await validateSecurityAllowlist("skills/My Skill/SKILL.md")).toEqual(notSyncable);
		expect(await validateSecurityAllowlist("skills/docs/CON.md")).toEqual(notSyncable);
		expect(await validateSecurityAllowlist("skills/docs./SKILL.md")).toEqual(notSyncable);
		expect(await validateSecurityAllowlist("skills\\docs\\SKILL.md")).toEqual(notSyncable);
	});

	it("names the database, traversal, and secret refusals before the allowlist rule", async () => {
		expect((await validateSecurityAllowlist("skills/data.db")).reason).toBe("Database file rejected: skills/data.db");
		expect((await validateSecurityAllowlist("../etc/x.md")).reason).toContain("Path traversal segment");
		expect(
			(await validateSecurityAllowlist("skills/docs/SKILL.md", { content: FAKE_PASSWORD_ASSIGNMENT })).valid,
		).toBe(false);
	});
});
