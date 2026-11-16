import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	__resetAutoQaFlushStateForTests,
	createReportToolIssueTool,
	flushGrievances,
	openAutoQaDb,
	sanitizeAutoQaPayload,
} from "@veyyon/coding-agent/tools/agent/report-tool-issue";
import type { ToolSession } from "@veyyon/coding-agent/tools/index";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
let tempDir = "";

beforeAll(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("autoqa-pii");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-autoqa-pii-"));
	openAutoQaDb();
});

afterEach(() => {
	__resetAutoQaFlushStateForTests();
});

afterAll(() => {
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function createToolSession(obfuscateProviderText?: (text: string) => string): ToolSession {
	const settings = Settings.isolated();
	settings.set("dev.autoqa", true);
	settings.set("dev.autoqaPush.enabled", false);
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "test-session",
		getSessionSpawns: () => null,
		settings,
		obfuscateProviderText,
	};
}

function createThrowawayDb(name: string): Database {
	const db = new Database(path.join(tempDir, name));
	db.run(`
		CREATE TABLE IF NOT EXISTS grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			pushed INTEGER NOT NULL DEFAULT 0
		);
	`);
	return db;
}

describe("auto-QA grievance PII redaction", () => {
	it("redacts home directory and identity-form login names at storage time without touching ordinary words", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue("/Users/will");
		const userSpy = spyOn(os, "userInfo").mockReturnValue({
			username: "will",
			uid: 501,
			gid: 20,
			shell: "/bin/zsh",
			homedir: "/Users/will",
		});
		try {
			const tool = createReportToolIssueTool(createToolSession(), ["bash"]);
			const report =
				"launchctl print gui/501/com.will.agent failed in /Users/will/code and /USERS/WILL/docs (not /Users/willa); see /c/Users/will/src, -Users-will-proj, ~will, and ssh will@build-host. Please will you test bin/node?";
			await tool.execute("call-1", { tool: "bash", report });

			const db = openAutoQaDb();
			if (!db) throw new Error("Expected isolated autoqa.db");
			const rows = db.prepare("SELECT report FROM grievances ORDER BY id DESC LIMIT 1").all() as Array<{
				report: string;
			}>;
			expect(rows[0]?.report).toBe(
				"launchctl print gui/501/com.<user>.agent failed in ~/code and ~/docs (not /Users/willa); see /c/Users/<user>/src, -Users-<user>-proj, ~<user>, and ssh <user>@build-host. Please will you test bin/node?",
			);
		} finally {
			homeSpy.mockRestore();
			userSpy.mockRestore();
		}
	});

	it("redacts Windows mixed-case home paths with both slash directions", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue("C:\\Users\\Will");
		const userSpy = spyOn(os, "userInfo").mockReturnValue({
			username: "Will",
			uid: -1,
			gid: -1,
			shell: null,
			homedir: "C:\\Users\\Will",
		});
		try {
			const tool = createReportToolIssueTool(createToolSession(), ["read"]);
			await tool.execute("call-win", {
				tool: "read",
				report: "failed reading C:\\Users\\Will\\repo and c:/users/will/docs",
			});

			const db = openAutoQaDb();
			if (!db) throw new Error("Expected isolated autoqa.db");
			const rows = db.prepare("SELECT report FROM grievances ORDER BY id DESC LIMIT 1").all() as Array<{
				report: string;
			}>;
			expect(rows[0]?.report).toBe("failed reading ~\\repo and ~/docs");
		} finally {
			homeSpy.mockRestore();
			userSpy.mockRestore();
		}
	});

	it("rewrites only home for root and preserves root@host / com.root.app", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue("/root");
		const userSpy = spyOn(os, "userInfo").mockReturnValue({
			username: "root",
			uid: 0,
			gid: 0,
			shell: "/bin/sh",
			homedir: "/root",
		});
		try {
			const tool = createReportToolIssueTool(createToolSession(), ["bash"]);
			await tool.execute("call-root", {
				tool: "bash",
				report: "read /root/config.yml via root@host for com.root.app",
			});

			const db = openAutoQaDb();
			if (!db) throw new Error("Expected isolated autoqa.db");
			const rows = db.prepare("SELECT report FROM grievances ORDER BY id DESC LIMIT 1").all() as Array<{
				report: string;
			}>;
			expect(rows[0]?.report).toBe("read ~/config.yml via root@host for com.root.app");
		} finally {
			homeSpy.mockRestore();
			userSpy.mockRestore();
		}
	});

	it("redacts older pre-stored raw rows outbound at the flush boundary alongside the secret sanitizer", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue("/Users/will");
		const userSpy = spyOn(os, "userInfo").mockReturnValue({
			username: "will",
			uid: 501,
			gid: 20,
			shell: "/bin/zsh",
			homedir: "/Users/will",
		});
		const db = createThrowawayDb("legacy-flush.db");
		try {
			db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
				"claude",
				"1.0.0",
				"bash",
				"legacy /Users/will/secret will@host TOKEN_XYZ",
			);
			const settings = Settings.isolated();
			settings.set("dev.autoqa", true);
			settings.set("dev.autoqaPush.enabled", true);
			settings.set("dev.autoqaPush.endpoint", "https://collector.example.test/grievances");

			let capturedBody = "";
			const mockFetch: FetchImpl = async (_input, init) => {
				capturedBody = String(init?.body ?? "");
				return new Response("", { status: 200 });
			};

			const result = await flushGrievances(db, settings, {
				forceUpload: true,
				resolveSanitizer: () => text => text.replaceAll("TOKEN_XYZ", "[REDACTED_SECRET]"),
				fetch: mockFetch,
			});

			expect(result).toEqual({ pushed: 1, ok: true });
			const parsed = JSON.parse(capturedBody) as { entries: Array<{ report: string }> };
			expect(parsed.entries[0]?.report).toBe("legacy ~/secret <user>@host [REDACTED_SECRET]");
		} finally {
			db.close();
			homeSpy.mockRestore();
			userSpy.mockRestore();
		}
	});
	it("sanitizes nested keys and values in outbound payloads and leaves local rows unmutated on flush", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue("/Users/will");
		const userSpy = spyOn(os, "userInfo").mockReturnValue({
			username: "will",
			uid: 501,
			gid: 20,
			shell: "/bin/zsh",
			homedir: "/Users/will",
		});
		const db = createThrowawayDb("nested-and-row-flush.db");
		try {
			const nestedKey = "/Users/will/config/TOKEN_XYZ";
			const nestedValue = { "TOKEN_XYZ@build-host": "com.will.agent TOKEN_XYZ will test bin/node" };
			const sanitized = sanitizeAutoQaPayload({ [nestedKey]: [nestedValue] }, text =>
				text.replaceAll("TOKEN_XYZ", "[REDACTED_SECRET]"),
			);
			expect(JSON.stringify(sanitized)).toBe(
				JSON.stringify({
					"/Users/will/config/[REDACTED_SECRET]": [
						{ "[REDACTED_SECRET]@build-host": "com.will.agent [REDACTED_SECRET] will test bin/node" },
					],
				}),
			);

			const rawReport = '{"/Users/will/app":"will@build-host"} com.will.agent TOKEN_XYZ will test bin/node';
			db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
				"claude",
				"1.0.0",
				"/Users/will/bin/bash",
				rawReport,
			);
			const settings = Settings.isolated();
			settings.set("dev.autoqa", true);
			settings.set("dev.autoqaPush.enabled", true);
			settings.set("dev.autoqaPush.endpoint", "https://collector.example.test/grievances");

			let capturedBody = "";
			const mockFetch: FetchImpl = async (_input, init) => {
				capturedBody = String(init?.body ?? "");
				return new Response("", { status: 200 });
			};

			const result = await flushGrievances(db, settings, {
				forceUpload: true,
				resolveSanitizer: () => text => text.replaceAll("TOKEN_XYZ", "[REDACTED_SECRET]"),
				fetch: mockFetch,
			});

			expect(result).toEqual({ pushed: 1, ok: true });
			const parsed = JSON.parse(capturedBody) as { entries: Array<{ tool: string; report: string }> };
			expect(parsed.entries[0]?.tool).toBe("~/bin/bash");
			expect(parsed.entries[0]?.report).toBe(
				'{"~/app":"<user>@build-host"} com.<user>.agent [REDACTED_SECRET] will test bin/node',
			);
			const localRow = db.prepare("SELECT report FROM grievances LIMIT 1").get() as { report: string };
			expect(localRow.report).toBe(rawReport);
		} finally {
			db.close();
			homeSpy.mockRestore();
			userSpy.mockRestore();
		}
	});
});
