/**
 * WHY: these HTTP clients armed their deadline with the built-in abort-signal timeout. That
 * timer is native and cannot be cleared, so it stayed armed after the request finished and
 * fired later, setting an abort reason on a signal nobody held any more. A leaked abort of
 * that kind crashed Bun's concurrent GC (`JSAbortSignal::visitAdditionalChildren`), which is
 * why `scopedTimeoutSignal` and `withScopedTimeoutSignal` exist.
 *
 * THE CLASS: a request deadline that outlives its request, or that ends before the body it
 * bounds has been read. Every case below holds three properties:
 *   1. A request whose headers never arrive fails at the deadline and not one millisecond
 *      earlier. Under fake timers this is observable only for a JavaScript timer, so a
 *      deadline moved back to the native abort-signal timeout never fires here and fails.
 *   2. A response whose body never finishes fails at the same deadline, so the deadline
 *      covers the body read and is not cancelled once the headers arrive.
 *   3. A request that finishes leaves no timer armed.
 *
 * What this does not catch: a new HTTP client written with its own native timeout. The table
 * lists the clients converted here; it is not derived from the source.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as updateCli from "@veyyon/coding-agent/cli/update-cli";
import { createSmitheryCliAuthSession } from "@veyyon/coding-agent/mcp/smithery-auth";
import { searchSmitheryRegistry } from "@veyyon/coding-agent/mcp/smithery-registry";
import { HindsightApi } from "@veyyon/coding-agent/memory/hindsight/client";
import { TempDir } from "@veyyon/utils";
import { releaseRedirect } from "./helpers/release-redirect";

interface DeadlineCase {
	name: string;
	deadlineMs: number;
	/** What a request whose headers never arrive fails with. */
	headerTimeout: RegExp;
	/** Whether the client reads a body, so a stalled body is bounded by the same deadline. */
	readsBody: boolean;
	run(dir: TempDir): Promise<unknown>;
	/** The request this case stalls; every other request is answered by `answer`. */
	stalls(url: string): boolean;
	answer(url: string): Response;
}

const SEARCH_ENTRY = {
	id: "srv_1",
	namespace: "smithery-ai",
	slug: "filesystem",
	qualifiedName: "@smithery-ai/filesystem",
	displayName: "Filesystem",
	description: "File access",
	useCount: 1,
};

const SERVER_DETAILS = {
	qualifiedName: "@smithery-ai/filesystem",
	displayName: "Filesystem",
	description: "File access",
	connections: [{ type: "http", deploymentUrl: "https://mcp.example" }],
	tools: [],
};

function smitheryAnswer(url: string): Response {
	return url.includes("?") ? Response.json({ servers: [SEARCH_ENTRY] }) : Response.json(SERVER_DETAILS);
}

const CASES: DeadlineCase[] = [
	{
		name: "the latest-release check",
		deadlineMs: 5_000,
		headerTimeout: /Timed out fetching release info after 5s/,
		readsBody: false,
		run: () => updateCli.getLatestRelease(5_000),
		stalls: () => true,
		answer: () => releaseRedirect("v9.9.9"),
	},
	{
		name: "the release-list walk",
		deadlineMs: 5_000,
		headerTimeout: /Timed out fetching the release list after 5s/,
		readsBody: true,
		run: () => updateCli.getAllReleases(5_000),
		stalls: () => true,
		answer: () => Response.json([]),
	},
	{
		name: "the checksum sidecar",
		deadlineMs: 30_000,
		headerTimeout: /Timed out fetching the published checksum/,
		readsBody: true,
		run: async dir => {
			const file = dir.join("veyyon");
			await fs.writeFile(file, "binary");
			return updateCli.verifyDownloadChecksum(file, "https://releases.example/veyyon.sha256");
		},
		stalls: () => true,
		answer: () => new Response(`${"0".repeat(64)}  veyyon`),
	},
	{
		name: "the release binary download",
		deadlineMs: 15 * 60_000,
		headerTimeout: /Timed out downloading release binary after 15 minutes/,
		readsBody: true,
		run: async dir => {
			const target = dir.join("veyyon");
			await fs.writeFile(target, "installed");
			return updateCli.updateViaBinaryAt(target, "9.9.9", () => {});
		},
		stalls: url => !url.endsWith(".sha256"),
		answer: url => (url.endsWith(".sha256") ? new Response("missing", { status: 404 }) : new Response("binary")),
	},
	{
		name: "the Smithery login session",
		deadlineMs: 10_000,
		headerTimeout: /timed out/,
		readsBody: true,
		run: () => createSmitheryCliAuthSession(),
		stalls: () => true,
		answer: () => Response.json({ sessionId: "session-1", authUrl: "https://smithery.example/authorize" }),
	},
	{
		name: "the Smithery registry search",
		deadlineMs: 10_000,
		headerTimeout: /did not answer this search within 10s/,
		readsBody: true,
		run: () => searchSmitheryRegistry("filesystem", { limit: 1 }),
		stalls: url => url.includes("?"),
		answer: smitheryAnswer,
	},
	{
		name: "the Smithery server details",
		deadlineMs: 10_000,
		headerTimeout: /timed out/,
		readsBody: true,
		run: () => searchSmitheryRegistry("filesystem", { limit: 1 }),
		stalls: url => !url.includes("?"),
		answer: smitheryAnswer,
	},
	{
		name: "a Hindsight request",
		deadlineMs: 30_000,
		headerTimeout: /listMemories request timed out after 30s/,
		readsBody: true,
		run: () => new HindsightApi({ baseUrl: "https://hindsight.example" }).listMemories("bank"),
		stalls: () => true,
		answer: () => Response.json({ items: [] }),
	},
];

type Stall = "headers" | "body" | "none";

/**
 * Route every fetch through `testCase`: the stalled request either never answers or answers
 * with a body that never ends, and each ends only when the signal it was handed aborts, as a
 * real connection does. `stalled` resolves with that signal once the stalled request goes
 * out, or for a stalled body once the client starts reading it; `requested` lists every URL
 * fetched.
 */
function stubFetch(testCase: DeadlineCase, stall: Stall): { stalled: Promise<AbortSignal>; requested: string[] } {
	const stalled = Promise.withResolvers<AbortSignal>();
	const requested: string[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		requested.push(url);
		if (stall === "none" || !testCase.stalls(url)) return testCase.answer(url);
		const signal = init?.signal;
		if (!signal) throw new Error(`${url} was requested without a deadline signal`);
		if (stall === "headers") {
			stalled.resolve(signal);
			const headers = Promise.withResolvers<Response>();
			signal.addEventListener("abort", () => headers.reject(signal.reason), { once: true });
			return headers.promise;
		}
		// A zero high-water mark defers `pull` to the client's first read, so the stall is
		// reported only once the client is reading the body it has to bound.
		const body = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
				},
				pull() {
					stalled.resolve(signal);
					return Promise.withResolvers<void>().promise;
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { headers: { "content-type": "application/json" } });
	};
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect: globalThis.fetch.preconnect }));
	return { stalled: stalled.promise, requested };
}

describe("an HTTP deadline ends a stalled request and leaves no timer armed", () => {
	let dir: TempDir;

	beforeEach(() => {
		dir = TempDir.createSync("@veyyon-http-deadline-");
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await dir.remove();
	});

	for (const testCase of CASES) {
		const stalls: Stall[] = testCase.readsBody ? ["headers", "body"] : ["headers"];
		for (const stall of stalls) {
			it(`ends ${testCase.name} whose ${stall} never arrive at its deadline`, async () => {
				const { stalled } = stubFetch(testCase, stall);
				const outcome = testCase.run(dir).then(
					() => undefined,
					(error: unknown) => error,
				);
				const signal = await stalled;

				vi.advanceTimersByTime(testCase.deadlineMs - 1);
				expect(signal.aborted).toBe(false);
				vi.advanceTimersByTime(1);
				expect(signal.aborted).toBe(true);

				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				if (stall === "headers") expect((error as Error).message).toMatch(testCase.headerTimeout);
				expect(vi.getTimerCount()).toBe(0);
			});
		}

		it(`leaves no timer armed once ${testCase.name} finishes`, async () => {
			const { requested } = stubFetch(testCase, "none");

			await testCase.run(dir).catch(() => undefined);

			expect(requested.length).toBeGreaterThan(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	}
});
