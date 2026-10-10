import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const loader = fileURLToPath(new URL("../src/extensibility/extensions/loader.ts", import.meta.url));
const registry = fileURLToPath(new URL("../src/discovery/capability/index.ts", import.meta.url));
const capability = fileURLToPath(new URL("../src/discovery/capability/extension-module.ts", import.meta.url));

function child(script: string) {
	const { env, cleanup } = hermeticSpawnEnv({ VEYYON_TIMING: "", VEYYON_PROFILE: "default" });
	try {
		return spawnSync(process.execPath, ["--eval", script], {
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
			env,
		});
	} finally {
		cleanup();
	}
}

describe("automatic extension discovery owns its pending work", () => {
	it("collects a provider result even when its async completion owns no event-loop handle", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-discovery-lifetime-"));
		try {
			const extension = path.join(root, "delayed-extension.ts");
			const script = `
				import { discoverExtensionPaths } from ${JSON.stringify(loader)};
				import { registerProvider } from ${JSON.stringify(registry)};
				import { extensionModuleCapability } from ${JSON.stringify(capability)};
				registerProvider(extensionModuleCapability.id, {
					id: "native", displayName: "Delayed native discovery", description: "Lifetime regression", priority: 1000,
					load: () => {
						const { promise, resolve } = Promise.withResolvers();
						// This subprocess must exercise real unref/exit semantics. Fake timers cannot make a process exit.
						setTimeout(() => resolve({ items: [{ name: "delayed-extension", path: ${JSON.stringify(extension)}, level: "user",
							_source: { provider: "native", path: ${JSON.stringify(extension)}, level: "user" } }], warnings: [] }), 250).unref();
						return promise;
					},
				});
				discoverExtensionPaths([], ${JSON.stringify(root)}, undefined, ${JSON.stringify(root)})
					.then(paths => console.log(JSON.stringify(paths)));
			`;
			const result = child(script);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(extension.replaceAll("\\", "\\\\"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports an unexpected beforeExit during an unfinished CLI command", () => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = child(`
			import { awaitCliCompletion } from ${JSON.stringify(cli)};
			const { promise, resolve } = Promise.withResolvers();
			awaitCliCompletion(promise);
			process.emit("beforeExit", 0);
			resolve();
		`);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("event loop ended before the command finished");
	});

	it("owns unfinished CLI work before and after extension discovery", () => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = child(`
			import { awaitCliCompletion } from ${JSON.stringify(cli)};
			const { promise, resolve } = Promise.withResolvers();
			// Real subprocess liveness is the contract; fake timers cannot exercise process exit.
			setTimeout(() => resolve(), 250).unref();
			awaitCliCompletion(promise).then(() => console.log("command completed"));
		`);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("command completed");
		expect(result.stderr).toBe("");
	});

	it("does not report a completed command as an unfinished startup", () => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = child(`
			import { awaitCliCompletion } from ${JSON.stringify(cli)};
			awaitCliCompletion(Promise.resolve());
		`);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});
