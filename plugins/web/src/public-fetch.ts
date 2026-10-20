import { isIP } from "node:net";
import { parseHTML } from "linkedom";
import { createNodePublicFetchTransport, type PublicFetchTransport } from "./public-fetch-transport";

/**
 * Bounded public HTTPS fetch for a trusted caller.
 *
 * WHY: a URL that a user or a model supplies can name an internal host, a
 * metadata address, or a public name whose DNS answer or redirect lands on a
 * private address (server-side request forgery). A fetch that reads without
 * limit, or waits without a deadline, turns one request into memory use or a
 * stalled session. This module closes both defect classes in one place:
 * literals are refused before DNS, every DNS answer is vetted before one
 * address is chosen, every redirect hop repeats the vetting, every read is
 * capped, and one deadline covers admission, DNS, headers and body. The
 * deadline races the work, so a dependency that ignores its abort signal
 * still settles the call.
 *
 * Admission is required. The caller supplies the quota object; this module
 * only states the request and refuses any answer that is not a live grant.
 *
 * LIMITATIONS:
 * - The transport pins the first vetted address for the dial. Address changes
 *   between vetting and dialing are closed only by that pinning.
 * - The non-global IPv4 and IPv6 lists are fixed copies of the IANA
 *   special-purpose registries. A new special range needs an edit here.
 * - Names in private-only namespaces that are not in `LOCAL_SUFFIXES` are
 *   refused only when their DNS answer is non-public.
 * - The deadline cannot interrupt synchronous CPU work. Parsing a 2 MiB
 *   document with linkedom blocks the event loop until it finishes.
 * - Accepted charsets are utf-8 and us-ascii. Bytes above 0x7F in a body
 *   labelled us-ascii decode as U+FFFD.
 * - Only identity content encoding is accepted.
 * - Readable HTML text keeps line breaks at block tags. It drops links,
 *   tables and images, and it does not keep the document title.
 * - Truncation is reported by the `truncated` flag only. The text carries no
 *   marker.
 */

export interface PublicFetchAdmissionRequest {
	userId: string;
	scope: "fetch:public";
	limits: { perMinute: number; perMonth: number };
}

export interface PublicFetchAdmissionDecision {
	allowed: boolean;
	/** Epoch milliseconds after which the grant no longer covers an upstream request. */
	expiresAt: number;
}

/** Reserves quota for one public fetch. The counter behind it belongs to the caller. */
export interface PublicFetchAdmission {
	reserve(request: PublicFetchAdmissionRequest): Promise<PublicFetchAdmissionDecision>;
}

export interface PublicFetchDeps {
	admission: PublicFetchAdmission;
	/** Defaults to the pinned Node TLS transport. */
	transport?: PublicFetchTransport;
	/** Whole-call deadline in milliseconds. Above 0 and at most 15000. Defaults to 15000. */
	timeoutMs?: number;
}

export interface PublicFetchResult {
	/** The URL that produced the body, after any redirects. */
	url: string;
	/** The media type without parameters, for example `text/html`. */
	contentType: string;
	/** Readable text for HTML. The decoded body for the other accepted types. At most 256 KiB of UTF-8. */
	text: string;
	/** True when the body passed the 2 MiB read cap or the text passed the 256 KiB output cap. */
	truncated: boolean;
}

export interface PublicFetchService {
	fetchPublic(userId: string, url: string): Promise<PublicFetchResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const ACCEPTED_TYPES: Record<string, true> = {
	"text/html": true,
	"text/plain": true,
	"application/json": true,
	"application/rss+xml": true,
	"application/atom+xml": true,
};
const ACCEPTED_CHARSETS: Record<string, true> = { "utf-8": true, "us-ascii": true };
/** Host suffixes that name the local machine or a private network, refused before DNS. */
const LOCAL_SUFFIXES: readonly string[] = ["localhost", "localdomain", "local", "internal", "home.arpa"];
const SKIPPED_TAGS: Record<string, true> = { SCRIPT: true, STYLE: true, TEMPLATE: true };
const BLOCK_TAGS: Record<string, true> = {
	ADDRESS: true,
	ARTICLE: true,
	ASIDE: true,
	BLOCKQUOTE: true,
	BR: true,
	DD: true,
	DIV: true,
	DL: true,
	DT: true,
	FIGCAPTION: true,
	FIGURE: true,
	FOOTER: true,
	H1: true,
	H2: true,
	H3: true,
	H4: true,
	H5: true,
	H6: true,
	HEADER: true,
	HR: true,
	LI: true,
	MAIN: true,
	NAV: true,
	OL: true,
	P: true,
	PRE: true,
	SECTION: true,
	TABLE: true,
	TR: true,
	UL: true,
};
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_ENCODER = new TextEncoder();

/** Non-global IPv4 ranges as a base address and a prefix length. Any address outside them is global. */
const NON_GLOBAL_IPV4: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];
const NON_GLOBAL_IPV4_BLOCKS = NON_GLOBAL_IPV4.map(([base, prefix]) => ({
	base: ipv4Value(base),
	shift: 32 - prefix,
}));

/**
 * Builds the public fetch service. The admission object is required and every
 * call reserves quota through it before any DNS query or dial.
 */
export function createPublicFetchService(deps: PublicFetchDeps): PublicFetchService {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!(timeoutMs > 0 && timeoutMs <= DEFAULT_TIMEOUT_MS)) {
		throw new Error(`public fetch timeout must be above 0 and at most ${DEFAULT_TIMEOUT_MS} ms`);
	}
	const transport = deps.transport ?? createNodePublicFetchTransport();
	const admission: PublicFetchAdmission | undefined = deps.admission;
	return {
		fetchPublic: async (userId, url) => {
			if (userId === "") throw new Error("public fetch needs a user id");
			const first = parseTarget(url);
			return withDeadline(timeoutMs, async (signal) => {
				const admittedUntil = await admit(admission, userId);
				return followRedirects(transport, first, admittedUntil, signal);
			});
		},
	};
}

/** Runs `run` under one deadline. The race settles the call even when `run` never honours its signal. */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const error = new Error(`public fetch exceeded its ${ms} ms deadline`);
		controller.abort(error);
		deadline.reject(error);
	}, ms);
	try {
		return await Promise.race([run(controller.signal), deadline.promise]);
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** Reserves quota and returns the grant's expiry. Every failure here stops the call before any upstream request. */
async function admit(admission: PublicFetchAdmission | undefined, userId: string): Promise<number> {
	if (!admission || typeof admission.reserve !== "function") {
		throw new Error("public fetch admission is unavailable");
	}
	let decision: PublicFetchAdmissionDecision;
	try {
		decision = await admission.reserve({
			userId,
			scope: "fetch:public",
			limits: { perMinute: 10, perMonth: 1000 },
		});
	} catch {
		throw new Error("public fetch admission is unavailable");
	}
	if (decision?.allowed !== true) throw new Error("public fetch admission was denied");
	assertLive(decision.expiresAt);
	return decision.expiresAt;
}

/** Fails closed when the grant has run out, or when its expiry is not a number. */
function assertLive(expiresAt: number): void {
	if (!(expiresAt > Date.now())) throw new Error("public fetch admission has expired");
}

/** Vets and dials each hop. Every hop repeats DNS vetting, so a redirect to a private name is refused. */
async function followRedirects(
	transport: PublicFetchTransport,
	first: URL,
	admittedUntil: number,
	signal: AbortSignal,
): Promise<PublicFetchResult> {
	let url = first;
	for (let redirects = 0; ; redirects++) {
		assertLive(admittedUntil);
		const address = await vetDns(transport, url, signal);
		const response = await transport.get(url, address, signal);
		if (REDIRECT_STATUSES[response.status] !== true) return readAccepted(response, url);
		// Not awaited, so a stalled cancel cannot hold the call.
		response.body?.cancel().catch(() => undefined);
		if (redirects === MAX_REDIRECTS) throw new Error(`public fetch stopped after ${MAX_REDIRECTS} redirects`);
		url = redirectTarget(response, url);
	}
}

/** Resolves the host and refuses the whole answer when any address is not global. Returns the first address. */
async function vetDns(transport: PublicFetchTransport, url: URL, signal: AbortSignal): Promise<string> {
	const addresses = await transport.resolve(url.hostname, signal);
	const [address] = addresses;
	if (address === undefined) throw new Error(`public fetch found no address for ${url.hostname}`);
	for (const candidate of addresses) {
		if (!isGlobalAddress(candidate)) {
			throw new Error(`public fetch refuses ${url.hostname}: it resolves to a non-public address`);
		}
	}
	return address;
}

function redirectTarget(response: Response, from: URL): URL {
	const location = response.headers.get("location");
	if (location === null || location.trim() === "") {
		throw new Error("public fetch got a redirect without a Location header");
	}
	return parseTarget(location.trim(), from);
}

/** Validates the response head, then reads a capped body and extracts its text. */
async function readAccepted(response: Response, url: URL): Promise<PublicFetchResult> {
	let mime: string;
	try {
		mime = acceptHead(response);
	} catch (error) {
		response.body?.cancel().catch(() => undefined);
		throw error;
	}
	const body = await readBounded(response.body, MAX_RESPONSE_BYTES);
	const decoded = UTF8_DECODER.decode(body.bytes);
	const extracted = mime === "text/html" ? readableText(decoded) : decoded;
	const capped = capUtf8(extracted, MAX_OUTPUT_BYTES);
	return {
		url: url.href,
		contentType: mime,
		text: capped.text,
		truncated: body.truncated || capped.truncated,
	};
}

/** Accepts a 2xx response with identity encoding, an accepted media type and an accepted charset. Returns the media type. */
function acceptHead(response: Response): string {
	if (response.status < 200 || response.status > 299) {
		throw new Error(`public fetch got HTTP status ${response.status}`);
	}
	const encoding = response.headers.get("content-encoding");
	if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
		throw new Error(`public fetch refuses content-encoding ${encoding.trim()}`);
	}
	return acceptContentType(response.headers.get("content-type"));
}

function acceptContentType(value: string | null): string {
	if (value === null) throw new Error("public fetch needs a Content-Type header");
	const [essence = "", ...params] = value.split(";");
	const mime = essence.trim().toLowerCase();
	if (ACCEPTED_TYPES[mime] !== true) throw new Error(`public fetch refuses content type ${mime}`);
	let charset: string | undefined;
	for (const param of params) {
		const equals = param.indexOf("=");
		if (equals < 0 || param.slice(0, equals).trim().toLowerCase() !== "charset") continue;
		if (charset !== undefined) throw new Error("public fetch refuses a repeated charset");
		charset = param
			.slice(equals + 1)
			.trim()
			.replace(/^"(.*)"$/, "$1")
			.toLowerCase();
	}
	if (charset !== undefined && ACCEPTED_CHARSETS[charset] !== true) {
		throw new Error(`public fetch refuses charset ${charset}`);
	}
	return mime;
}

/**
 * Reads at most `limit` bytes. The reader is cancelled without being awaited,
 * so a stalled cancel cannot hold the call after the cap is reached or a read fails.
 */
async function readBounded(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (body === null) return { bytes: new Uint8Array(0), truncated: false };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const room = limit - total;
			if (value.byteLength > room) {
				chunks.push(value.subarray(0, room));
				total = limit;
				truncated = true;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/** Cuts `text` to at most `limit` UTF-8 bytes at a character boundary, so no code point is split. */
function capUtf8(text: string, limit: number): { text: string; truncated: boolean } {
	// A UTF-16 unit encodes to at most three UTF-8 bytes, so a short string fits without encoding.
	if (text.length * 3 <= limit) return { text, truncated: false };
	const bytes = UTF8_ENCODER.encode(text);
	if (bytes.byteLength <= limit) return { text, truncated: false };
	let end = limit;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: UTF8_DECODER.decode(bytes.subarray(0, end)), truncated: true };
}

interface HtmlNode {
	nodeType: number;
	nodeValue?: string | null;
	tagName?: string;
	childNodes?: ArrayLike<HtmlNode>;
}

interface HtmlDocument {
	body: HtmlNode | null;
}

/**
 * Collects the text of `<body>` without `script`, `style` or `template`. Block
 * tags add a line break on each side. The walk uses an explicit stack, so a deeply
 * nested document cannot exhaust the call stack.
 */
function readableText(html: string): string {
	const document: HtmlDocument = parseHTML(html).document;
	if (!document.body) return "";
	const out: string[] = [];
	const stack: Array<HtmlNode | string> = [document.body];
	for (;;) {
		const item = stack.pop();
		if (item === undefined) break;
		if (typeof item === "string") {
			out.push(item);
			continue;
		}
		if (item.nodeType === TEXT_NODE) {
			out.push(item.nodeValue ?? "");
			continue;
		}
		if (item.nodeType !== ELEMENT_NODE) continue;
		const tag = (item.tagName ?? "").toUpperCase();
		if (SKIPPED_TAGS[tag] === true) continue;
		const block = BLOCK_TAGS[tag] === true;
		if (block) stack.push("\n");
		const children = Array.from(item.childNodes ?? []);
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
		if (block) stack.push("\n");
	}
	return out
		.join("")
		.replace(/[ \t\f\r]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Parses an absolute URL or one relative to `base`, and refuses anything the pinned connection cannot honour. */
function parseTarget(input: string, base?: URL): URL {
	let url: URL;
	try {
		url = new URL(input, base);
	} catch {
		throw new Error("public fetch needs an absolute URL");
	}
	if (url.protocol !== "https:") throw new Error("public fetch accepts only https URLs");
	if (url.username !== "" || url.password !== "") throw new Error("public fetch refuses URLs with credentials");
	if (url.port !== "") throw new Error("public fetch connects only to port 443");
	refuseHost(url.hostname);
	return url;
}

/** Refuses IP literals and names that cannot be a public DNS name. Runs before any DNS query. */
function refuseHost(hostname: string): void {
	const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
	if (isIP(literal) !== 0) {
		if (!isGlobalAddress(literal)) throw new Error("public fetch refuses a non-public address literal");
		throw new Error("public fetch needs a DNS name, not an IP literal");
	}
	const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
	const local = LOCAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
	if (!name.includes(".") || local) throw new Error(`public fetch refuses host ${hostname}`);
}

function isGlobalAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isGlobalIPv4(address);
	if (family === 6) return isGlobalIPv6(address);
	return false;
}

function ipv4Value(address: string): number {
	return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function isGlobalIPv4(address: string): boolean {
	const value = ipv4Value(address);
	return NON_GLOBAL_IPV4_BLOCKS.every(({ base, shift }) => value >>> shift !== base >>> shift);
}

/**
 * Global unicast is 2000::/3. Inside it, the IANA special allocations that are
 * not routable on the public internet are refused: 2001::/23, 2001:db8::/32,
 * 2002::/16 (6to4) and 3fff::/20 (documentation). Mapped, compatible, NAT64 and
 * ULA addresses sit outside 2000::/3 and are refused by the first check.
 */
function isGlobalIPv6(address: string): boolean {
	const [g0 = 0, g1 = 0] = ipv6Groups(address);
	if ((g0 & 0xe000) !== 0x2000) return false;
	if (g0 === 0x2001 && g1 < 0x0200) return false;
	if (g0 === 0x2001 && g1 === 0x0db8) return false;
	if (g0 === 0x2002) return false;
	if (g0 === 0x3fff && g1 < 0x1000) return false;
	return true;
}

/** Expands a valid IPv6 literal, including an embedded IPv4 tail, to its eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
	let text = address;
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (tail) {
		const v4 = ipv4Value(tail[1]);
		text = `${text.slice(0, tail.index)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const [left = "", right = ""] = text.split("::");
	const leftGroups = left === "" ? [] : left.split(":");
	const rightGroups = right === "" ? [] : right.split(":");
	const fill = 8 - leftGroups.length - rightGroups.length;
	return [...leftGroups, ...Array<string>(fill).fill("0"), ...rightGroups].map((group) => parseInt(group, 16));
}
