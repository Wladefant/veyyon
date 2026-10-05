# Browser extension bridge (`app.extension`)

The `browser` tool can drive the operator's real, signed-in Chrome without a remote-debugging port and without the `chrome://inspect` "Allow remote debugging" prompt.
It uses the Apache-2.0 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) and a relay that runs inside Veyyon.

Routine work still uses the headless backend.
Open `app.extension` only when a session needs the operator's own Chrome.

## Contract (pinned)

| Item | Value |
|---|---|
| Extension | Playwright Extension 0.4.0 |
| Extension id | `mmlmfjhmonkocbjadbfplnigmagldckm` |
| Connect page | `chrome-extension://<id>/connect.html?protocolVersion=2&mcpRelayUrl=<ws url>&token=<token>&client={"name":"veyyon"}` |
| Protocol version | `2` (the connect page refuses any other value) |
| Transport | One WebSocket from the extension to the relay on `127.0.0.1` |
| Wire format | JSON. Request `{id, method, params[]}`. Reply `{id, result}` or `{id, error}`. Event `{method, params[]}` |
| Methods the relay calls | `chrome.tabs.create`, `chrome.tabs.remove`, `chrome.debugger.attach` (`[{tabId}, "1.3"]`), `chrome.debugger.detach`, `chrome.debugger.sendCommand` (`[{tabId}, method, params]`) |
| Events the extension sends | `chrome.debugger.onEvent`, `chrome.debugger.onDetach`, `chrome.tabs.onCreated`, `chrome.tabs.onRemoved` |
| Known quirk | `chrome.tabs.remove` never replies. The relay sends it and does not wait. |

If a Web Store update changes the protocol version, the connect page refuses the connection.
The relay then reports the version it expected.
The fallback is an own MV3 extension with native messaging.

## What the relay does

The relay serves puppeteer a browser-level CDP endpoint.
It turns each CDP command into the extension calls above.
The `tab.*` helpers, `observe`, `screenshot` and the rest of the `browser` tool run unchanged on top.

## Security

1. The relay listens on `127.0.0.1` only. Any other host is refused.
2. Requests with a foreign `Host` or `Origin` header get `403`.
3. Three random secrets guard three paths: the extension path, the CDP path and the control path. Each is 32 random bytes. The comparison is timing-safe. A secret never appears in a log line, an error, or tool output.
4. The extension token is per Chrome profile. It lives in `~/.veyyon/profiles/<name>/agent/browser-extension/` with mode `0600`.
5. Navigation is deny by default. Only origins on the allowlist load. `about:blank` is always allowed.
6. These hosts are refused even when the allowlist names them: any host containing `zaraprptkegxqpvnsubu`, any host containing `akamai-iad-prod`, and `polysimulator.com` with its subdomains.
7. A page that reaches a refused origin by redirect is sent back to `about:blank`.
8. Commands that export profile data are blocked: `Page.printToPDF`, `Network.getAllCookies`, `Network.getCookies`, `Storage.getCookies`.
9. The relay logs the origin of each navigation decision. It logs no path, no query, no page content.
10. `Browser.close` never closes the operator's Chrome. It only drops the client socket.

### Allowlist

Put origins in `~/.veyyon/profiles/<name>/agent/browser-extension/policy.json`:

```json
{ "allow": ["https://staging.example.com", "docs.example.org", "*.cdn.example.net"] }
```

Add more with `VEYYON_BROWSER_EXTENSION_ALLOW` (comma separated).
An entry with a scheme (`https://host`) matches that origin only.
An entry without a scheme matches the host on any scheme.
`*.host` matches subdomains, not `host` itself.

### Popup guard: best effort
Chrome loads a popup tab before the debugger can attach to it. The relay therefore installs a guard in every controlled document. `window.open` returns `null`. `form.submit()`, `form.requestSubmit()`, submit events and `formtarget` are forced to the same tab. A `<base target>` is rewritten. Links open in place, also inside shadow DOM and on ctrl, meta, shift or middle click. Same-tab requests then pass the request gate before they leave Chrome.
The guard is still best effort. It runs as page script, so a path with no script hook can open a tab (for example a native browser gesture such as a context-menu "open in new tab", or a page that restores the original functions from a fresh iframe). The relay removes a refused tab and never attaches to it, but one blind request, with the page's cookies, can still go out. Do not rely on the guard to protect a host that must never be contacted. Keep such hosts off the allowlist and in the production refusal list.

## Operator install steps (one time)

1. Open Chrome with the profile you want Veyyon to use.
2. Open the Playwright Extension page in the Chrome Web Store: https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm
3. Click "Add to Chrome".
4. Click the puzzle-piece icon. Pin the extension.
5. Click the extension icon. Click "Status".
6. Copy the token that the status page shows.
7. In a terminal, run `veyyon browser-extension set-token`. Paste the token. Press Enter.
8. Create the allowlist file named above. List only the sites Veyyon may open.
9. Run `veyyon browser-extension status`. It prints the token state and the allowlist path. It never prints the token.

After this, a session that opens `browser` with `app: {"extension": true}` connects by itself.
Chrome still shows its "started debugging this browser" bar on the controlled tab.
That is expected.

## Commands

| Command | Effect |
|---|---|
| `veyyon browser-extension set-token` | Store the token (read from stdin). |
| `veyyon browser-extension status` | Show token state, the allowlist file path, and the running relay. |
| `veyyon browser-extension disconnect` | Detach every controlled tab and drop the extension. |
| `veyyon browser-extension clear-token` | Delete the stored token. |

Add `--instance <name>` to use a second Chrome profile.

## Disconnect

`veyyon browser-extension disconnect` and closing the `browser` session detach every controlled tab.
Teardown never waits for `chrome.tabs.remove`.
