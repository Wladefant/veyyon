/**
 * WHY: the provider registry loads every OAuth login lazily, so a launch or a chat turn carries no login
 * code. The Kimi chat client, the OpenAI-compatible client and the Kimi usage probe took their request
 * headers from the Kimi login module, `registry/oauth/kimi.ts`, and that one static import put the login,
 * its device-flow poller and the success page on the reach of every request and of the compaction engine.
 * The headers now come from `utils/kimi-headers.ts`.
 *
 * Class closed: every module under `providers/` and `usage/`, enumerated from the directories at run time,
 * reaches no module under `registry/oauth/`. A new request client or usage probe that imports a login
 * module for one helper fails here and names the login it reached.
 *
 * Not caught: a request client that reaches login code through a module outside `registry/oauth/`, and a
 * login module's cost that arrives through some other caller of the request clients.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { packageModuleReach } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");
const { reachedNames } = packageModuleReach(REPO_ROOT, SRC);

/** Where the login flows are defined, as `reachedNames` spells a reached module. */
const LOGIN_DIR = path.join("packages", "ai", "src", "registry", "oauth") + path.sep;

/** Every TypeScript module under `dir`, relative to `src/`. */
function modulesUnder(dir: string): string[] {
	return fs
		.readdirSync(path.join(SRC, dir), { recursive: true, encoding: "utf8" })
		.filter(name => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.includes("__tests__"))
		.map(name => path.join(dir, name))
		.sort();
}

const REQUEST_CLIENTS = [...modulesUnder("providers"), ...modulesUnder("usage")];

function loginsReachedBy(relative: string): string[] {
	return reachedNames(relative).filter(name => name.startsWith(LOGIN_DIR));
}

describe("a request client loads no login flow", () => {
	it("no provider client or usage probe reaches a module under registry/oauth", () => {
		const reaching = Object.fromEntries(
			REQUEST_CLIENTS.map(relative => [relative, loginsReachedBy(relative)] as const).filter(
				([, logins]) => logins.length > 0,
			),
		);

		expect(reaching).toEqual({});
	});

	/**
	 * NON-VACUITY: the sweep enumerated the clients this suite names, the walk resolved their imports, and
	 * the detector recognizes a login module when one is reached.
	 */
	it("sweeps the Kimi clients and would see a login they reached", () => {
		expect(REQUEST_CLIENTS).toContain(path.join("providers", "kimi.ts"));
		expect(REQUEST_CLIENTS).toContain(path.join("providers", "openai-completions.ts"));
		expect(REQUEST_CLIENTS).toContain(path.join("usage", "kimi.ts"));
		expect(reachedNames(path.join("providers", "kimi.ts"))).toContain(
			path.join("packages", "ai", "src", "utils", "kimi-headers.ts"),
		);
		expect(loginsReachedBy(path.join("registry", "oauth", "kimi.ts"))).toContain(`${LOGIN_DIR}kimi.ts`);
	});
});
