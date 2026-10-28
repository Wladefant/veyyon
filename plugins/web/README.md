# @veyyon/web

Site scrapers that turn a URL into markdown.

Eighty site handlers (GitHub, crates.io, arXiv, YouTube, Reddit, PyPI and the rest), the page
loader that escalates through three user agents when a site answers as though it is talking to a
bot, and a client for Parallel's extract API.

## Use

`specialHandlers` is the ordered list the dispatcher walks. A handler returns a `RenderResult` for a
URL it claims, `null` for one it declines, and a `ScraperDegrade` when it claims a URL and cannot
scrape it, which directs the caller to fall back to a generic fetch and states why.

```ts
import { specialHandlers } from "@veyyon/web/scrapers";

for (const handler of specialHandlers) {
	const result = await handler("https://crates.io/crates/serde", 10);
	if (result) console.log(result);
}
```

Four handlers need something the process around them provides: a credential store, a document
converter, a managed external binary, and the configured fetch provider. Pass a `ScrapeServices`
object as the fourth argument to supply them; a handler that needs one and is given nothing reports
that rather than reaching for a global.

A cancelled signal raises an error whose `name` is `AbortError` or `TimeoutError`, so
`isCancellation` from `@veyyon/utils` recognizes it and the abort reason survives on `cause`.

## Public fetch HTTP handler

`createPublicFetchHandler` in `@veyyon/web/public-fetch-handler` returns `(request: Request) => Promise<Response>` for a Worker `fetch` entry. It wraps `createPublicFetchService`.

```ts
import { createPublicFetchHandler } from "@veyyon/web/public-fetch-handler";

export default {
	fetch: createPublicFetchHandler({
		authorize: authorizeFromCredentials, // host function: verified request -> { userId } | null
		admission: budgetBinding, // host binding to the durable budget from issue #628
	}),
};
```

### Required binding

- `admission` must bind to the durable budget from issue #628. This package does not implement that binding and has no default allowance.
- `authorize` must derive `userId` from a credential the server verifies. The handler never reads a user id from a header, a query parameter or a body.
- `transport` is optional. Without it, the service dials through the Node TLS transport, which needs `node:net` and `node:tls`. A runtime without them must inject a transport.
- `timeoutMs` is optional. It must be above 0 and at most 15000. The default is 15000. One deadline covers `authorize` and the service.

### GET contract

- Accepts `GET /?url=<https-url>` with exactly one `url` parameter.
- `405` for any other method, with `Allow: GET`.
- `400` for a missing, repeated, empty or non-https `url`.
- `403` when `authorize` returns `null`, returns no user id, or throws. No admission reservation and no upstream call happen.
- `429` when admission denies the reservation. `502` for any other failure, with a generic message.
- `504` with `{"error":"public fetch timed out"}` when the handler or the service deadline passes.
- `200` returns JSON with `url`, `contentType`, `text` and `truncated`. Headers: `content-type: application/json; charset=utf-8` and `cache-control: no-store`.
- Error bodies hold a fixed message only. They never echo the URL, a credential or an upstream error.

### Fixed bounds

- Redirects: at most 3. Each hop repeats DNS vetting.
- Body read cap: 2 MiB. Returned text: at most 256 KiB of UTF-8.
- Media types: `text/html`, `text/plain`, `application/json`, `application/rss+xml`, `application/atom+xml`. Charsets: `utf-8` and `us-ascii`. Identity content encoding only.
- SSRF: IP literals and local host suffixes are refused before DNS. Every DNS answer must be global. The first vetted address is pinned for the TLS dial. Non-default ports and URL credentials are refused.
- Admission request: scope `fetch:public`, 10 per minute and 1000 per month.

### Not in this package

- Issue #628 (durable budget and authentication), and sibling shared contracts #630, #631 and #632, are not implemented here.
- No deployment, provisioning, Worker configuration, secret or database is included.
- The runtime TLS proof for the pinned transport under Workers is not run.
- The tests in `test/a-public-fetch-handler-admits-only-authorized-callers.test.ts` are authored but not run.
