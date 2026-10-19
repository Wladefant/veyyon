import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("install_pc2", Path(__file__).with_name("install-pc2.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PC2InstallContract(unittest.TestCase):
    def test_pinned_fork_release_uses_existing_verified_installer(self):
        with tempfile.TemporaryDirectory() as root:
            command, env = installer.install_plan("v1.2.3", Path(root) / "bin", Path(root) / "config", "install.ps1")
            file_index = command.index("-File")
            self.assertEqual(command[0], "powershell.exe")
            self.assertIn("-ExecutionPolicy", command[:file_index])
            self.assertEqual(command[command.index("-ExecutionPolicy") + 1], "Bypass")
            self.assertIn("-NoProfile", command[:file_index])
            self.assertIn("-NonInteractive", command[:file_index])
            self.assertIn("-WindowStyle", command[:file_index])
            self.assertEqual(command[command.index("-WindowStyle") + 1], "Hidden")
            self.assertEqual(command[-4:], ["-Repository", "Wladefant/veyyon", "-Ref", "v1.2.3"])
            self.assertNotIn("-NoVerify", command)
            self.assertNotIn("-Force", command)
            self.assertEqual(env["VEYYON_CONFIG_DIR"], str(Path(root) / "config"))

    def test_unpinned_or_injected_version_refuses(self):
        for version in ["latest", "main", "v1.2.3;whoami", "../v1.2.3"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                installer.install_plan(version, "bin", "config", "install.ps1")

    def test_existing_user_data_survives_refusal(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config"
            config.mkdir()
            data = config / "session.jsonl"
            data.write_text("user session")
            with self.assertRaises(ValueError):
                installer.install_plan("v1.2.3", Path(root) / "bin", config, "install.ps1")
            self.assertEqual(data.read_text(), "user session")
            self.assertFalse((Path(root) / "bin").exists())

    def test_nested_install_and_configuration_refuse(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                installer.install_plan("v1.2.3", root, Path(root) / "config", "install.ps1")


    def test_configuration_is_idempotent_and_contains_only_secret_references(self):
        with tempfile.TemporaryDirectory() as root:
            args = (root, ["openai-codex"], "https://gateway.example", "https://memory.example", "owner-bank")
            installer.configure_pc2(*args)
            models = Path(root) / "profiles/default/agent/models.yml"
            first = models.read_bytes()
            installer.configure_pc2(*args)
            self.assertEqual(models.read_bytes(), first)
            self.assertIn(b"${VEYYON_DEVICE_BEARER}", first)
            self.assertNotIn(b"refreshToken", first)

    def test_settings_collision_refuses_all_changes(self):
        with tempfile.TemporaryDirectory() as root:
            agent = Path(root) / "profiles/default/agent"
            agent.mkdir(parents=True)
            (agent / "config.yml").write_text("user settings")
            with self.assertRaises(ValueError):
                installer.configure_pc2(root, ["openai"], "https://gateway.example", "https://memory.example", "bank")
            self.assertEqual((agent / "config.yml").read_text(), "user settings")
            self.assertFalse((agent / "models.yml").exists())

    def test_credential_bearing_service_url_refuses_without_writes(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                installer.configure_pc2(root, ["openai"], "https://secret@gateway.example", "https://memory.example", "bank")
            self.assertEqual(list(Path(root).iterdir()), [])


    def test_owned_install_rerun_preserves_sessions_and_skips_reinstall(self):
        with tempfile.TemporaryDirectory() as root:
            binary_dir = Path(root) / "bin"
            config_dir = Path(root) / "config"
            binary_dir.mkdir()
            (binary_dir / "veyyon.exe").write_bytes(b"verified release test artifact")
            installer.record_install("v1.2.3", binary_dir, config_dir)
            session = config_dir / "session.jsonl"
            session.write_text("preserved session")
            command, _ = installer.install_plan("v1.2.3", binary_dir, config_dir, "install.ps1")
            self.assertEqual(command, [])
            self.assertEqual(session.read_text(), "preserved session")
            (binary_dir / "veyyon.exe").write_bytes(b"changed binary")
            with self.assertRaises(ValueError):
                installer.install_plan("v1.2.3", binary_dir, config_dir, "install.ps1")

    def test_interrupted_install_with_start_marker_resumes(self):
        with tempfile.TemporaryDirectory() as root:
            binary_dir = Path(root) / "bin"
            config_dir = Path(root) / "config"
            installer.record_start("v1.2.3", binary_dir, config_dir)
            self.assertTrue((binary_dir / installer.START_MARKER).exists())
            self.assertTrue((config_dir / installer.START_MARKER).exists())
            (binary_dir / "veyyon.partial").write_text("partial download", encoding="utf-8")
            command, env = installer.install_plan("v1.2.3", binary_dir, config_dir, "install.ps1")
            self.assertTrue(len(command) > 0)
            self.assertEqual(env["VEYYON_INSTALL_DIR"], str(binary_dir))
            self.assertEqual(env["VEYYON_CONFIG_DIR"], str(config_dir))

    def test_unrelated_binary_without_start_marker_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            binary_dir = Path(root) / "bin"
            binary_dir.mkdir(parents=True)
            (binary_dir / "veyyon.exe").write_text("unrelated binary", encoding="utf-8")
            config_dir = Path(root) / "config"
            with self.assertRaises(ValueError) as ctx:
                installer.install_plan("v1.2.3", binary_dir, config_dir, "install.ps1")
            self.assertIn("Use empty directories or this installer's verified owned directories", str(ctx.exception))

    def test_mismatched_start_marker_refuses_resume(self):
        with tempfile.TemporaryDirectory() as root:
            binary_dir = Path(root) / "bin"
            config_dir = Path(root) / "config"
            installer.record_start("v1.2.0", binary_dir, config_dir)
            (binary_dir / "veyyon.exe").write_text("staged binary", encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                installer.install_plan("v1.2.3", binary_dir, config_dir, "install.ps1")
            self.assertIn("Use empty directories or this installer's verified owned directories", str(ctx.exception))

            other_config = Path(root) / "other-config"
            with self.assertRaises(ValueError) as ctx2:
                installer.install_plan("v1.2.0", binary_dir, other_config, "install.ps1")
            self.assertIn("Use empty directories or this installer's verified owned directories", str(ctx2.exception))

    def test_record_start_and_atomic_record_install_transaction(self):
        with tempfile.TemporaryDirectory() as root:
            binary_dir = Path(root) / "bin"
            config_dir = Path(root) / "config"
            installer.record_start("v1.2.3", binary_dir, config_dir)
            self.assertTrue((binary_dir / installer.START_MARKER).exists())
            self.assertTrue((config_dir / installer.START_MARKER).exists())

            binary = binary_dir / "veyyon.exe"
            binary.write_bytes(b"dummy binary contents")

            replaced_targets = []
            orig_replace = installer.os.replace
            def spy_replace(src, dst):
                replaced_targets.append(Path(dst).name)
                return orig_replace(src, dst)

            with patch.object(installer.os, "replace", side_effect=spy_replace):
                installer.record_install("v1.2.3", binary_dir, config_dir)

            self.assertIn(installer.MARKER, replaced_targets)
            self.assertTrue((binary_dir / installer.MARKER).exists())
            self.assertTrue((config_dir / installer.MARKER).exists())
            self.assertFalse((binary_dir / installer.START_MARKER).exists())
            self.assertFalse((config_dir / installer.START_MARKER).exists())
            self.assertTrue(installer.owned_install("v1.2.3", binary_dir, config_dir))

    def test_owned_install_handles_partial_receipt_without_raising_filenotfound(self):
        with tempfile.TemporaryDirectory() as root:
            binary_dir = Path(root) / "bin"
            binary_dir.mkdir(parents=True)
            binary = binary_dir / "veyyon.exe"
            binary.write_bytes(b"dummy binary")
            config_dir = Path(root) / "config"
            config_dir.mkdir(parents=True)

            receipt = {"version": "v1.2.3", "configDir": str(config_dir), "sha256": installer.binary_digest(binary_dir)}
            installer.atomic_write_json(binary_dir / installer.MARKER, receipt)

            self.assertFalse(installer.owned_install("v1.2.3", binary_dir, config_dir))

    def test_windows_junction_attribute_refuses_before_writes(self):
        with patch.object(Path, "lstat", return_value=SimpleNamespace(st_file_attributes=0x400, st_mode=0o040755)):
            with self.assertRaises(ValueError):
                installer.install_plan("v1.2.3", "bin", "config", "install.ps1")
            with self.assertRaises(ValueError):
                installer.configure_pc2("config", ["openai"], "https://gateway.example", "https://memory.example", "bank")

    def test_configure_only_does_not_execute_installer(self):
        with tempfile.TemporaryDirectory() as root:
            args = ["install-pc2.py", "--version", "v1.2.3", "--install-dir", str(Path(root) / "bin"),
                    "--config-dir", str(Path(root) / "config"), "--configure-only", "--apply",
                    "--provider", "openai", "--gateway-url", "https://gateway.example",
                    "--memory-url", "https://memory.example", "--bank-id", "owner"]
            with patch.object(installer.sys, "argv", args), patch.object(installer.subprocess, "run") as run:
                installer.main()
                run.assert_not_called()
            self.assertTrue((Path(root) / "config/profiles/default/agent/models.yml").exists())


    def test_unsupported_python_refuses_before_install_or_configuration(self):
        with patch.object(installer.sys, "version_info", (3, 10)), \
                patch.object(installer.subprocess, "run") as run, \
                patch.object(installer, "configure_pc2") as configure:
            with self.assertRaisesRegex(ValueError, "Python 3.11 or newer"):
                installer.main()
            run.assert_not_called()
            configure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
