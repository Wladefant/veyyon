"""Install a pinned PC2 release through the existing verified Windows installer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


MARKER = ".veyyon-pc2-owner.json"


def assert_plain_path(target):
    for parent in (target, *target.parents):
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if parent.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Paths must not contain symlinks, junctions or reparse points")


def binary_digest(install_dir):
    binary = install_dir / "veyyon.exe"
    assert_plain_path(binary)
    with binary.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def owned_install(version, install_dir, config_dir):
    marker = install_dir / MARKER
    if not marker.exists():
        return False
    assert_plain_path(marker)
    config_marker = config_dir / MARKER
    assert_plain_path(config_marker)
    receipt = json.loads(marker.read_text(encoding="utf-8"))
    expected = {"version": version, "configDir": str(config_dir), "sha256": binary_digest(install_dir)}
    if receipt != expected or json.loads(config_marker.read_text(encoding="utf-8")) != expected:
        raise ValueError("PC2 ownership receipt does not match this release and binary")
    return True


def record_install(version, install_dir, config_dir):
    config_dir.mkdir(parents=True, exist_ok=True)
    receipt = {"version": version, "configDir": str(config_dir), "sha256": binary_digest(install_dir)}
    for marker in (install_dir / MARKER, config_dir / MARKER):
        assert_plain_path(marker)
        with marker.open("x", encoding="utf-8") as output:
            json.dump(receipt, output)


def install_plan(version, install_dir, config_dir, script):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Use an exact release tag, such as v1.0.37")
    install_dir = Path(install_dir).absolute()
    config_dir = Path(config_dir).absolute()
    for target in (install_dir, config_dir):
        assert_plain_path(target)
    if install_dir == config_dir or install_dir in config_dir.parents or config_dir in install_dir.parents:
        raise ValueError("Keep install and configuration directories separate")
    overrides = {"VEYYON_INSTALL_DIR": str(install_dir), "VEYYON_CONFIG_DIR": str(config_dir)}
    if owned_install(version, install_dir, config_dir):
        return [], overrides
    for target in (install_dir, config_dir):
        if target.exists() and any(target.iterdir()):
            raise ValueError("Use empty directories or this installer's verified owned directories")
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
    assert_plain_path(root)
    assert_plain_path(root / "profiles" / "default" / "agent")
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
        assert_plain_path(path)
        if path.exists() and path.read_text(encoding="utf-8") != content:
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
    if not command:
        print("Matching PC2 installation already exists. No files changed.")
        return
    if sys.platform != "win32":
        raise ValueError("This installer targets PC2 Windows; run it on PC2")
    subprocess.run(command, env={**os.environ, **overrides}, timeout=600, check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    record_install(args.version, Path(overrides["VEYYON_INSTALL_DIR"]), Path(overrides["VEYYON_CONFIG_DIR"]))
    print("Installed release. Set VEYYON_CONFIG_DIR before starting Veyyon.")
    print("Complete knowledge, memory, device-auth and handoff setup in the PC2 runbook.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"PC2 setup refused: {error}", file=sys.stderr)
        sys.exit(1)
