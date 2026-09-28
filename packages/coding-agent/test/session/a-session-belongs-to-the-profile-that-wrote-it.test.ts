/**
 * A session belongs to the profile that wrote it. Resuming it by id or path continues it in that
 * profile; a launch pinned to another profile with `--profile` forks it into the pinned one; nothing
 * writes one profile's transcript under another profile's settings.
 *
 * WHY THIS SUITE EXISTS. The session listing resolves an id from every profile, and a match from a
 * profile other than the active one came back as an ordinary global match. With the profile pinned,
 * `--resume <id>` then opened the other profile's file in place and kept appending to it under the
 * pinned profile's settings and credentials, and the in-session `/resume <id>` did the same. Before
 * that, a resume from another directory forked the session into whatever profile the launch started
 * in, which put a copy of one profile's work in another.
 *
 * THE CLASS THIS CLOSES is a resume path that crosses a profile boundary without saying so. Every
 * owner/pinned pair of three profiles is swept through the real resolver, the real
 * `createSessionManager` (by id prefix and by file path) and the real `/resume` handler. The
 * negative controls: a session resumed from its own profile opens in place, and an id nobody wrote
 * still misses.
 *
 * The same sweep covers the two paths that reach a session without naming it: `--continue`, which
 * follows the terminal's breadcrumb (a pre-isolation build wrote crumbs naming another profile's
 * transcript), and the relaunched child's directory resolution, which inherits the parent profile's
 * `VEYYON_CODING_AGENT_DIR` beside the owner's `VEYYON_PROFILE`.
 *
 * WHAT IT DOES NOT CATCH: the startup profile switch for an unpinned launch, which
 * `a-resumed-session-continues-in-its-own-profile.test.ts` covers, and the spawn itself: the child
 * is modeled by resolving directories from the environment the relaunch hands it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createSessionManager } from "@veyyon/coding-agent/main";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { resolveResumableSession } from "@veyyon/kernel/session/session-listing";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	__resetDirsFromEnvForTests,
	captureDirOverrides,
	type DirOverridesSnapshot,
	getAgentDir,
	getTerminalSessionsDir,
	listProfiles,
	pathIsWithin,
	restoreDirOverrides,
	setProfile,
} from "@veyyon/utils/dirs";
import { getTerminalId } from "@veyyon/utils/ttyid";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { makeAssistantMessage } from "../session-manager/helpers";

const PROFILES = ["default", "oss", "work"] as const;
type ProfileName = (typeof PROFILES)[number];

interface SeededSession {
	id: string;
	file: string;
	cwd: string;
	bytes: Buffer;
}

let isolated: IsolatedConfigRoot;
let snapshot: DirOverridesSnapshot;
let launchCwd: string;
const seeded = new Map<ProfileName, SeededSession>();

function activate(profile: ProfileName): void {
	setProfile(profile === "default" ? undefined : profile);
}

function seededFor(profile: ProfileName): SeededSession {
	const session = seeded.get(profile);
	if (!session) throw new Error(`no session seeded for ${profile}`);
	return session;
}

/** Every owner/pinned pair where the session belongs to a profile other than the active one. */
function crossProfilePairs(): { owner: ProfileName; active: ProfileName }[] {
	return PROFILES.flatMap(owner => PROFILES.filter(active => active !== owner).map(active => ({ owner, active })));
}

beforeEach(async () => {
	snapshot = captureDirOverrides();
	isolated = enterIsolatedConfigRoot("session-profile-ownership", { defaultProfile: true });
	launchCwd = path.join(isolated.root, "launch");
	fs.mkdirSync(launchCwd, { recursive: true });
	seeded.clear();
	for (const profile of PROFILES) {
		const cwd = path.join(isolated.root, `project-${profile}`);
		fs.mkdirSync(cwd, { recursive: true });
		const dir = path.join(isolated.root, "profiles", profile, "agent", "sessions", "-project");
		const manager = SessionManager.create(cwd, dir);
		manager.appendMessage({ role: "user", content: `a turn in ${profile}`, timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error(`session for ${profile} was not persisted`);
		seeded.set(profile, { id: manager.getSessionId(), file, cwd, bytes: fs.readFileSync(file) });
		await manager.close();
	}
	// The seeded layout is the one the resolver lists, or every assertion below is vacuous.
	expect(listProfiles().map(entry => entry.name)).toEqual([...PROFILES]);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	isolated.restore();
	restoreDirOverrides(snapshot);
});

describe("the session listing", () => {
	it("tags a match from another profile with its owner and a match from the active one without", async () => {
		const wrong: string[] = [];
		for (const active of PROFILES) {
			activate(active);
			for (const owner of PROFILES) {
				const { id, file } = seededFor(owner);
				const match = await resolveResumableSession(id, launchCwd);
				const expected = owner === active ? "global" : `profile:${owner}`;
				const actual = match ? (match.scope === "profile" ? `profile:${match.profile}` : match.scope) : "missing";
				if (actual !== expected || match?.session.path !== file) {
					wrong.push(`${active} resolving ${owner}'s session: ${actual} at ${match?.session.path}`);
				}
			}
		}
		expect(wrong).toEqual([]);
	});

	it("still reports an id nobody wrote as missing", async () => {
		activate("work");
		expect(await resolveResumableSession("019000ff-dead-7000-8000-000000000000", launchCwd)).toBeUndefined();
	});
});

describe("a launch pinned to one profile resuming another profile's session", () => {
	for (const spelling of ["id", "file path"] as const) {
		it(`forks it into the pinned profile at its recorded directory, by ${spelling}`, async () => {
			for (const { owner, active } of crossProfilePairs()) {
				activate(active);
				const source = seededFor(owner);
				const arg = spelling === "id" ? source.id : source.file;
				const manager = await createSessionManager(parseArgs(["--resume", arg]), launchCwd, Settings.isolated({}));
				if (!manager) throw new Error(`${active} resuming ${owner}'s session built no session`);
				const label = `${active} resuming ${owner}'s session by ${spelling}`;
				try {
					expect(pathIsWithin(path.join(getAgentDir(), "sessions"), manager.getSessionFile() ?? ""), label).toBe(
						true,
					);
					expect(manager.getSessionId(), label).not.toBe(source.id);
					expect(manager.getHeader()?.parentSession, label).toBe(source.id);
					expect(manager.getCwd(), label).toBe(path.resolve(source.cwd));
					const carried = manager
						.getEntries()
						.some(
							entry =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								entry.message.content === `a turn in ${owner}`,
						);
					expect(carried, `${label} carries the source history`).toBe(true);
				} finally {
					await manager.close();
				}
				expect(fs.readFileSync(source.file).equals(source.bytes), `${label} leaves the source untouched`).toBe(
					true,
				);
			}
		});
	}

	it("forks at the launch directory when the recorded one is gone", async () => {
		activate("work");
		const source = seededFor("oss");
		fs.rmSync(source.cwd, { recursive: true, force: true });
		const manager = await createSessionManager(parseArgs(["--resume", source.id]), launchCwd, Settings.isolated({}));
		if (!manager) throw new Error("the fork built no session");
		try {
			expect(manager.getCwd()).toBe(path.resolve(launchCwd));
			expect(manager.getHeader()?.parentSession).toBe(source.id);
		} finally {
			await manager.close();
		}
	});

	/** NEGATIVE CONTROL: a session resumed from its own profile is the same transcript, not a copy. */
	it("opens a session from its own profile in place", async () => {
		for (const profile of PROFILES) {
			activate(profile);
			const source = seededFor(profile);
			const manager = await createSessionManager(
				parseArgs(["--resume", source.id]),
				launchCwd,
				Settings.isolated({}),
			);
			if (!manager) throw new Error(`${profile} resuming its own session built no session`);
			try {
				expect(manager.getSessionFile()).toBe(source.file);
				expect(manager.getSessionId()).toBe(source.id);
			} finally {
				await manager.close();
			}
		}
	});
});

describe("/resume <id> for another profile's session", () => {
	it("relaunches in the owning profile instead of opening it here", async () => {
		for (const { owner, active } of crossProfilePairs()) {
			activate(active);
			const source = seededFor(owner);
			const requestRelaunch = vi.fn();
			const shutdown = vi.fn(async () => {});
			const handleResumeSession = vi.fn(async () => {});
			const ctx = {
				editor: { setText: vi.fn() },
				sessionManager: { getCwd: () => launchCwd, getSessionDir: () => launchCwd },
				requestRelaunch,
				shutdown,
				handleResumeSession,
				showStatus: vi.fn(),
				showError: vi.fn(),
			} as unknown as InteractiveModeContext;

			await executeBuiltinSlashCommand(`/resume ${source.id}`, { ctx });

			const label = `${active} running /resume for ${owner}'s session`;
			expect(handleResumeSession, label).not.toHaveBeenCalled();
			expect(requestRelaunch, label).toHaveBeenCalledTimes(1);
			const [spec] = requestRelaunch.mock.calls[0] ?? [];
			expect(spec?.argv.slice(-2), label).toEqual(["--resume", source.id]);
			expect(spec?.env, label).toEqual({ VEYYON_PROFILE: owner });
			expect(shutdown, label).toHaveBeenCalledTimes(1);
		}
	});
});

describe("--continue with a terminal breadcrumb naming another profile's session", () => {
	const originalTmuxPane = process.env.TMUX_PANE;
	beforeEach(() => {
		process.env.TMUX_PANE = "%profile-ownership";
	});
	afterEach(() => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
	});

	function writeBreadcrumb(cwd: string, sessionFile: string): void {
		const terminalId = getTerminalId();
		if (!terminalId) throw new Error("expected a terminal id");
		fs.mkdirSync(getTerminalSessionsDir(), { recursive: true });
		fs.writeFileSync(path.join(getTerminalSessionsDir(), terminalId), `${cwd}\n${sessionFile}\n`);
	}

	it("neither continues nor relocates the other profile's transcript", async () => {
		for (const { owner, active } of crossProfilePairs()) {
			const source = seededFor(owner);
			// The crumb's cwd both matching the launch and gone: the second is the moved-project branch,
			// which relocates the breadcrumb's file into the launch directory's bucket.
			for (const crumbCwd of [launchCwd, path.join(isolated.root, "gone")]) {
				activate(active);
				writeBreadcrumb(crumbCwd, source.file);
				const manager = await SessionManager.continueRecent(launchCwd);
				const label = `${active} continuing with a crumb for ${owner} (cwd ${path.basename(crumbCwd)})`;
				expect(manager.getSessionId(), label).not.toBe(source.id);
				await manager.close();
				expect(fs.readFileSync(source.file).equals(source.bytes), label).toBe(true);
			}
		}
	});

	it("follows a breadcrumb naming the active profile's own session", async () => {
		for (const profile of PROFILES) {
			activate(profile);
			const own = seededFor(profile);
			writeBreadcrumb(launchCwd, own.file);
			const manager = await SessionManager.continueRecent(launchCwd);
			expect(manager.getSessionId(), profile).toBe(own.id);
			await manager.close();
		}
	});
});

describe("the child a cross-profile relaunch starts", () => {
	it("resolves the owning profile's agent dir, not the parent's", () => {
		for (const { owner, active } of crossProfilePairs()) {
			activate(active);
			// The relaunch spreads the parent's environment, which carries the parent profile's
			// VEYYON_CODING_AGENT_DIR, under the owner's VEYYON_PROFILE (`default` from `/resume`,
			// empty from `/profile default`).
			for (const profileEnv of owner === "default" ? ["default", ""] : [owner]) {
				process.env.VEYYON_PROFILE = profileEnv;
				__resetDirsFromEnvForTests();
				const label = `${active} relaunching into ${owner} (VEYYON_PROFILE=${JSON.stringify(profileEnv)})`;
				expect(getAgentDir(), label).toBe(path.join(isolated.root, "profiles", owner, "agent"));
				activate(active);
			}
		}
	});
});
