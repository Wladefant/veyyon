# ChatGPT-Web Full-Mode Runbook: Codex Native2 Connector & Tunnel Prerequisites

This runbook establishes the operational procedures, prerequisite checklist, connector setup steps, diagnostic commands, failure modes, and fallback boundaries for enabling optional **Full mode** in the `chatgpt-web` provider via the `codex-chatgpt-web` bridge.

---

## 1. Overview & Architecture

Veyyon communicates with the local `codex-chatgpt-web` Responses bridge daemon over loopback HTTP (`http://127.0.0.1:17841/v1`), consuming `/v1/models` for catalog discovery and `/v1/responses` for turn execution.

```text
Veyyon task ──Responses + SSE──▶ codex-chatgpt-web ──embedded browser──▶ ChatGPT
     ▲                                   │                                    │
     └──────── MCP tool callbacks ◀──────┴─── outbound OpenAI tunnel ◀────────┘
                                              (Codex Native2 connector)
```

In **Browser-only** mode, ChatGPT web models stream visible reasoning, markdown, and turn state into Veyyon, but local tools are unavailable.

In **Full mode**, ChatGPT connects back to the active Veyyon task's local tool harness (filesystem, bash commands, diffs, approvals) over Model Context Protocol (MCP) through an outbound OpenAI tunnel client. The tunnel is strictly outbound: it establishes a secure connection to OpenAI's infrastructure and does not open inbound firewall ports, require public IP routing, or expose local network endpoints.

---

## 2. Prerequisites

### 2.1 Node.js Runtime
- **Node.js**: Version 22+ (LTS recommended) on `PATH` for source-managed Chrome runs.
- **Node License**: For Windows environments using shims (`fnm`, `volta`, `scoop`, or CI toolcache), Windows packaging resolves official license files from `LICENSES/Node-LICENSE.txt` or adjacent to `node.exe` (see [Issue #33](https://github.com/Wladefant/veyyon/issues/33)).
- **Bun**: Version 1.4.0+ when running the bridge from source (`bun run app`).
- Prebuilt Windows desktop launcher bundles embed their own licensed Node runtime and process supervisor, removing system Node prerequisites.

### 2.2 Browser Environment
- **Google Chrome / Chromium**: Installed at standard platform locations:
  - Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe` (or `C:\Program Files (x86)\...`)
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  - Linux: `/usr/bin/google-chrome` or `/usr/bin/chromium`
- **Managed Launcher**: Alternatively, the packaged desktop launcher (`Codex Web GPT`) provides an embedded browser with an isolated profile, avoiding reliance on system Chrome installations.
- *Note on OS support*: Terminal-only managed Chrome setup (`--chrome`) natively targets macOS. Windows and Linux setups require the desktop launcher GUI or passing `--browser-host-descriptor <path>` from a running launcher.

### 2.3 OpenAI Account & ChatGPT Workspace
- **Account Tier**: Free, Go, Plus, or Pro account:
  - Free/Go accounts expose `ChatGPT Web — Luna`.
  - Plus accounts expose `Instant`, `Medium`, `High`.
  - Pro accounts additionally expose `Extra High` and `Pro`.
- **Developer Mode**: Enabled in ChatGPT Settings (`Settings -> Developer`).
- **Workspace Identity**: The ChatGPT workspace must belong to the exact same OpenAI organization account used to create the tunnel and runtime key.

### 2.4 OpenAI Tunnel & Runtime Key Credentials
- **OpenAI Tunnel ID**:
  - Format: Must match `^tunnel_[a-f0-9]{32}$` (`tunnel_` followed by exactly 32 lowercase hexadecimal characters).
  - Provisioned at: `https://platform.openai.com/settings/organization/tunnels`
- **Tunnels Read + Use Runtime Key**:
  - A standard OpenAI API key configured with permission: `Tunnels: Read + Use`.
  - Provisioned at: `https://platform.openai.com/settings/organization/api-keys`
  - *Cost*: The key is free; it authenticates the outbound tunnel daemon to OpenAI's gateway.
- **Local Key Storage**:
  - Saved locally at: `<profile-dir>/secrets/tunnel-runtime-automatic.key`
  - File permissions: Restricted (0600 on POSIX; owner-accessible on Windows).

---

## 3. Codex Native2 Connector Setup

Follow these exact steps to attach ChatGPT to the local harness:

### Step 1: Connect the Local Harness
Run the setup command via CLI:
```bash
codex-chatgpt-web setup --full \
  --tunnel-id tunnel_<32hex> \
  --runtime-key-file <profile-dir>/secrets/tunnel.key \
  --acknowledge-unofficial
```
Or interactively:
```bash
codex-chatgpt-web setup --full --acknowledge-unofficial
# Prompts for:
# Tunnel id: tunnel_<32hex>
# Runtime key (hidden): <key>
```
Or in the desktop launcher: open **MCP** tab -> paste Tunnel ID and Runtime API Key -> click **Connect harness**.

The setup command:
1. Downloads and verifies the pinned `openai/tunnel-client` binary (`v0.0.12`).
2. Validates the SHA-256 archive checksum against pinned manifests.
3. Provisions `<profile-dir>/bin/tunnel-client` (or `tunnel-client.exe`).
4. Installs the runtime key securely to `<profile-dir>/secrets/tunnel-runtime-automatic.key`.
5. Starts the outbound tunnel supervisor via `tunnel-client runtimes connect`.

Confirm the tunnel is running before proceeding to ChatGPT:
```bash
codex-chatgpt-web tunnel status
```

### Step 2: Enable Developer Mode in ChatGPT
1. Open ChatGPT (`https://chatgpt.com`).
2. Navigate to **Settings -> Developer**.
3. Toggle **Developer mode** to **On**.

### Step 3: Create the Connector
1. In ChatGPT Settings -> Developer, select **Connectors** (or open `https://chatgpt.com/#settings/Plugins`).
2. Click **Create connector** (or **Add new connector**).
3. Under connector type, choose **Tunnel**.
4. Select the Tunnel ID created in Step 1.
5. Set **Authentication** to **None**.
6. Set **Connector Name** to exactly:
   ```text
   Codex Native2
   ```
   *Critical Rules*:
   - Name must be verbatim: `Codex Native2` (case-sensitive, with space).
   - **Do not rename or refresh an old `Codex Native` connector.** ChatGPT caches MCP schemas by connector identity. Leave legacy connectors untouched and create `Codex Native2` freshly.
   - **Zero Risk mode distinction**: Manual Zero Risk mode requires a separate connector named exactly `Codex Zero Risk` with its own independent Tunnel ID and runtime key.

### Step 4: Configure Permissions
1. Under the new connector's settings, open **Permissions**.
2. Select **Allow all actions**.
3. *Warning*: Selecting "Allow low-risk actions" intercepts command execution, patch application, and filesystem mutations before they reach the local runner. Veyyon's built-in sandbox, approval tiers, and operator prompts enforce local safety; the ChatGPT connector layer must not truncate tool dispatch.

### Step 5: Verify Runtime
Run the diagnostic doctor to confirm end-to-end readiness:
```bash
codex-chatgpt-web doctor
```

---

## 4. Operational Commands

| Action | Command |
|---|---|
| Configure Full Mode | `codex-chatgpt-web setup --full --tunnel-id <id> --runtime-key-file <file> --acknowledge-unofficial` |
| Configure Browser-Only Fallback | `codex-chatgpt-web setup --browser-only --acknowledge-unofficial` |
| End-to-end Health Diagnostics | `codex-chatgpt-web doctor` |
| JSON Health Diagnostics | `codex-chatgpt-web doctor --json` |
| Tunnel Runtime Status | `codex-chatgpt-web tunnel status` |
| Restart Tunnel Service | `codex-chatgpt-web tunnel restart` |
| Stop Tunnel Service | `codex-chatgpt-web tunnel stop` |
| Check Model Route Status | `codex-chatgpt-web route status` |
| Repair/Reconnect Route | `codex-chatgpt-web route connect` |
| Subagent Protocol Setting | `codex-chatgpt-web subagents <status\|compatibility-v1\|native>` |
| Desktop Launcher GUI | `codex-chatgpt-web dev launcher` or `bun run app` |

---

## 5. Doctor Diagnostics & Pass/Fail Criteria

The `codex-chatgpt-web doctor` command executes 11 distinct checks across configuration, browser, route, proxy, and tunnel layers.

### Diagnostic Evaluation Table

| Check ID | Scope | Pass Criteria (`ok`) | Warning Criteria (`warning`) | Failure Criteria (`error`) |
|---|---|---|---|---|
| `config` | Core | `<profile-dir>/config.json` exists and parses cleanly. | — | Missing or invalid configuration JSON. |
| `browser-host` / `chrome` | Browser | Embedded launcher browser authenticated and responsive (valid PID); or Chrome executable exists at configured path. | — | Embedded browser unreachable; or Chrome binary missing. |
| `login` | Auth | ChatGPT authenticated storage state exists at `<profile-dir>/browser/storage-state.json` with secure permissions. | — | Missing login state; unverified marker; or unsafe file permissions. |
| `codex` | Route | Model route installed pointing to `http://127.0.0.1:17841/v1`. | — | Route not installed or points to conflicting endpoint. |
| `service` | Daemon | Background service loaded or launcher-owned runtime confirmed. | Legacy OS service detected; or managed service unsupported on current OS. | Required service not installed or failed to load. |
| `proxy` | Daemon | HTTP GET `http://127.0.0.1:17841/healthz` returns 200 with `{ service: "codex-chatgpt-web", status: "ok", mode: "full", accepting_turns: true }`. | — | Proxy unreachable, non-200 status, mode mismatch, or unverified process ownership. |
| `tunnel-binary` | Full Mode | Pinned `openai/tunnel-client` binary exists at `<profile-dir>/bin/tunnel-client` (or `.exe`). | — | Tunnel client binary missing or failed checksum validation. |
| `tunnel-key` | Full Mode | Runtime key file exists at `<profile-dir>/secrets/tunnel-runtime-automatic.key` with private permissions. | — | Key file missing or world-readable. |
| `tunnel-service` | Full Mode | Launcher or OS tunnel daemon is loaded and running. | Legacy OS tunnel service detected. | Tunnel daemon not running. |
| `tunnel-runtime` | Full Mode | Tunnel client process confirms active outbound connection to OpenAI gateway. | — | Tunnel client exited, timed out, or connection failed. |
| `connector` | Full Mode | — | Always emitted as informational warning: local check cannot inspect remote ChatGPT UI; manual check at `https://chatgpt.com/#settings/Plugins` required. | — |

### Overall Doctor Verdict
- **Ready** (`exit code 0`): All checks report `ok` or `warning`.
- **Not Ready** (`exit code 1`): One or more checks report `error`.

### Expected Full Mode Doctor Output (Green)
```console
$ codex-chatgpt-web doctor
✓ Configuration is valid (<profile-dir>/config.json)
✓ Embedded launcher browser is authenticated and reachable (pid 28410)
✓ Codex native model route is installed
✓ Launcher owns the background runtime
✓ Responses proxy is healthy on 127.0.0.1:17841
✓ Pinned openai/tunnel-client binary is installed
✓ Tunnel runtime key is stored privately
✓ Launcher owns the tunnel runtime
✓ Tunnel runtime reports healthy and ready
! Local checks cannot prove that ChatGPT connector "Codex Native2" is attached to this tunnel
  Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.
Doctor result: ready
```

---

## 6. Isolation Boundaries & Browser-Only Fallback

If the OpenAI tunnel disconnects, organization credentials expire, or the ChatGPT connector is unavailable, Veyyon supports immediate fallback to **Browser-only mode**:

```bash
codex-chatgpt-web setup --browser-only --acknowledge-unofficial
```

### Boundary Guarantees:
1. **Model Access Preserved**: All account-eligible models (Luna on Free/Go; Instant, Medium, High, Extra High, Pro on Plus/Pro) remain fully functional for text, reasoning, and vision.
2. **Tool Boundary**: Local tools (bash, edit, read, ast_edit) are not exposed to ChatGPT Web over MCP. Veyyon displays `Local tools unavailable` commentary, completing turns via reasoning only.
3. **Fail-Closed Semantics**: Missing models or altered ChatGPT UI elements trigger explicit errors rather than silently degrading capability or falling back to unrequested model routes.
4. **Zero Risk Isolation**: The manual `Codex Zero Risk` workflow operates with independent tunnel IDs and credentials. The bridge never reads or automates the ChatGPT DOM in Zero Risk mode; prompts are pasted manually by the operator.

---

## 7. Failure Modes & Resolutions

### 7.1 Host Memory Pressure and Bridge Native Process Deadlines
- **Reference**: [Issue #31](https://github.com/Wladefant/veyyon/issues/31)
- **Symptom**: During high system RAM usage (peak > 85–88%), `browser-process` or native process supervisors fail with `Missing native helper pids.json` or `Owned browser process did not exit after forced termination` due to OS scheduling starvation.
- **Resolution**:
  1. Check host RAM before launching native supervisors or full suites: ensure available memory > 15% (RAM < 85%).
  2. Terminate orphaned Chrome instances and dev servers before execution.
  3. Arbitrate native supervisor compilation via the exclusive build slot protocol:
     `python C:/Users/wkiri/.veyyon/workflows/build_slot.py acquire <name> --timeout 900`
     and release immediately after completion.

### 7.2 Windows Packaging Missing Node Distribution LICENSE
- **Reference**: [Issue #33](https://github.com/Wladefant/veyyon/issues/33)
- **Symptom**: On Windows environments where `node.exe` is managed via shims (`fnm`, `volta`, `scoop`, or CI toolcache), running packaging scripts aborted with:
  `Error: Node.js distribution LICENSE is required beside node.exe for packaging`
- **Resolution**:
  1. Resolved in `codex-chatgpt-web` PR #2 by implementing `resolveNodeLicense` with fallback to repository-shipped `LICENSES/Node-LICENSE.txt` and symlink realpath inspection.
  2. For manual environments: ensure `LICENSE` or `LICENSE.txt` sits beside `node.exe`, or utilize the prebuilt Windows runtime bundle which embeds its own licensed Node distribution.

### 7.3 Transient Browser Error Chrome Appended to Subsequent Turns
- **Reference**: [Issue #34](https://github.com/Wladefant/veyyon/issues/34)
- **Symptom**: Consecutive requests against a retained bridge browser conversation may capture transient web UI error banners (e.g. `Hmm...something seems to have gone wrong.`) into assistant response markdown before completing with normal `stop`.
- **Resolution**:
  1. Defect originates in bridge DOM extraction (`browser-worker.ts` `responseDomSnapshot`) and classifier regex patterns.
  2. Temporary mitigation: Start a new Veyyon session or issue `/reset` to generate a fresh conversation turn ID rather than appending to a degraded browser DOM.
  3. Veyyon's SSE consumer maps `response.completed` cleanly and preserves response stream boundaries without modifying assistant content.

### 7.4 "Error creating connector" in ChatGPT
- **Symptom**: ChatGPT shows `Error creating connector` when clicking Create in Developer Settings.
- **Causes & Fixes**:
  1. *Account mismatch*: Tunnel ID and runtime API key must belong to the exact same OpenAI organization as the ChatGPT workspace. Verify both in OpenAI platform settings.
  2. *Tunnel not running*: The tunnel client must be active and connected (`codex-chatgpt-web tunnel status`) *before* clicking Create in ChatGPT.
  3. *Transient OpenAI gateway rejection*: ChatGPT frequently rejects the initial creation attempt after 5–10 seconds. Wait 5 seconds and click **Create** a second time.

### 7.5 "openai_base_url changed after setup"
- **Symptom**: Veyyon fails to reach models; doctor reports route conflict.
- **Cause**: An external tool or wrapper overwritten the configured `openai_base_url`.
- **Resolution**:
  Run `codex-chatgpt-web route connect` or rerun setup with `--replace-codex-route`.

### 7.6 Connector Permission Restrictions
- **Symptom**: ChatGPT generates tool call requests, but command execution or file edits never reach the local workspace.
- **Cause**: The connector was configured with "Allow low-risk actions" instead of "Allow all actions".
- **Resolution**: In ChatGPT -> Settings -> Developer -> Connectors -> `Codex Native2` -> Permissions -> select **Allow all actions**.

---

## 8. Not Verified on This Machine

The following live, interactive, and external account operations were not executed on this workstation during autonomous verification:

1. **Live OpenAI Tunnel Creation**: Provisioning a live `tunnel_<32hex>` entity on `platform.openai.com/settings/organization/tunnels`.
2. **Live Tunnels API Key Generation**: Creating a live `Tunnels Read + Use` secret API key on `platform.openai.com`.
3. **Live ChatGPT Developer Connector Attachment**: Creating and authorizing the `Codex Native2` connector inside an authenticated ChatGPT Plus/Pro web session.
4. **Live In-Browser Tool Execution Round-Trip**: Executing an end-to-end tool loopback (ChatGPT web model invoking local Veyyon tools over the live tunnel).

*Rationale*: These operations require human operator credentials, billing/organization authorization, and interactive browser logins. Autonomous verification is confined to offline-verifiable contracts, test suites, CLI preflights, and diagnostic evaluations.

---

## 9. Offline Verification Evidence

Executed in `C:/Users/wkiri/development/codex-chatgpt-web`:

### 9.1 Bridge Diagnostics (`bun run doctor`)
```console
$ bun run doctor
$ bun run src/cli.ts doctor
✓ Configuration is valid (C:\Users\wkiri\.codex-chatgpt-web\config.json)
✓ Chrome executable found: C:\Program Files\Google\Chrome\Application\chrome.exe
✓ ChatGPT login state has authenticated browser evidence
✗ Codex model route is not installed
! Managed service is unavailable on this OS; keep `serve` running manually
✗ Responses proxy is not reachable
  Unable to connect. Is the computer able to access the url?
! Browser-only mode intentionally has no local tools or MCP tunnel
Doctor result: not ready
```
*Note*: The proxy and model route errors reflect offline state (bridge daemon not currently started in background).

### 9.2 Tunnel & Lifecycle Unit Tests (`bun test`)
```console
$ bun test tests/tunnel-service.test.ts tests/setup-lifecycle.test.ts
[clean] bun test
 6 pass
 0 fail
 28 expect() calls
Ran 6 tests across 2 files. [614.00ms]
```

### 9.3 Windows Runtime Packaging Test (`bun test`)
```console
$ bun test tests/browser-runtime-package.test.ts
[clean] bun test
 1 pass
 0 fail
 8 expect() calls
Ran 1 test across 1 file. [16.65s]
```

---

*Verified against `13599c545` on 2026-09-15.*
