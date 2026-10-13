"""Install a pinned PC2 release through the existing verified Windows installer."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


def install_plan(version, install_dir, config_dir, script):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Use an exact release tag, such as v1.0.37")
    install_dir = Path(install_dir).absolute()
    config_dir = Path(config_dir).absolute()
    for target in (install_dir, config_dir):
        if any(parent.is_symlink() for parent in (target, *target.parents)):
            raise ValueError("Install paths must not contain symlinks")
        if target.is_symlink() or (target.exists() and any(target.iterdir())):
            raise ValueError("Use empty PC2 install and configuration directories")
    if install_dir == config_dir or install_dir in config_dir.parents or config_dir in install_dir.parents:
        raise ValueError("Keep install and configuration directories separate")
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
               "-File", str(Path(script).resolve()), "-Repository", "Wladefant/veyyon", "-Ref", version]
    return command, {"VEYYON_INSTALL_DIR": str(install_dir), "VEYYON_CONFIG_DIR": str(config_dir)}


def configure_pc2(config_dir, providers, gateway_url, memory_url, bank_id):
    for url in (gateway_url, memory_url):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Service URLs must use HTTPS without embedded credentials")
    if not providers or any(not re.fullmatch(r"[A-Za-z0-9_-]+", provider) for provider in providers):
        raise ValueError("Specify original provider names")
    if not bank_id:
        raise ValueError("Specify the existing shared memory bank")
    root = Path(config_dir).absolute()
    for parent in (root, *root.parents):
        if parent.is_symlink():
            raise ValueError("Configuration paths must not contain symlinks")
    agent = root / "profiles" / "default" / "agent"
    files = {
        agent / "models.yml": json.dumps({"providers": {provider: {
            "transport": "pi-native", "baseUrl": gateway_url.rstrip("/"),
            "apiKey": "${VEYYON_DEVICE_BEARER}",
        } for provider in providers}}, indent=2) + "\n",
        agent / "config.yml": json.dumps({
            "hindsight": {"apiUrl": memory_url.rstrip("/"), "bankId": bank_id},
            "checkpoints": {"enabled": True},
        }, indent=2) + "\n",
    }
    for path, content in files.items():
        if path.is_symlink() or (path.exists() and path.read_text(encoding="utf-8") != content):
            raise ValueError("Existing PC2 settings differ; preserve and review them")
    for path, content in files.items():
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("x", encoding="utf-8") as output:
                output.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--install-dir", required=True)
    parser.add_argument("--config-dir", required=True)
    parser.add_argument("--apply", action="store_true", help="Install; default only prints a safe plan")
    parser.add_argument("--configure-only", action="store_true")
    parser.add_argument("--provider", action="append")
    parser.add_argument("--gateway-url")
    parser.add_argument("--memory-url")
    parser.add_argument("--bank-id")
    args = parser.parse_args()
    if args.configure_only:
        if not args.apply:
            raise ValueError("Configuration requires --apply")
        configure_pc2(args.config_dir, args.provider, args.gateway_url or "", args.memory_url or "", args.bank_id)
        print("PC2 references configured. No secret value was written.")
        return
    command, overrides = install_plan(args.version, args.install_dir, args.config_dir,
                                      Path(__file__).with_name("install.ps1"))
    if not args.apply:
        print("Plan: verified pinned release from Wladefant/veyyon; no files changed")
        print("Release:", args.version)
        print("Install directory:", overrides["VEYYON_INSTALL_DIR"])
        print("Configuration directory:", overrides["VEYYON_CONFIG_DIR"])
        return
    if sys.platform != "win32":
        raise ValueError("This installer targets PC2 Windows; run it on PC2")
    subprocess.run(command, env={**os.environ, **overrides}, timeout=600, check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    print("Installed release. Set VEYYON_CONFIG_DIR before starting Veyyon.")
    print("Complete knowledge, memory, device-auth and handoff setup in the PC2 runbook.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"PC2 setup refused: {error}", file=sys.stderr)
        sys.exit(1)
