/**
 * The one place tests build a `ToolSession`.
 *
 * `ToolSession` requires exactly three members (`cwd`, `hasUI`,
 * `getSessionFile`); everything else on it is optional. Despite that, 46 test
 * files hand-rolled their own stub and forced it through with
 * `as unknown as ToolSession`. That double cast is not just unnecessary, it is
 * actively harmful in two ways:
 *
 * 1. It switches off checking of the optional members the stub DOES set. A
 *    misspelled `hasEditTool` or a `getSessionId` returning the wrong type is
 *    accepted silently as an excess property, so the stub configures nothing
 *    and the test passes for the wrong reason.
 * 2. It makes the stub structurally unrelated to the interface, so the stub can
 *    never fail to keep up with it. That is exactly how the print-mode suite
 *    rotted: a method was added to the consumer, the cast hid that the stub
 *    lacked it, and four tests died at runtime instead of at build time.
 *
 * Use this helper instead. It is typed, so an unknown key or a wrong signature
 * is a build error at the call site, and a new required member on `ToolSession`
 * is a single failure here rather than 46 silent stubs that no longer match.
 */
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import type { ToolSession } from "@veyyon/coding-agent/tools/index";
import { getAgentDir } from "@veyyon/utils";

/**
 * A stand-in for `Settings` that answers the few keys a test names.
 *
 * A key the stub answers `undefined` reads as its declared default, as it would
 * from the real store, so code that relies on the typed read never sees a value
 * the store cannot serve. A test that needs the whole store, including its
 * handling of a stored value of the wrong kind, passes `Settings.isolated(...)`.
 */
export type SettingsStub = { get(path: string): unknown } & Partial<Omit<Settings, "get">>;

/** Overrides accepted by {@link makeToolSession}. Fully checked except `settings`. */
export type ToolSessionOverrides = Omit<Partial<ToolSession>, "settings"> & { settings?: SettingsStub };

/**
 * Build a `ToolSession` for a test, overriding only what the test cares about.
 *
 * The defaults are the inert ones: the current directory, no UI, no session
 * file, no spawns, and every setting at its declared default from the
 * process-booted profile directory. A test that depends on any of these states it
 * explicitly.
 *
 * `getAgentDir` is part of that default because a tool loader may need to know
 * WHICH profile the session loaded from, not only what a setting says: `ssh`
 * reads it to scope `ssh.json`. A stub that answers `get` alone left every such
 * loader throwing `getAgentDir is not a function` from inside the tool.
 */
export function makeToolSession(overrides: ToolSessionOverrides = {}): ToolSession {
	const { settings, ...rest } = overrides;
	if (settings instanceof Settings) return { ...inertSession(), settings, ...rest };
	const resolved: SettingsStub = settings ?? { get: () => undefined };
	const answer = resolved.get.bind(resolved);
	resolved.get = path => {
		const value = answer(path);
		return value === undefined && Object.hasOwn(SETTINGS_SCHEMA, path)
			? declaredDefaults().get(path as SettingPath)
			: value;
	};
	resolved.getAgentDir ??= () => getAgentDir();
	return { ...inertSession(), settings: resolved as Settings, ...rest };
}

/** The members every test session starts from, `settings` aside. */
function inertSession(): Omit<ToolSession, "settings"> {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

let defaults: Settings | undefined;

/** One empty store, read for the declared default of every key a stub leaves unanswered. */
function declaredDefaults(): Settings {
	defaults ??= Settings.isolated();
	return defaults;
}
