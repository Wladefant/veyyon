/**
 * WHY: on 2026-10-03 the host died with `EPERM: operation not permitted, watch` as an uncaught
 * exception. Windows reports a watched path that is deleted or locked as an ASYNC `error` event on the
 * `fs.FSWatcher`, and an EventEmitter with no `error` listener rethrows it, which ends the process and
 * every session in it. A watcher here only buys live refresh, so its failure has to cost exactly that.
 *
 * CLASS CLOSED: every shipped `fs.watch` site (the git HEAD watcher in the status line, the custom
 * theme watcher, the provider in-flight waiter) is driven for real; each must survive an emitted `error`,
 * warn through the logger and close its watcher. The source sweep fails when a new `.watch(` call
 * appears in shipped TypeScript until it is added to `DRIVEN_SITES` and driven below.
 *
 * WHAT IT DOES NOT CATCH: it emits the error on a real watcher instead of provoking the OS to do it
 * (deleting a watched directory only yields EPERM on Windows), and the sweep is lexical, so an aliased
 * `watch` import from `node:fs` would escape it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { __providerInFlightForTesting, configureProviderMaxInFlightRequests, streamSimple } from "@veyyon/ai/stream";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { StatusLineSettings } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import { StatusPresentationProducer } from "@veyyon/coding-agent/presentation/status-producer";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme, isThemeWatcherActive, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { getCustomThemesDir, logger, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { statusLineSessionParts } from "./helpers/status-line-session";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Every shipped file that creates an FSWatcher, relative to the repo root. Pinned by exact equality. */
const DRIVEN_SITES = [
	"packages/ai/src/stream.ts",
	"packages/coding-agent/src/modes/terminal/components/status-line/component.ts",
	"packages/coding-agent/src/theme/theme.ts",
];

const WATCH_CALL = /\b(?:fs|fsSync)\.watch\(|(?<![\w.])watch\(/;

function shippedSourceFiles(): string[] {
	const roots = ["packages", "hosts", "kernel", "plugins", "apps", "clients", "contracts"];
	const found: string[] = [];
	for (const root of roots) {
		const base = path.join(REPO_ROOT, root);
		if (!fs.existsSync(base)) continue;
		for (const rel of new Bun.Glob("**/src/**/*.{ts,tsx}").scanSync({ cwd: base })) {
			if (rel.includes("node_modules")) continue;
			found.push(path.join(root, rel).replaceAll("\\", "/"));
		}
	}
	return found;
}

const eperm = (): NodeJS.ErrnoException =>
	Object.assign(new Error("EPERM: operation not permitted, watch"), {
		code: "EPERM",
		syscall: "watch",
		errno: -4048,
	});

let created: fs.FSWatcher[];
let warnings: string[];

beforeEach(() => {
	created = [];
	warnings = [];
	const realWatch = fs.watch;
	vi.spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
		const watcher = realWatch(...args);
		created.push(watcher);
		return watcher;
	}) as typeof fs.watch);
	vi.spyOn(logger, "warn").mockImplementation((message: string) => {
		warnings.push(message);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The assertion every site shares: the error is absorbed, reported, and the watcher is closed. */
function expectFailureAbsorbed(watcher: fs.FSWatcher): void {
	let closes = 0;
	const realClose = watcher.close.bind(watcher);
	watcher.close = (() => {
		closes += 1;
		realClose();
	}) as typeof watcher.close;
	expect(() => watcher.emit("error", eperm())).not.toThrow();
	expect(closes).toBeGreaterThan(0);
	expect(warnings.length).toBeGreaterThan(0);
}

describe("a watcher that fails after it started", () => {
	it("leaves the status line alive and stops watching git state", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-watch-repo-"));
		try {
			execFileSync("git", ["init", "-q", repo], { timeout: 30_000 });
			const parts = {
				...statusLineSessionParts({ sessionName: "watch", messages: [], cwd: () => repo }),
				state: { messages: [], model: undefined },
				model: undefined,
				getAsyncJobSnapshot: () => ({ running: [] }),
			};
			const settings: StatusLineSettings = {
				preset: "custom",
				leftSegments: ["git"],
				rightSegments: ["session_name"],
			};
			const component = new StatusLineComponent(new StatusPresentationProducer(parts as unknown as AgentSession));
			component.updateSettings(settings);
			component.watchGitState(() => {});
			expect(created).toHaveLength(1);

			expectFailureAbsorbed(created[0] as fs.FSWatcher);

			component.dispose();
		} finally {
			resetSettingsForTest();
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	describe("on the custom theme directory", () => {
		let dirOverrides: DirOverridesSnapshot;
		let agentDir: string;

		beforeEach(() => {
			dirOverrides = captureDirOverrides();
			agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-watch-theme-"));
			setAgentDir(agentDir);
			fs.mkdirSync(getCustomThemesDir(), { recursive: true });
		});

		afterEach(() => {
			stopThemeWatcher();
			restoreDirOverrides(dirOverrides);
			fs.rmSync(agentDir, { recursive: true, force: true });
		});

		it("leaves the theme in place and stops watching", async () => {
			const dark = fs.readFileSync(path.join(import.meta.dirname, "../src/theme/dark.json"), "utf8");
			fs.writeFileSync(path.join(getCustomThemesDir(), "mytheme.json"), dark);
			await setTheme("mytheme", true);
			expect(isThemeWatcherActive()).toBe(true);
			const watcher = created.at(-1) as fs.FSWatcher;

			expectFailureAbsorbed(watcher);

			expect(isThemeWatcherActive()).toBe(false);
		});
	});

	describe("on the provider in-flight directory", () => {
		let limiterRoot: string;

		beforeEach(() => {
			limiterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-watch-inflight-"));
			__providerInFlightForTesting.setRoot(limiterRoot);
		});

		afterEach(() => {
			clearCustomApis();
			configureProviderMaxInFlightRequests(undefined);
			__providerInFlightForTesting.setRoot(undefined);
			fs.rmSync(limiterRoot, { recursive: true, force: true });
		});

		it("lets the queued request run once the slot frees", async () => {
			registerMockApi();
			const firstStarted = Promise.withResolvers<void>();
			const releaseFirst = Promise.withResolvers<void>();
			let call = 0;
			const mock = createMockModel({
				provider: "tests",
				handler: async () => {
					call++;
					if (call === 1) {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
					return { content: [`reply ${call}`] };
				},
			});
			const ctx = { systemPrompt: [], messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
			const first = streamSimple(mock.model, ctx, { maxInFlightRequests: { tests: 1 } });
			const firstResult = first.result();
			await firstStarted.promise;
			const second = streamSimple(mock.model, ctx, { maxInFlightRequests: { tests: 1 } });
			const secondResult = second.result();
			// Yield to the event loop until the queued request has attached its watcher.
			for (let turn = 0; turn < 1_000 && created.length === 0; turn++) {
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			expect(created.length).toBeGreaterThan(0);

			expectFailureAbsorbed(created.at(-1) as fs.FSWatcher);

			releaseFirst.resolve();
			await firstResult;
			const message = await secondResult;
			expect(message.content).toEqual([{ type: "text", text: "reply 2" }]);
		});
	});
});

describe("every shipped watcher site", () => {
	it("is one this suite drives, so a new watcher cannot ship without an error handler", () => {
		const sites = shippedSourceFiles()
			.filter(file => WATCH_CALL.test(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")))
			.sort();
		expect(sites).toEqual(DRIVEN_SITES);
	});
});
