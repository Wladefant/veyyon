import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("install_pc2", Path(__file__).with_name("install-pc2.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PC2InstallContract(unittest.TestCase):
    def test_pinned_fork_release_uses_existing_verified_installer(self):
        with tempfile.TemporaryDirectory() as root:
            command, env = installer.install_plan("v1.2.3", Path(root) / "bin", Path(root) / "config", "install.ps1")
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


if __name__ == "__main__":
    unittest.main()
