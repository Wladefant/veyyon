"""Accidental Windows signal-zero and KV liveness contracts.

Never call os.kill with signal zero. Synthetic audit events test rejection without
issuing a process operation. Native liveness checks use only this test's child.
This does not claim protection from hostile native code or ctypes bypasses.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import ctypes
from types import SimpleNamespace
from unittest.mock import patch
import unittest

ROOT = Path(__file__).resolve().parents[1]
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

class KvObservationSafety(unittest.TestCase):
    def test_windows_unknown_observations_never_retire_an_owner(self):
        namespace = {"__veyyon_display": lambda *args, **kwargs: None}
        exec(compile((ROOT / "prelude.py").read_text(encoding="utf-8"), "prelude.py", "exec"), namespace)
        namespace["os"] = SimpleNamespace(name="nt")

        class Api:
            def __init__(self, result):
                self.result = result

            def __call__(self, *args):
                return self.result

        for handle, error, wait, expected in (
            (None, 5, 0, True),       # access denied is not death
            (None, 87, 0, False),     # nonexistent process
            (12, 0, 258, True),       # live process
            (12, 0, 0xffffffff, True), # failed observation
            (12, 0, 0, False),        # signalled process handle
        ):
            with self.subTest(handle=handle, error=error, wait=wait):
                close = unittest.mock.Mock()
                dll = SimpleNamespace(
                    OpenProcess=Api(handle), WaitForSingleObject=Api(wait), CloseHandle=close,
                )
                with patch.object(ctypes, "WinDLL", return_value=dll, create=True), patch.object(
                    ctypes, "get_last_error", return_value=error, create=True,
                ):
                    self.assertEqual(namespace["_KvLock"]._is_pid_alive(123), expected)
                self.assertEqual(close.call_count, int(handle is not None))



@unittest.skipUnless(os.name == "nt", "requires an isolated Windows runner")
class WindowsProcessSafety(unittest.TestCase):
    def test_runner_rejects_zero_signal_audit_without_a_process_operation(self):
        runner = subprocess.Popen(
            [sys.executable, "-u", str(ROOT / "runner.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, creationflags=FLAGS,
        )
        try:
            frames = []
            def send_and_wait(request):
                runner.stdin.write(json.dumps(request) + "\n")
                runner.stdin.flush()
                while True:
                    line = runner.stdout.readline()
                    if not line:
                        break
                    frame = json.loads(line)
                    frames.append(frame)
                    if frame.get("type") == "done" and frame.get("id") == request.get("id"):
                        break
            send_and_wait({"id": "nonzero", "code": "import sys; sys.audit('os.kill', 123, 15)"})
            send_and_wait({"id": "guard", "code": "import sys; sys.audit('os.kill', 123, 0)"})
            runner.stdin.write(json.dumps({"type": "exit"}) + "\n")
            runner.stdin.flush()
            remaining_output, errors = runner.communicate(timeout=5)
            for line in remaining_output.splitlines():
                if line.strip():
                    frames.append(json.loads(line))
            output = "\n".join(json.dumps(f) for f in frames)
            failures = [frame for frame in frames if frame.get("type") == "error"]
            self.assertTrue(any(
                frame.get("type") == "done" and frame.get("id") == "nonzero"
                and frame.get("status") == "ok" for frame in frames
            ), output)
            self.assertEqual(len(failures), 1, errors)
            self.assertEqual(failures[0]["ename"], "PermissionError")
            self.assertIn("terminates", failures[0]["evalue"])
            self.assertTrue(any(frame.get("type") == "done" and frame.get("status") == "error" for frame in frames))
        finally:
            if runner.poll() is None:
                runner.kill()
                runner.wait(timeout=5)

    def test_kv_liveness_preserves_live_owner_and_detects_owned_child_exit(self):
        namespace = {"__veyyon_display": lambda *args, **kwargs: None}
        exec(compile((ROOT / "prelude.py").read_text(encoding="utf-8"), "prelude.py", "exec"), namespace)
        lock_type = namespace["_KvLock"]
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"], creationflags=FLAGS,
        )
        try:
            self.assertTrue(lock_type._is_pid_alive(child.pid))
            self.assertIsNone(child.poll(), "liveness observation terminated the owned child")
            with tempfile.TemporaryDirectory() as directory:
                lock = lock_type(Path(directory) / "lock", retries=1, retry_delay=0)
                lock.lock_path.mkdir()
                (lock.lock_path / "info").write_text(json.dumps({"version": 1, "pid": child.pid, "token": "owned-test"}))
                self.assertFalse(lock._reap_stale())
                self.assertTrue(lock.lock_path.exists())
                child.terminate()
                child.wait(timeout=5)
                self.assertFalse(lock_type._is_pid_alive(child.pid))
                self.assertTrue(lock._reap_stale())
                self.assertFalse(lock.lock_path.exists())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
