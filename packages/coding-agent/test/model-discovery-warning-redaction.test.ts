import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { logger } from "@veyyon/utils";

describe("ModelRegistry discovery warning redaction", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let originalOllamaBaseUrl: string | undefined;
	let originalOllamaHost: string | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-discovery-redact-"));
		originalOllamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
		originalOllamaHost = Bun.env.OLLAMA_HOST;
		delete Bun.env.OLLAMA_BASE_URL;
		delete Bun.env.OLLAMA_HOST;
		Settings.isolated();
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
		if (originalOllamaBaseUrl === undefined) delete Bun.env.OLLAMA_BASE_URL;
		else Bun.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
		if (originalOllamaHost === undefined) delete Bun.env.OLLAMA_HOST;
		else Bun.env.OLLAMA_HOST = originalOllamaHost;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("redacts URL userinfo and query credentials from logger.warn url and error fields", async () => {
		if (!authStorage) throw new Error("authStorage missing");
		Bun.env.OLLAMA_BASE_URL = "http://reviewer:topsecret@ollama.typo:11434?apiKey=secret123";
		const warnSpy = spyOn(logger, "warn");
		const failingFetch: FetchImpl = async input => {
			throw new Error(`EHOSTUNREACH: connect failed ${String(input)}`);
		};
		try {
			const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { fetch: failingFetch });
			await registry.refresh();

			const discoveryCalls = warnSpy.mock.calls.filter(call => call[0] === "model discovery failed for provider");
			expect(discoveryCalls.length).toBeGreaterThan(0);
			const payload = JSON.stringify(discoveryCalls[0]?.[1] ?? {});
			expect(payload).toContain("ollama.typo:11434");
			expect(payload).toContain("EHOSTUNREACH");
			expect(payload).not.toContain("topsecret");
			expect(payload).not.toContain("reviewer");
			expect(payload).not.toContain("secret123");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("redacts URL userinfo from logger.debug url and error fields on loopback refusal", async () => {
		if (!authStorage) throw new Error("authStorage missing");
		Bun.env.OLLAMA_BASE_URL = "http://reviewer:topsecret@127.0.0.1:11434";
		const debugSpy = spyOn(logger, "debug");
		const refusedFetch: FetchImpl = async input => {
			throw new Error(`ECONNREFUSED: connect failed ${String(input)}`);
		};
		try {
			const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { fetch: refusedFetch });
			await registry.refresh();

			const discoveryCalls = debugSpy.mock.calls.filter(call => call[0] === "model discovery failed for provider");
			expect(discoveryCalls.length).toBeGreaterThan(0);
			const payload = JSON.stringify(discoveryCalls[0]?.[1] ?? {});
			expect(payload).toContain("127.0.0.1:11434");
			expect(payload).toContain("ECONNREFUSED");
			expect(payload).not.toContain("topsecret");
			expect(payload).not.toContain("reviewer");
		} finally {
			debugSpy.mockRestore();
		}
	});
});
