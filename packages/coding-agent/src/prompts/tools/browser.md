Drives real Chromium tab; full puppeteer access via JS.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? `read` the URL. Browser only for JS execution, auth, interactive actions.
- Five actions:
  - `open` — acquire/reuse named tab (`name` defaults `"main"`). Optional `url` (navigate once ready; the result carries the page's `tab.ariaSnapshot()` when it is 6,000 chars or less: act on its refs, no second read), `viewport`, `dialogs: "accept" | "dismiss"` (auto-handle `alert`/`confirm`/`beforeunload`; else page hangs till you wire `page.on('dialog', …)`). Headless only: `context` (tabs naming the same one share cookies and storage, isolated from others — e.g. one per user role), `storage_state` (state file loaded before navigating), `profile` (persistent browser: logins, storage and cache survive sessions), `visible: true | false` (move the tab, its cookies and localStorage to a browser window, or back to headless).
  - `close` — release tabs owned by this session; `all: true` still respects ownership. Supply exact `approved_tab_ids` from `inventory` to close only ownerless relay-controlled tabs. This guard applies to the tool action, not raw Puppeteer/CDP commands. `kill: true` also kills spawned-app processes.
  - `inventory` — list existing relay-controlled extension tabs owned by this session or ownerless, with Chrome tab IDs, known window IDs, last-known URL/title, and `owned` or `attached` status. Foreign-owned tabs are omitted. URL redaction covers credentials and sensitive query/fragment keys, not path segments or titles. It opens no browser connection and does not list unrelated Chrome tabs.
  - `run` — execute JS against an existing tab. `code` = async function body, run in a worker, not the page: `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope; `document`, `window` and page globals only inside `tab.evaluate(() => …)`. `wait(ms)` sleeps; `wait(fn, { timeout?, interval? })` polls `fn` until truthy and returns its value (100ms interval; deadline min(30s, cell budget − 1s)) — use it instead of polling inside `tab.evaluate`.
  - `save_state` — write the tab context's cookies + localStorage to `storage_state` (required). It holds live credentials: keep it out of the transcript.
- A `Challenge:` line reports a bot check. Interstitials are waited out. For one that needs a person or blocks, NEVER try to solve it: `open` the tab with `visible: true`, `ask` a person to solve it, then `open` it with `visible: false` and continue.
- Tabs survive `run` calls and remain available to the owning session until closed.
- Browser kinds (`app` on `open`):
  - Default (no `app`) → headless Chromium with stealth patches, unless the configured cmux backend applies.
  - `app.path` → spawn absolute binary (Electron/CDP). No stealth patches — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring on url+title picks BrowserWindow.
  - `app: { extension: true, instance_id?, profile? }` → the operator's own signed-in Chrome through the Playwright Extension and a loopback relay. This is the backend for the operator's real Chrome: use it whenever a task needs the operator's logged-in browser, and never attach to it over CDP or `chrome://inspect`. Routine work without a login stays on headless. Needs a stored token (`veyyon browser-extension set-token`). HTTP and HTTPS origins load by default, except production hosts are refused; `context`/`storage_state` are headless only; the relay creates and closes only controlled tabs. Chrome shows its "debugging this browser" bar on controlled tabs.
- `tab` helpers; drop to raw puppeteer `page` for anything uncovered:
  - `tab.goto(url, { waitUntil? })` — navigate. A hung load fails ~1s before the cell budget with a named error and the navigation stopped; for slow pages raise `timeout` or use `waitUntil: "domcontentloaded"`.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot: `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Ids stable until next observe/goto.
  - `tab.ariaSnapshot(selector?, { depth?, boxes? })` — Playwright-format ARIA YAML (roles, names, `/url`, `/placeholder`) of `selector` or the document; each node has a `[ref=eN]`, `[cursor=pointer]` marks clickables. Iframe content nests under its line, refs like `f1e3`. Refs renumber from e1 each call and stay valid until the next.
  - `tab.ref("e5")` — ref from the last ariaSnapshot → element handle (`.click()`, `.type()`, `.fill()`, `.hover()`, `.evaluate()`, …), chainable: `await tab.ref("e5").click()`; inline as `aria-ref=e5` in `tab.click`/`type`/`fill`/`waitFor`/`scrollIntoView`.
  - `tab.id(n)` — id from last observe → element handle with the same action methods.
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`. `fill` replaces the value with real edits frameworks see; `type` sends keystrokes. `click` and a handle's `click`/`hover` never press a cover: a menu, dialog or banner over the element fails the call, naming it.
  - `tab.waitFor(selector, { timeout? })` / `tab.waitForSelector(selector, { timeout?, visible?, hidden? })` — wait until attached (optionally visible/hidden); returns an action-method handle.
  - `tab.drag(from, to)` — endpoints: selector (center-to-center) or `{ x, y }` viewport point (canvases, sliders).
  - `tab.scrollIntoView(selector)` — center in viewport; before clicking off-screen elements.
  - `tab.select(selector, …values)` — set `<select>` option(s); returns selection. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">` or to the chooser a control opens; paths relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — substring or `RegExp` (matches SPA pushState nav); returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — substring, `RegExp`, or `(response) => boolean`; returns puppeteer `HTTPResponse` (`.text()`/`.json()`/`.status()`/`.headers()`).
  - `tab.waitForNavigation({ waitUntil?, timeout? })` — resolves on the next navigation. Start it BEFORE the click/submit that triggers it; after `tab.goto` (which already waits) use `tab.waitForUrl`/`tab.waitForSelector` instead.
  - `tab.evaluate(fn, …args)` — run ad-hoc code in the page's MAIN world. DOM and page-defined globals (`window.myFlag`, `jQuery`) are visible; mutations affect the page. Raw `page.evaluate` runs in an isolated world where page globals are undefined.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — capture + attach for viewing (`silent: true` skips). Pass `save` only when a later step needs the file.
  - `tab.extract(format = "markdown")` — readable page content (`"markdown"` | `"text"`); throws when nothing readable.
  - `tab.storageState({ path? })` / `tab.loadStorageState(stateOrPath)` — save/load the context's cookies + localStorage (object or file); load is headless only.
- Selectors: CSS + puppeteer handlers `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`; a snapshot line's `button "Save"` or `[ref=e5]`; `css:has-text("…")` at the end; comma lists try each in order. Other Playwright-only pseudos (`:visible`, …) are rejected. A stalled action fails fast with a named `tab.<op>` error and a match count; a selector matching nothing fails in ~2s (give `waitFor`/`waitForSelector` a `{ timeout }` for slow elements). A cell timeout names the stalled op and any dialog blocking the page.
</instruction>

<critical>
- MUST `open` before `run` — `run` never creates a tab.
- Default to `tab.observe()` for page state — structured data, actionable ids. Screenshot ONLY when appearance matters.
- Every call re-sends the whole conversation: in one `run`, act and return what the next step needs (a value, or `tab.ariaSnapshot(selector)` of the part that changed). Navigation invalidates element ids and refs.
- Act through `tab` actions: they wait for their element and fail naming why (no match, covered, disabled); probing hit targets or page scripts first wastes turns.
- `code` runs with full Node access. Treat as your code, not sandboxed.
</critical>

<output>
Per call: `display(value)` output, then `code`'s return value unless it was displayed already; objects and arrays as compact JSON. `run` always produces at least a status line.
</output>
