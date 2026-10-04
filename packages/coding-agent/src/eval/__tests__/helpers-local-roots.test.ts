import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils/temp";
import { createHelpers, type HelperContext } from "../js/shared/helpers";

/**
 * The eval helpers (`read`/`write`) must substitute injected on-disk
 * roots for internal-URL schemes. Without it, `write("local://x.md")` hits a
 * stdlib `path.resolve` that collapses `local://` to `local:/`, creating a junk
 * `local:` directory under the cwd instead of landing where `read local://x.md`
 * resolves. These lock the substitution contract and its guards.
 */
function makeCtx(
	cwd: string,
	roots: Record<string, string>,
	opts?: { emitStatus?: (status: Record<string, unknown>) => void; env?: Map<string, string> },
): HelperContext {
	return {
		cwd: () => cwd,
		env: opts?.env ?? new Map(),
		localRoots: () => roots,
		emitStatus: opts?.emitStatus ?? (() => {}),
		session: () => ({ artifactsDir: null, sessionId: "test" }),
	};
}

describe("eval js helpers internal-url resolution", () => {
	it("writes and reads local:// under the injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-local-");
		const root = path.join(tmp.path(), "local");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: root }));

		const written = await helpers.writeFile("local://notes/merge-map.md", "hello");
		expect(written).toBe(path.join(root, "notes", "merge-map.md"));
		expect(await Bun.file(written).text()).toBe("hello");
		expect(await helpers.read("local://notes/merge-map.md")).toBe("hello");

		// Regression: no literal `local:` directory created under the cwd.
		expect(await Bun.file(path.join(tmp.path(), "local:")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmp.path(), "local:", "notes", "merge-map.md")).exists()).toBe(false);
	});

	it("rejects traversal and schemes without an injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-guard-");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: path.join(tmp.path(), "local") }));

		await expect(helpers.writeFile("local://../escape.md", "x")).rejects.toThrow(/traversal|escapes/i);
		await expect(helpers.writeFile("memory://x.md", "x")).rejects.toThrow(/not supported/i);
		await expect(helpers.read("https://example.com/page")).rejects.toThrow(/not supported/i);
	});

	it("leaves plain relative and absolute paths resolving against the cwd", async () => {
		using tmp = TempDir.createSync("@eval-helpers-plain-");
		const helpers = createHelpers(makeCtx(tmp.path(), {}));

		const rel = await helpers.writeFile("foo/bar.txt", "bar");
		expect(rel).toBe(path.join(tmp.path(), "foo", "bar.txt"));
		expect(await helpers.read("foo/bar.txt")).toBe("bar");
	});
});

describe("eval js helpers env get/set", () => {
	it("emits status events excluding seeded opaque secret while returning actual value unchanged", () => {
		using tmp = TempDir.createSync("@eval-helpers-env-");
		const events: Array<Record<string, unknown>> = [];
		const helpers = createHelpers(makeCtx(tmp.path(), {}, { emitStatus: status => events.push(status) }));

		const secretValue = "seeded-opaque-env-secret-js-9876";
		const secretKey = "TEST_OPAQUE_SECRET_ENV_JS";

		const setRet = helpers.env(secretKey, secretValue);
		const getRet = helpers.env(secretKey);

		// Actual env returns unchanged
		expect(setRet).toBe(secretValue);
		expect(getRet).toBe(secretValue);

		// Captured status events exclude seeded opaque secret
		const serializedEvents = JSON.stringify(events);
		expect(serializedEvents).not.toContain(secretValue);

		// Status events preserve key and action metadata without value field
		const setEvent = events.find(e => e.op === "env" && e.action === "set");
		expect(setEvent).toBeDefined();
		expect(setEvent?.key).toBe(secretKey);
		expect(setEvent?.value).toBe("<redacted>");

		const getEvent = events.find(e => e.op === "env" && e.action === "get");
		expect(getEvent).toBeDefined();
		expect(getEvent?.key).toBe(secretKey);
		expect(getEvent?.value).toBe("<redacted>");
	});
});
