# Runbooks

Operational procedures for scheduled or emergency secret rotation, organized by the
secret being rotated.

| Runbook | When to reach for it |
| --- | --- |
| [secret-rotation.md](secret-rotation.md) | Rotating Apple signing secrets, the Cloudflare Pages token, or auth-broker and auth-gateway bearer tokens. |
| [chatgpt-web-full-mode.md](../../runbooks/chatgpt-web-full-mode.md) | Operational procedures for ChatGPT-Web full-mode prerequisites, Codex Native2 connector setup, tunnel diagnostics, and recovery. |

Release incidents are not here. Cutting a release, verifying one, recovering a
failed cut, and rolling back a bad release are all in
[releasing.md](../releasing.md), which is the only page about releases. Site and
install-endpoint deployment is in [deployment.md](../deployment.md).

*Verified against `13599c545` on 2026-09-15.*
