import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	SessionScope,
	type SessionScopeHost,
	type SessionScopeStore,
} from "@veyyon/coding-agent/session/runtime/session-scope";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { useTrackedTempDirFactory } from "./helpers/tracked-temp-dir";

useIsolatedGlobalSettings();

const makeTempDir = useTrackedTempDirFactory();

function createScopeHost(sessionStore: SessionScopeStore, isSpawned = false): SessionScopeHost {
	return {
		sessionStore,
		settings: Settings.isolated(),
		agent: { appendMessage: () => {} },
		isSpawned,
		refreshSecrets: async () => {}, refreshSshTool: async () => {}, refreshBaseSystemPrompt: async () => {},
		rootWireAt: () => {}, emitCwdChanged: () => {},
	};
}

function createToolSession(sessionManager: SessionManager, scope: SessionScope): ToolSession {
	return {
		get cwd() {
			return sessionManager.getCwd();
		},
		setCwd: (resolvedPath, cwdOptions) => scope.setCwd(resolvedPath, cwdOptions),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
	const texts: string[] = [];
	for (const item of result.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") {
			texts.push(item.text);
		}
	}
	return texts.join("\n");
}

describe("SessionScope concurrent cwd and process isolation", () => {
	it("resolves repeated relative cwd changes across concurrent non-spawned scopes while process.cwd stays unchanged", async () => {
		const initialProcessCwd = process.cwd();
		const dirA = makeTempDir("scope-a-");
		const dirB = makeTempDir("scope-b-");

		const a1 = path.join(dirA, "a1");
		const a2 = path.join(a1, "a2");
		const a3 = path.join(dirA, "a3");
		fs.mkdirSync(a2, { recursive: true });
		fs.mkdirSync(a3, { recursive: true });

		const b1 = path.join(dirB, "b1");
		const b2 = path.join(b1, "b2");
		fs.mkdirSync(b2, { recursive: true });

		const managerA = SessionManager.inMemory(dirA);
		const managerB = SessionManager.inMemory(dirB);
		const scopeA = new SessionScope(createScopeHost(managerA, false));
		const scopeB = new SessionScope(createScopeHost(managerB, false));

		await scopeA.setCwd("a1", { validate: true });
		expect(managerA.getCwd()).toBe(path.resolve(a1));
		expect(managerB.getCwd()).toBe(path.resolve(dirB));
		expect(process.cwd()).toBe(initialProcessCwd);

		await scopeB.setCwd("b1", { validate: true });
		expect(managerB.getCwd()).toBe(path.resolve(b1));
		expect(managerA.getCwd()).toBe(path.resolve(a1));
		expect(process.cwd()).toBe(initialProcessCwd);

		await scopeA.setCwd("a2", { validate: true });
		expect(managerA.getCwd()).toBe(path.resolve(a2));
		expect(managerB.getCwd()).toBe(path.resolve(b1));
		expect(process.cwd()).toBe(initialProcessCwd);

		await scopeA.setCwd("../../a3", { validate: true });
		expect(managerA.getCwd()).toBe(path.resolve(a3));
		expect(managerB.getCwd()).toBe(path.resolve(b1));
		expect(process.cwd()).toBe(initialProcessCwd);

		await scopeB.setCwd("b2", { validate: true });
		expect(managerB.getCwd()).toBe(path.resolve(b2));
		expect(managerA.getCwd()).toBe(path.resolve(a3));
		expect(process.cwd()).toBe(initialProcessCwd);
	});

	it("keeps two overlapping transitions scoped while one prompt refresh is blocked", async () => {
		const initialProcessCwd = process.cwd();
		const dirA = makeTempDir("overlap-a-");
		const dirB = makeTempDir("overlap-b-");
		const destA = path.join(dirA, "destination");
		const destB = path.join(dirB, "destination");
		fs.mkdirSync(destA);
		fs.mkdirSync(destB);
		const managerA = SessionManager.inMemory(dirA);
		const managerB = SessionManager.inMemory(dirB);
		const hostA = createScopeHost(managerA);
		const hostB = createScopeHost(managerB);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		hostA.refreshBaseSystemPrompt = async () => {
			entered.resolve();
			await release.promise;
			expect(managerA.getCwd()).toBe(destA);
		};
		hostB.refreshBaseSystemPrompt = async () => {
			expect(managerB.getCwd()).toBe(destB);
			expect(managerA.getCwd()).toBe(destA);
		};
		const scopeA = new SessionScope(hostA);
		const scopeB = new SessionScope(hostB);
		const transitionA = scopeA.setCwd("destination", { validate: true });
		try {
			await Promise.race([entered.promise, transitionA.then(() => {
				throw new Error("Transition A completed before the overlap barrier");
			})]);
			await scopeB.setCwd("destination", { validate: true });
			expect(managerA.getCwd()).toBe(destA);
			expect(managerB.getCwd()).toBe(destB);
			expect(process.cwd()).toBe(initialProcessCwd);
		} finally {
			release.resolve();
			await transitionA;
		}
		expect(process.cwd()).toBe(initialProcessCwd);
	});

	it("resolves relative files via ReadTool independently across concurrent scopes during setCwd", async () => {
		const initialProcessCwd = process.cwd();
		const dirA = makeTempDir("read-a-");
		const dirB = makeTempDir("read-b-");

		const subA = path.join(dirA, "subA");
		fs.mkdirSync(subA, { recursive: true });
		fs.writeFileSync(path.join(dirA, "item.txt"), "alpha root");
		fs.writeFileSync(path.join(subA, "item.txt"), "alpha sub");

		const subB = path.join(dirB, "subB");
		fs.mkdirSync(subB, { recursive: true });
		fs.writeFileSync(path.join(dirB, "item.txt"), "beta root");
		fs.writeFileSync(path.join(subB, "item.txt"), "beta sub");

		const managerA = SessionManager.inMemory(dirA);
		const managerB = SessionManager.inMemory(dirB);
		const scopeA = new SessionScope(createScopeHost(managerA, false));
		const scopeB = new SessionScope(createScopeHost(managerB, false));

		const sessionA = createToolSession(managerA, scopeA);
		const sessionB = createToolSession(managerB, scopeB);
		const readA = new ReadTool(sessionA);
		const readB = new ReadTool(sessionB);

		const resA1 = await readA.execute("r1", { path: "item.txt" });
		expect(extractText(resA1)).toContain("alpha root");
		const resB1 = await readB.execute("r2", { path: "item.txt" });
		expect(extractText(resB1)).toContain("beta root");

		await scopeA.setCwd("subA", { validate: true });
		expect(sessionA.cwd).toBe(path.resolve(subA));
		expect(sessionB.cwd).toBe(path.resolve(dirB));
		expect(process.cwd()).toBe(initialProcessCwd);

		const resA2 = await readA.execute("r3", { path: "item.txt" });
		expect(extractText(resA2)).toContain("alpha sub");
		const resB2 = await readB.execute("r4", { path: "item.txt" });
		expect(extractText(resB2)).toContain("beta root");

		await scopeB.setCwd("subB", { validate: true });
		expect(sessionB.cwd).toBe(path.resolve(subB));
		expect(sessionA.cwd).toBe(path.resolve(subA));
		expect(process.cwd()).toBe(initialProcessCwd);

		const resB3 = await readB.execute("r5", { path: "item.txt" });
		expect(extractText(resB3)).toContain("beta sub");
		const resA3 = await readA.execute("r6", { path: "item.txt" });
		expect(extractText(resA3)).toContain("alpha sub");
	});

	it("executes BashTool commands with independent relative cwd resolution across concurrent scopes", async () => {
		const initialProcessCwd = process.cwd();
		const dirA = makeTempDir("bash-a-");
		const dirB = makeTempDir("bash-b-");

		const subA = path.join(dirA, "subA");
		const subB = path.join(dirB, "subB");
		fs.mkdirSync(subA, { recursive: true });
		fs.mkdirSync(subB, { recursive: true });

		const managerA = SessionManager.inMemory(dirA);
		const managerB = SessionManager.inMemory(dirB);
		const scopeA = new SessionScope(createScopeHost(managerA, false));
		const scopeB = new SessionScope(createScopeHost(managerB, false));

		const sessionA = createToolSession(managerA, scopeA);
		const sessionB = createToolSession(managerB, scopeB);
		const bashA = new BashTool(sessionA);
		const bashB = new BashTool(sessionB);

		const cmd = `node -p "process.cwd()"`;

		const resA1 = await bashA.execute("b1", { command: cmd });
		expect(extractText(resA1).trim()).toBe(path.resolve(dirA));
		const resB1 = await bashB.execute("b2", { command: cmd });
		expect(extractText(resB1).trim()).toBe(path.resolve(dirB));

		const resA_sub = await bashA.execute("b3", { command: cmd, cwd: "subA" });
		expect(extractText(resA_sub).trim()).toBe(path.resolve(subA));
		const resB_sub = await bashB.execute("b4", { command: cmd, cwd: "subB" });
		expect(extractText(resB_sub).trim()).toBe(path.resolve(subB));
		expect(process.cwd()).toBe(initialProcessCwd);

		await scopeA.setCwd("subA", { validate: true });
		expect(sessionA.cwd).toBe(path.resolve(subA));
		expect(sessionB.cwd).toBe(path.resolve(dirB));
		expect(process.cwd()).toBe(initialProcessCwd);

		const resA2 = await bashA.execute("b5", { command: cmd });
		expect(extractText(resA2).trim()).toBe(path.resolve(subA));
		const resB2 = await bashB.execute("b6", { command: cmd });
		expect(extractText(resB2).trim()).toBe(path.resolve(dirB));
		expect(process.cwd()).toBe(initialProcessCwd);
	});
});
