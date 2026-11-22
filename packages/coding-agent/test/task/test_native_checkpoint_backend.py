"""Run with VEYYON_WORKFLOWS_DIR pointing at an installed WorkerBackend."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


BRIDGE = Path(__file__).resolve().parents[2] / "src/task/native-ledger-bridge.py"
WORKFLOWS = os.environ.get("VEYYON_WORKFLOWS_DIR")
TICKET = "scratch-ticket"
HANDLE = "agent://checkpoint-test"


@unittest.skipUnless(WORKFLOWS, "requires the installed WorkerBackend")
class NativeCheckpointBackend(unittest.TestCase):
    def setUp(self):
        bridge_path = os.environ.get("VEYYON_TEST_NATIVE_LEDGER_BRIDGE", BRIDGE)
        spec = importlib.util.spec_from_file_location("native_ledger_bridge", bridge_path)
        self.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bridge)
        from worker_backend import WorkerBackend
        import worktree_lease

        self.assertIs(self.bridge.WorkerBackend, WorkerBackend)
        self.assertEqual(Path(worktree_lease.__file__).parent.resolve(), Path(WORKFLOWS).resolve())
        scratch = tempfile.TemporaryDirectory(prefix="native-checkpoint-backend-")
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name)
        self.repo = self.scratch / "repo"
        self.repo.mkdir()
        self.ledger = self.scratch / "ledger.json"
        self.git("init", "-q")
        tree = self.git("mktree", input_text="")
        self.head = self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                             "-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "seed")
        self.git("update-ref", "HEAD", self.head)
        self.ledger.write_text(json.dumps({"version": 2, "requests": {TICKET: {
            "state": "review", "head": self.head, "repo_root": str(self.repo),
            "prompt": "Verify the scratch commit", "model": "test-model",
            "authorization": {"status": "authorized", "timestamp": "2026-01-01T00:00:00Z",
                              "scope": "scratch", "authorized_by": "tester"},
        }}}), encoding="utf-8")

        # Keep the real backend lock and registration logic, but redirect its
        # platform-specific control files into this test's scratch directory.
        control = self.scratch / "control"
        (control / "wt-lease-roots").mkdir(parents=True)
        self.enterContext(patch.object(worktree_lease, "_control_path", control.joinpath))
        self.backend = WorkerBackend(state_dir=str(self.scratch))

    def git(self, *args, input_text=None):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args], input=input_text, capture_output=True,
            text=True, timeout=30, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()

    def cli(self, handler, **args):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = handler(argparse.Namespace(ledger=str(self.ledger), timeout=10, **args))
        result = json.loads(stdout.getvalue())
        self.assertEqual(code, 0, result)
        return result

    def claim(self):
        result = self.cli(self.bridge.cmd_claim, worker_id="dispatcher", covered_topics="",
                          active_useful_count=0, target_capacity=1)
        self.assertTrue(result["claimed"], result)
        return result["ticket"]["runId"]

    def dispatch(self, run_id, handle=HANDLE):
        result = self.cli(self.bridge.cmd_record_dispatch, state_dir=str(self.scratch),
                          ticket_id=TICKET, run_id=run_id, task_handle=handle)
        self.assertTrue(result["recorded"], result)

    def record(self, run_id):
        return json.loads((self.scratch / "worker_runs" / run_id / "dispatch.json").read_text(encoding="utf-8"))

    def ticket(self):
        return json.loads(self.ledger.read_text(encoding="utf-8"))["requests"][TICKET]

    def complete(self, error=""):
        run_id = self.claim()
        self.dispatch(run_id)
        passing_result = {
            "stage": "review", "request_id": TICKET, "head_sha": self.head,
            "verdict": "pass", "summary": "verified the scratch commit",
            "checks": [{"name": "head", "command": ["git", "rev-parse", "HEAD"],
                        "exit_code": 0, "observed": self.head, "purpose": "verification"}],
            "artifacts": [],
        }
        result = self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=run_id,
                          task_handle=HANDLE, agent_id=None, result_json=json.dumps(passing_result),
                          result_file=None, exit_code=0, error=error)
        self.assertTrue(result["completed"], result)
        self.assertEqual(result["ok"], not error, result)
        return run_id, passing_result

    def test_passing_result_advances_both_records(self):
        run_id, result = self.complete()
        self.assertEqual(self.ticket()["state"], "awaiting authorization")
        self.assertEqual(self.record(run_id)["state"], "finalized")
        self.assertTrue(self.backend.complete_native(run_id, HANDLE, result).ok)

    def test_checkpoint_error_never_finalizes_a_passing_result(self):
        error = "successor-checkpoint-write-failed: checkpoint disk failure"
        run_id, result = self.complete(error)
        self.assertEqual(self.ticket()["state"], "review")
        self.assertEqual(self.ticket()["blocker"], error)
        record = self.record(run_id)
        self.assertEqual(record["state"], "blocked")
        self.assertFalse(record["outcome"]["ok"])
        self.assertFalse(self.backend.complete_native(run_id, HANDLE, result).ok)
        self.assertEqual(self.record(run_id), record)

    def test_bound_rollback_reclaims_with_a_fresh_backend_run(self):
        old_run = self.claim()
        self.dispatch(old_run)
        args = {"ticket_id": TICKET, "run_id": old_run, "previous_state": "review", "reason": "cancelled before admission"}
        stale = self.cli(self.bridge.cmd_rollback, task_handle="agent://other", **args)
        self.assertFalse(stale["rolled_back"], stale)
        self.assertEqual(self.record(old_run)["state"], "background_dispatched")
        rolled = self.cli(self.bridge.cmd_rollback, task_handle=HANDLE, **args)
        self.assertTrue(rolled["rolled_back"], rolled)
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertEqual(self.record(old_run)["state"], "blocked")
        self.assertFalse(self.record(old_run)["outcome"]["ok"])

        new_run = self.claim()
        self.assertNotEqual(new_run, old_run)
        self.dispatch(new_run, "agent://replacement")
        record = self.record(new_run)
        self.assertEqual(record["retry_of"], old_run)
        self.assertEqual(record["task_handle"], "agent://replacement")
        stale = self.cli(self.bridge.cmd_rollback, task_handle=HANDLE, **args)
        self.assertFalse(stale["rolled_back"], stale)
        self.assertEqual(self.record(new_run), record)
        self.assertEqual(self.ticket()["native_claim"]["run_id"], new_run)


if __name__ == "__main__":
    unittest.main()
