/** A missing per-session numeric ID must never become another session's evidence. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { ArtifactProtocolHandler } from "../artifact-protocol";
import { resetRegisteredArtifactDirsForTests } from "../registry-helpers";
import { InternalUrlRouter } from "../router";
import type { InternalUrl, ResolveContext } from "../types";

const url = (value: string): InternalUrl => new URL(value) as InternalUrl;

describe("artifact recovery stays with its session", () => {
	let temp: TempDir;
	let a: SessionManager;
	let b: SessionManager;
	let handler: ArtifactProtocolHandler;
	let context: ResolveContext;
	let sharedId: string;
	let bOnlyId: string;

	async function owner(name: string): Promise<SessionManager> {
		const manager = SessionManager.create(temp.path(), temp.join(name));
		manager.appendMessage({ role: "user", content: name, timestamp: 0 });
		manager.appendMessage({
			role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture",
			content: [{ type: "text", text: "Persist owner" }], stopReason: "stop", timestamp: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		await manager.flush();
		AgentRegistry.global().register({ id: name, displayName: name, kind: "main", scope: manager.getSessionId(),
			session: { sessionManager: manager } as AgentSession, sessionFile: manager.getSessionFile() ?? null });
		return manager;
	}

	beforeEach(async () => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		temp = TempDir.createSync("@veyyon-artifact-owner-");
		a = await owner("OwnerA");
		b = await owner("OwnerB");
		sharedId = (await a.saveArtifact("source A", "fixture"))!;
		expect(await b.saveArtifact("source B", "fixture")).toBe(sharedId);
		bOnlyId = (await b.saveArtifact("only source B", "fixture"))!;
		handler = new ArtifactProtocolHandler();
		context = { localProtocolOptions: { getArtifactsDir: () => a.getArtifactsDir(), getSessionId: () => a.getSessionId() } };
	});

	afterEach(async () => {
		await a.close(); await b.close();
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests(); resetRegisteredArtifactDirsForTests();
		await temp.remove();
	});

	it("binds a bare ID to the caller and refuses fallback when that owner lacks the ID", async () => {
		expect((await handler.resolve(url(`artifact://${sharedId}`), context)).content).toBe("source A");
		await expect(handler.resolve(url(`artifact://${bOnlyId}`), context)).rejects.toThrow("selected owner");
		const metadata = await handler.resolve(url(`artifact://${bOnlyId}?view=metadata`), context);
		expect(JSON.parse(metadata.content)).toMatchObject({ version: 1, status: "missing", sessionId: a.getSessionId() });
	});

	it("an explicit execution session disambiguates a colliding ID without changing caller context", async () => {
		await expect(handler.resolve(url(`artifact://${sharedId}`))).rejects.toThrow("ambiguous");
		const scoped = url(`artifact://${sharedId}?session=${b.getSessionId()}`);
		expect((await handler.resolve(scoped, context)).content).toBe("source B");
		const pathOnly = await handler.resolve(scoped, { ...context, pathOnly: true });
		expect(pathOnly.content).toBe("");
		expect(pathOnly.sourcePath).toBe(await b.getArtifactPath(sharedId));
		expect((await handler.resolve(url(`artifact://${sharedId}`), context)).content).toBe("source A");
	});

	it("dispatches an explicitly scoped URL through the router without changing caller context", async () => {
		const scoped = `artifact://${sharedId}?session=${b.getSessionId()}`;
		expect((await InternalUrlRouter.instance().resolve(scoped, context)).content).toBe("source B");
		expect((await InternalUrlRouter.instance().resolve(`artifact://${sharedId}`, context)).content).toBe("source A");
	});

	it("preserves structured recovery envelopes and legacy shake text byte for byte", async () => {
		const structured = JSON.stringify({ version: 1, operation: "drop-images", branchLeafId: "leaf",
			entries: [{ id: "entry", message: { content: [{ type: "image", data: "ZXhhY3Q=", mimeType: "image/png" }] } }] });
		for (const bytes of [structured, "### region 1 (read)\r\n\r\n  exact\tΩ 😀\r\n"]) {
			const id = await b.saveArtifact(bytes, "recovery");
			const resource = await handler.resolve(url(`artifact://${id}?session=${b.getSessionId()}`), context);
			expect(resource.content).toBe(bytes);
		}
	});

	it("reports missing owners and duplicate files as unavailable and ambiguous", async () => {
		const unknown = await handler.resolve(url(`artifact://${sharedId}?session=unknown-session&view=metadata`), context);
		expect(JSON.parse(unknown.content).status).toBe("unavailable");
		const dir = b.getArtifactsDir();
		if (!dir) throw new Error("Expected owner artifact store");
		await fs.writeFile(path.join(dir, `${sharedId}.duplicate.txt`), "duplicate");
		const duplicate = await handler.resolve(url(`artifact://${sharedId}?session=${b.getSessionId()}&view=metadata`));
		expect(JSON.parse(duplicate.content).status).toBe("ambiguous");
	});

	it("metadata remains bounded for oversized artifacts while path-only access is available", async () => {
		const artifactPath = await b.getArtifactPath(bOnlyId);
		if (!artifactPath) throw new Error("Expected artifact path");
		const file = await fs.open(artifactPath, "r+");
		try { await file.truncate(8 * 1024 * 1024 + 1); } finally { await file.close(); }
		const base = `artifact://${bOnlyId}?session=${b.getSessionId()}`;
		const metadata = await handler.resolve(url(`${base}&view=metadata`), context);
		expect(JSON.parse(metadata.content)).toMatchObject({ status: "available", inlineAvailable: false, size: 8 * 1024 * 1024 + 1 });
		await expect(handler.resolve(url(base), context)).rejects.toThrow("full internal resolution is blocked");
		expect((await handler.resolve(url(base), { ...context, pathOnly: true })).sourcePath).toBe(artifactPath);
	});

	it("rejects malformed and duplicated selectors", async () => {
		for (const query of ["session=", "session=../escape", "session=a&session=b", "view=unknown", "view=metadata&view=metadata"]) {
			await expect(handler.resolve(url(`artifact://${sharedId}?${query}`), context)).rejects.toThrow();
		}
	});
});
