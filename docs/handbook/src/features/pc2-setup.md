# PC2 setup

State: implementation needs remote verification and a release that contains all four option C parts.
Do not use the older v1.5.6 release to claim these new features work.

Tracking: https://github.com/Wladefant/veyyon/issues/588
Installation: https://github.com/Wladefant/veyyon/issues/604

## Prerequisites

Use Windows on PC2. Install Python 3.11 or newer, Git, Tailscale and Bitwarden US through their supported installers.
The operator must sign in to GitHub, the same tailnet and Bitwarden US on PC2.
Authorize each external tool separately. Do not copy PC1 browser profiles or live databases.

An independent host must provide the model gateway for PC1-off inference.
The host keeps the credential broker and provider credentials. PC2 must not set `VEYYON_AUTH_BROKER_URL` or its token.
Run the gateway behind private HTTPS. Tailscale Serve, not Funnel, supplies the selected private transport.
The server uses `veyyon auth-gateway serve --bind=127.0.0.1:4000 --device-tokens-file=<server-only-device-map>`.
The model broker issue owns the device map format and revocation checks:
https://github.com/Wladefant/veyyon/issues/602

Use the same existing Hindsight API URL, bank and scope on both PCs.
Do not create a replacement bank or migrate Mnemopi in this procedure.
Hindsight groups memories by bank. Retaining an existing document ID replaces that document.
Use distinct session document IDs for independent sessions.

The existing checkpoint service must support the handoff revision before either PC uses handoff.
Keep its bearer and encryption key in Bitwarden US. Inject them into process environment only.
Cloudflare writes remain frozen during this assignment. No service deployment occurred.

## Exact one-time PC2 steps

Replace each angle-bracket value with the approved non-secret value from the selected setup.
The release tag must contain the knowledge, broker, handoff and installer PRs.
A release with those changes does not exist yet. Stop before installation until that gate passes.

1. Sign in to GitHub, Tailscale and Bitwarden US on PC2 as the same owner.
2. Clone `Wladefant/veyyon` and check out the approved release tag.
3. Run `python scripts/install-pc2.py --version <release-tag> --install-dir C:\VeyyonPC2\bin --config-dir C:\VeyyonPC2\state`.
4. Read the plan. Confirm both paths are empty and belong to PC2.
5. Repeat step 3 with `--apply`. The existing installer verifies the release checksum and never builds locally.
6. Set the process variable `VEYYON_CONFIG_DIR` to `C:\VeyyonPC2\state` before each Veyyon command.
7. Clone the reviewed private knowledge catalog into `C:\VeyyonPC2\knowledge`.
8. Run `veyyon knowledge verify --from C:\VeyyonPC2\knowledge`.
9. Run `veyyon knowledge apply --from C:\VeyyonPC2\knowledge --dry-run`.
10. Resolve all conflicts explicitly. Run the same command without `--dry-run` only after it reports no conflicts.
11. Run `python scripts/install-pc2.py --version <release-tag> --install-dir C:\VeyyonPC2\bin --config-dir C:\VeyyonPC2\state --configure-only --apply --provider <original-provider> --gateway-url <private-https-gateway> --memory-url <existing-https-hindsight> --bank-id <existing-bank>`.
12. Repeat `--provider` for each selected provider. The script writes only `${VEYYON_DEVICE_BEARER}`, never its value.
13. If step 11 refuses existing settings, preserve them. Add the model and memory references below by explicit review.
14. Retrieve the PC2 device bearer from Bitwarden US. Inject it as `VEYYON_DEVICE_BEARER` for the process, without printing it.
15. Inject `HINDSIGHT_API_TOKEN`, `VEYYON_CHECKPOINT_TOKEN` and `VEYYON_CHECKPOINT_KEY` from Bitwarden US into the process environment.
16. Set `VEYYON_CHECKPOINT_URL` to the existing approved HTTPS checkpoint endpoint.
17. Authorize each MCP service using its own owner sign-in. Keep local paths, SSH definitions and browser-extension enrollment PC2-specific.
18. Select the same original provider and model in Veyyon. Confirm missing device auth refuses before any provider call.
19. Confirm both PCs recall the same existing memory through the selected Hindsight bank.
20. Set `VEYYON_CHECKPOINT_NODE=pc1` on PC1. Stop its session, then run `veyyon session handoff <session-id> --file <stopped-session.jsonl> --to pc2`.
21. Set `VEYYON_CHECKPOINT_NODE=pc2` in the PC2 process environment.
22. Run `veyyon session checkpoint-restore <session-id> --output <new-directory>` on PC2.
23. Pending the final interface in https://github.com/Wladefant/veyyon/pull/607: do not resume until automatic marker and claim fencing works.
24. Confirm PC1 cannot admit a prompt or tool for the transferred session. Test reverse handoff before relying on it.
25. Turn PC1 off. Confirm local tools, the installed catalog, remote memory and the independent model gateway remain available.

No provider subscription sign-in on PC2 is needed for broker-backed models.
Provider sign-ins belong to the independent credential authority and use supported owner flows.
Same accounts do not grant extra usage allowance or establish blanket provider permission.

## Configuration references

`profiles/default/agent/models.yml`, under the selected configuration root:

```yaml
providers:
  openai-codex:
    transport: pi-native
    baseUrl: https://approved-private-gateway
    apiKey: ${VEYYON_DEVICE_BEARER}
```

Replace `openai-codex` with the original provider name. Keep the base URL free of a `/v1` suffix.
The existing client sends model requests to `/v1/pi/stream`.
The hostname above illustrates the format. It is not a provisioned endpoint.

`profiles/default/agent/config.yml`:

```yaml
hindsight:
  apiUrl: https://existing-memory-service
  bankId: existing-owner-bank
checkpoints:
  enabled: true
```

Keep the existing Hindsight scope, mission and project tags when merging reviewed configuration.
The setup script refuses different existing settings. An identical configuration rerun changes nothing.
It refuses credential-bearing service URLs, symlinks and Windows junctions.
It never deletes sessions, databases, files or configuration.
An install rerun accepts only matching ownership receipts and the original binary checksum.
It skips reinstallation and preserves existing sessions. A changed release or binary requires explicit review.

## Update and conflict procedure

1. Export reviewed changes to a separate catalog with `veyyon knowledge export --out <new-catalog>`.
2. Review the catalog for secrets and machine-specific paths before committing it.
3. Push the private catalog with normal Git ownership and access controls.
4. Pull on the other PC with `git pull --ff-only`.
5. If Git refuses divergence, preserve both branches and resolve the text conflict explicitly.
6. Apply the catalog with a saved baseline and a dry run before changing local files.

Do not mirror `.veyyon`, SQLite databases, PIDs, sockets, browser profiles, caches or active worktrees.
Sync is not backup. A failed apply is not permission to force overwrite.
A failed or interrupted handoff does not prove that PC2 owns the session.
Offline continuation needs an explicit new fork, not a second writer with the old session ID.
Running processes, eval kernels, browser connections and debugger state stay on the source PC.

## Documentation and verified constraints

- https://git-scm.com/docs/git-pull: fast-forward pulls refuse diverged history.
- https://sqlite.org/wal.html: WAL database users must share one host.
- https://tailscale.com/docs/reference/tailscale-cli/serve: private tailnet sharing, loopback HTTP proxy, background restart behavior.
- https://hindsight.vectorize.io/llms.txt: memory bank isolation and document-ID replacement.
- https://hindsight.vectorize.io/developer/api/quickstart: existing API/client operations and worker lifecycle guidance.

Not verified: PC2 installation, provider calls, service reachability, release containing all four parts, and two-PC handoff.
Deleted: none
Not run: Windows installer smoke, two-PC smoke, provider sign-ins, service provisioning
