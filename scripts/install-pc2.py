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
START_MARKER = ".veyyon-pc2-start.json"
TEMP_MARKER_PATTERN = re.compile(rf"^\.tmp-(?:{re.escape(START_MARKER)}|{re.escape(MARKER)})-\d+$")

def assert_plain_path(target):
    for parent in (target, *target.parents):
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if parent.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Paths must not contain symlinks, junctions or reparse points")


def atomic_write_json(target_path, data):
    assert_plain_path(target_path)
    parent = target_path.parent
    parent.mkdir(parents=True, exist_ok=True)
    temp_path = parent / f".tmp-{target_path.name}-{os.getpid()}"
    try:
        with temp_path.open("w", encoding="utf-8") as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, target_path)
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass

def binary_digest(install_dir):
    binary = install_dir / "veyyon.exe"
    assert_plain_path(binary)
    with binary.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def owned_install(version, install_dir, config_dir):
    marker = install_dir / MARKER
    config_marker = config_dir / MARKER
    if not marker.exists() or not config_marker.exists():
        return False
    assert_plain_path(marker)
    assert_plain_path(config_marker)
    try:
        receipt = json.loads(marker.read_text(encoding="utf-8"))
        config_receipt = json.loads(config_marker.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    expected = {"version": version, "configDir": str(config_dir), "sha256": binary_digest(install_dir)}
    if receipt != expected or config_receipt != expected:
        raise ValueError("PC2 ownership receipt does not match this release and binary")
    return True


def record_start(version, install_dir, config_dir):
    install_dir = Path(install_dir).absolute()
    config_dir = Path(config_dir).absolute()
    for target in (install_dir, config_dir):
        target.mkdir(parents=True, exist_ok=True)
        assert_plain_path(target)
    start_payload = {
        "version": version,
        "installDir": str(install_dir),
        "configDir": str(config_dir),
    }
    for marker in (install_dir / START_MARKER, config_dir / START_MARKER):
        atomic_write_json(marker, start_payload)


def is_resumable_install(version, install_dir, config_dir):
    expected = {"version": version, "installDir": str(install_dir), "configDir": str(config_dir)}
    install_start = install_dir / START_MARKER
    config_start = config_dir / START_MARKER

    if not install_start.exists() and not config_start.exists():
        return False

    if install_dir.exists() and any(install_dir.iterdir()):
        if not install_start.exists():
            return False
        assert_plain_path(install_start)
        try:
            if json.loads(install_start.read_text(encoding="utf-8")) != expected:
                return False
        except (json.JSONDecodeError, OSError):
            return False

    if config_dir.exists() and any(config_dir.iterdir()):
        if not config_start.exists():
            return False
        assert_plain_path(config_start)
        try:
            if json.loads(config_start.read_text(encoding="utf-8")) != expected:
                return False
        except (json.JSONDecodeError, OSError):
            return False

    return True

def clean_interrupted_temp_markers(version, install_dir, config_dir):
    expected = {"version": version, "installDir": str(install_dir), "configDir": str(config_dir)}
    for target in (install_dir, config_dir):
        if not target.exists():
            continue
        assert_plain_path(target)
        entries = list(target.iterdir())
        for entry in entries:
            assert_plain_path(entry)
        temp_markers = [e for e in entries if e.is_file() and TEMP_MARKER_PATTERN.fullmatch(e.name)]
        other_entries = [e for e in entries if not (e.is_file() and TEMP_MARKER_PATTERN.fullmatch(e.name))]
        if temp_markers and not other_entries:
            for temp_file in temp_markers:
                temp_file.unlink()
        elif temp_markers and other_entries:
            start_file = target / START_MARKER
            if start_file.exists():
                try:
                    if json.loads(start_file.read_text(encoding="utf-8")) == expected:
                        for temp_file in temp_markers:
                            temp_file.unlink()
                except (json.JSONDecodeError, OSError):
                    pass


def record_install(version, install_dir, config_dir):
    install_dir = Path(install_dir).absolute()
    config_dir = Path(config_dir).absolute()
    config_dir.mkdir(parents=True, exist_ok=True)
    receipt = {"version": version, "configDir": str(config_dir), "sha256": binary_digest(install_dir)}
    for marker in (install_dir / MARKER, config_dir / MARKER):
        atomic_write_json(marker, receipt)
    for start_marker in (install_dir / START_MARKER, config_dir / START_MARKER):
        try:
            if start_marker.exists():
                assert_plain_path(start_marker)
                start_marker.unlink()
        except OSError:
            pass


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
    clean_interrupted_temp_markers(version, install_dir, config_dir)
    if not is_resumable_install(version, install_dir, config_dir):
        for target in (install_dir, config_dir):
            if target.exists() and any(target.iterdir()):
                raise ValueError("Use empty directories or this installer's verified owned directories")
    command = ["powershell.exe", "-ExecutionPolicy", "Bypass", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
               "-File", str(Path(script).resolve()), "-Repository", "Wladefant/veyyon", "-Ref", version]
    return command, overrides


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
    if sys.version_info < (3, 11):
        raise ValueError("PC2 setup requires Python 3.11 or newer. No files were changed.")
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Knowledge export: first run `veyyon knowledge export --plan ./review-plan.json`; "
               "review the paths, hashes and categories; then run "
               "`veyyon knowledge export --out ./catalog --reviewed-plan ./review-plan.json`. "
               "A bare export refuses.",
    )
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
    record_start(args.version, Path(overrides["VEYYON_INSTALL_DIR"]), Path(overrides["VEYYON_CONFIG_DIR"]))
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
