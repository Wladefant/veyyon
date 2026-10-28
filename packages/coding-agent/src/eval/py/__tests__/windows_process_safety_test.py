"""Accidental Windows signal-zero and KV liveness contracts.

Never call os.kill with signal zero. Synthetic audit events test rejection without
issuing a process operation. Native liveness checks use only this test's child.
This does not claim protection from hostile native code or ctypes bypasses.
"""
import ctypes
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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



def send_and_wait(runner_stdin, lines, request, deadline, frames=None):
    if runner_stdin is not None:
        runner_stdin.write(json.dumps(request) + "\n")
        runner_stdin.flush()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"timed out waiting for done frame for request {request.get('id')}")
        line = lines.get(timeout=remaining)
        frame = json.loads(line)
        if frames is not None:
            frames.append(frame)
        if frame.get("type") == "done" and frame.get("id") == request.get("id"):
            break


@unittest.skipUnless(os.name == "nt", "requires an isolated Windows runner")
class WindowsProcessSafety(unittest.TestCase):
    def test_runner_rejects_zero_signal_audit_without_a_process_operation(self):
        runner = subprocess.Popen(
            [sys.executable, "-u", str(ROOT / "runner.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, creationflags=FLAGS,
        )
        try:
            deadline = time.monotonic() + 15
            lines = queue.Queue()
            def drain():
                for line in runner.stdout:
                    lines.put(line)
            drain_thread = threading.Thread(target=drain, daemon=True)
            drain_thread.start()
            frames = []
            send_and_wait(runner.stdin, lines, {"id": "nonzero", "code": "import sys; sys.audit('os.kill', 123, 15)"}, deadline, frames)
            send_and_wait(runner.stdin, lines, {"id": "guard", "code": "import sys; sys.audit('os.kill', 123, 0)"}, deadline, frames)
            runner.stdin.write(json.dumps({"type": "exit"}) + "\n")
            runner.stdin.flush()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out waiting for runner to exit")
            remaining_output, errors = runner.communicate(timeout=remaining)
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
            drain_thread.join(timeout=1)
    def test_send_and_wait_enforces_hard_deadline_on_continuous_non_done_output(self):
        lines = queue.Queue()
        stop_feeder = threading.Event()
        def feed_continuous_non_done():
            while not stop_feeder.is_set():
                lines.put(json.dumps({"type": "stdout", "data": "streaming chunk\n"}))
                time.sleep(0.005)

        feeder = threading.Thread(target=feed_continuous_non_done, daemon=True)
        feeder.start()
        try:
            deadline = time.monotonic() + 0.2
            start = time.monotonic()
            with self.assertRaises(TimeoutError):
                send_and_wait(None, lines, {"id": "cell1"}, deadline)
            elapsed = time.monotonic() - start
            self.assertGreaterEqual(elapsed, 0.15)
            self.assertLess(elapsed, 2.0, "deadline check did not terminate promptly")
        finally:
            stop_feeder.set()
            feeder.join(timeout=1)

        lines_done = queue.Queue()
        lines_done.put(json.dumps({"type": "stdout", "data": "first chunk\n"}))
        lines_done.put(json.dumps({"type": "done", "id": "cell2", "status": "ok"}))
        received = []
        send_and_wait(None, lines_done, {"id": "cell2"}, time.monotonic() + 5, received)
        self.assertEqual(len(received), 2)
        self.assertEqual(received[1]["type"], "done")

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
