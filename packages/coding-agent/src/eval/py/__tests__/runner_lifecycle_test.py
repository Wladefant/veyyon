"""Real runner ownership checks. No model calls or running Veyyon sessions."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).resolve().parents[1] / "runner.py"
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def alive(pid):
    if os.name == "nt":
        dll = ctypes.WinDLL("kernel32", use_last_error=True)
        dll.OpenProcess.restype = ctypes.c_void_p
        dll.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        dll.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = dll.OpenProcess(0x100000, False, pid)
        if not handle:
            return False
        try:
            return dll.WaitForSingleObject(handle, 0) == 258
        finally:
            dll.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class RunnerLifecycle(unittest.TestCase):
    def run_scenario(self, shutdown):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "pids.json"
            owner_script = Path(directory) / "owner.py"
            owner_script.write_text('''import json, subprocess, sys, time
p = subprocess.Popen([sys.executable, '-u', sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=''' + str(FLAGS) + ''')
code = "import subprocess, sys, time; child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], creationflags=" + str(''' + str(FLAGS) + ''') + "); print(child.pid)"
p.stdin.write((json.dumps({'id':'one','code':code})+'\\n').encode()); p.stdin.flush()
child = None
while True:
    frame = json.loads(p.stdout.readline())
    if frame['type'] == 'stdout':
        try: child = int(frame['data'].strip())
        except ValueError: pass
    if frame['type'] == 'done': break
open(sys.argv[2], 'w').write(json.dumps([p.pid, child]))
if sys.argv[3] == 'exit':
    p.stdin.write(b'{"type":"exit"}\\n'); p.stdin.flush(); p.wait(timeout=10)
else:
    p.stdin.write((json.dumps({'id':'block','code':'import time; time.sleep(120)'})+'\\n').encode()); p.stdin.flush()
    time.sleep(120)
''', encoding="utf-8")
            owner = subprocess.Popen([sys.executable, str(owner_script), str(RUNNER), str(receipt), shutdown], creationflags=FLAGS)
            pids = []
            try:
                deadline = time.monotonic() + 15
                while not receipt.exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertTrue(receipt.exists(), "owner never completed its eval")
                pids = json.loads(receipt.read_text())
                self.assertIsNotNone(pids[1], "runner did not report its descendant")
                if shutdown == "cancel":
                    owner.kill()
                owner.wait(timeout=12)
                deadline = time.monotonic() + 8
                while any(alive(pid) for pid in pids) and time.monotonic() < deadline:
                    time.sleep(.1)
                count = int(alive(pids[0]))
                print(f"{shutdown}: runner baseline=0 started=1 after={count}; descendant after={int(alive(pids[1]))}", flush=True)
                self.assertEqual(count, 0, "runner survived owner cancellation")
                self.assertFalse(alive(pids[1]), "eval descendant survived runner exit")
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=5)
                for pid in pids:
                    if alive(pid):
                        if os.name == "nt":
                            subprocess.run(["taskkill.exe", "/PID", str(pid), "/T", "/F"], timeout=5, creationflags=FLAGS, capture_output=True)
                        else:
                            os.kill(pid, 9)

    def run_veyyon_scenario(self, mode):
        import queue
        import threading
        fixture = "runner-startup-owner-probe.ts" if mode in ("startup", "shared") else "runner-owner-probe.ts"
        probe = Path(os.environ.get("VEYYON_RUNNER_PROBE_PATH", str(RUNNER.parent / "__tests__" / fixture)))
        home = tempfile.TemporaryDirectory(prefix="veyyon-runner-probe-home-")
        env = {**os.environ, "HOME": home.name, "USERPROFILE": home.name, "LOCALAPPDATA": home.name}
        env.pop("VEYYON_CONFIG_DIR", None)
        owner = subprocess.Popen(["bun", "run", str(probe), mode], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=FLAGS, env=env)
        lines = queue.Queue()
        def drain():
            for line in owner.stdout:
                lines.put(line.strip())
        runner = None
        drain_thread = threading.Thread(target=drain, daemon=True)
        drain_thread.start()
        try:
            runner = int(lines.get(timeout=15))
            self.assertEqual(lines.get(timeout=15), "EVAL_READY")
            if mode == "cancel":
                self.assertEqual(lines.get(timeout=15), "BLOCK_STARTED")
                owner.kill()
            if mode in ("startup", "shared"):
                if mode == "shared":
                    self.assertEqual(lines.get(timeout=15), "SHARED_EXECUTED")
                self.assertEqual(lines.get(timeout=15), "LANE_FINISHED")
                self.assertIsNone(owner.poll(), "host died before the ownership check")
            else:
                owner.wait(timeout=15)
            deadline = time.monotonic() + 8
            while alive(runner) and time.monotonic() < deadline:
                time.sleep(.1)
            count = int(alive(runner))
            print(f"veyyon-{mode}: runner baseline=0 started=1 after={count}", flush=True)
            self.assertEqual(count, 0)
        finally:
            if owner.poll() is None:
                owner.kill()
                owner.wait(timeout=5)
            if runner and alive(runner):
                subprocess.run(["taskkill.exe", "/PID", str(runner), "/T", "/F"], timeout=5, creationflags=FLAGS, capture_output=True)
            drain_thread.join(timeout=5)
            owner.stdout.close()
            owner.stderr.close()
            home.cleanup()

    @unittest.skipUnless(os.name == "nt", "Windows runner ownership")
    def test_veyyon_kernel_exit(self):
        self.run_veyyon_scenario("exit")

    @unittest.skipUnless(os.name == "nt", "Windows runner ownership")
    def test_veyyon_kernel_cancel(self):
        self.run_veyyon_scenario("cancel")
    @unittest.skipUnless(os.name == "nt", "Windows runner ownership")
    def test_cancelled_startup_releases_kernel_while_host_lives(self):
        self.run_veyyon_scenario("startup")

    @unittest.skipUnless(os.name == "nt", "Windows runner ownership")
    def test_cancelled_startup_preserves_active_shared_owner(self):
        self.run_veyyon_scenario("shared")


    def test_exit_releases_descendants(self):
        self.run_scenario("exit")

    def test_cancelled_owner_releases_runner_and_descendants(self):
        self.run_scenario("cancel")


if __name__ == "__main__":
    unittest.main(verbosity=2)
