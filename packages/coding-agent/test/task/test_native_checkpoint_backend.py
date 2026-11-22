"""Run with VEYYON_WORKFLOWS_DIR pointing at an installed WorkerBackend."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
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
        self.write_requests({TICKET: self.make_request()})

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

    def make_request(self, prompt="Verify the scratch commit", **overrides):
        req = {
            "state": "review", "head": self.head, "repo_root": str(self.repo),
            "prompt": prompt, "model": "test-model",
            "authorization": {"status": "authorized", "timestamp": "2026-01-01T00:00:00Z",
                              "scope": "scratch", "authorized_by": "tester"},
        }
        req.update(overrides)
        return req

    def write_requests(self, requests):
        self.ledger.write_text(json.dumps({"version": 2, "requests": requests}), encoding="utf-8")

    def claim_raw(self, host_pid=None, worker_id="dispatcher"):
        return self.cli(self.bridge.cmd_claim, worker_id=worker_id, covered_topics="",
                        host_pid=host_pid, active_useful_count=0, target_capacity=1)

    def claim(self, host_pid=None, worker_id="dispatcher"):
        result = self.claim_raw(host_pid=host_pid, worker_id=worker_id)
        self.assertTrue(result["claimed"], result)
        return result["ticket"]["runId"]

    def admit(self, run_id, task_handle=HANDLE, host_pid=None, ticket_id=TICKET):
        return self.cli(self.bridge.cmd_admit, ticket_id=ticket_id, run_id=run_id,
                        task_handle=task_handle, host_pid=host_pid)

    def start_live_owner(self):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        def _cleanup():
            if proc.poll() is None:
                if proc.stdin is not None:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.terminate()
                    proc.wait(timeout=5)

        self.addCleanup(_cleanup)
        self.assertIsNone(proc.poll())
        return proc

    def stop_owner(self, proc):
        pid = proc.pid
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except OSError:
                pass
        proc.wait(timeout=10)
        self.assertIsNotNone(proc.poll())
        return pid

    def dispatch(self, run_id, handle=HANDLE, ticket_id=TICKET):
        result = self.cli(self.bridge.cmd_record_dispatch, state_dir=str(self.scratch),
                          ticket_id=ticket_id, run_id=run_id, task_handle=handle)
        self.assertTrue(result["recorded"], result)

    def record(self, run_id):
        return json.loads((self.scratch / "worker_runs" / run_id / "dispatch.json").read_text(encoding="utf-8"))

    def ticket(self, ticket_id=TICKET):
        return json.loads(self.ledger.read_text(encoding="utf-8"))["requests"][ticket_id]

    def clear_blocker(self, ticket_id=TICKET):
        data = json.loads(self.ledger.read_text(encoding="utf-8"))
        data["requests"][ticket_id]["blocker"] = None
        self.ledger.write_text(json.dumps(data), encoding="utf-8")

    def fail_ledger_rename(self):
        real_replace = os.replace
        ledger_path = self.ledger.resolve()

        def replace(src, dst):
            if Path(dst).resolve() == ledger_path:
                raise OSError("injected ledger rename failure")
            return real_replace(src, dst)

        return patch.object(os, "replace", side_effect=replace)

    def review_result(self, ticket_id=TICKET, verdict="pass", summary="verified the scratch commit"):
        return {
            "stage": "review", "request_id": ticket_id, "head_sha": self.head,
            "verdict": verdict, "summary": summary,
            "checks": [{"name": "head", "command": ["git", "rev-parse", "HEAD"],
                        "exit_code": 0, "observed": self.head, "purpose": "verification"}],
            "artifacts": [],
        }

    def complete(self, error=""):
        run_id = self.claim()
        self.dispatch(run_id)
        passing_result = self.review_result()
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
        self.assertEqual(rolled["retired_run_id"], old_run)
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertEqual(self.record(old_run)["state"], "retired")
        self.assertEqual(self.record(old_run)["task_handle"], HANDLE)
        self.assertNotIn("outcome", self.record(old_run))
        self.assertIsNone(self.backend.get_native_outcome(old_run))

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

    def test_two_early_bound_retirements_allow_third_fresh_claim(self):
        first = self.claim()
        self.dispatch(first, "agent://early-1")
        rolled1 = self.cli(self.bridge.cmd_rollback, ticket_id=TICKET, run_id=first,
                           task_handle="agent://early-1", previous_state="review",
                           reason="cancelled before admission 1")
        self.assertTrue(rolled1["rolled_back"], rolled1)
        self.assertEqual(rolled1["retired_run_id"], first)
        self.assertEqual(self.record(first)["state"], "retired")
        self.assertNotIn("outcome", self.record(first))
        self.assertNotIn("recurrence", self.record(first))
        self.assertIsNone(self.backend.get_native_outcome(first))

        second = self.claim()
        self.assertNotEqual(second, first)
        self.assertEqual(self.record(second)["retry_of"], first)
        self.dispatch(second, "agent://early-2")
        rolled2 = self.cli(self.bridge.cmd_rollback, ticket_id=TICKET, run_id=second,
                           task_handle="agent://early-2", previous_state="review",
                           reason="cancelled before admission 2")
        self.assertTrue(rolled2["rolled_back"], rolled2)
        self.assertEqual(rolled2["retired_run_id"], second)
        self.assertEqual(self.record(second)["state"], "retired")
        self.assertNotIn("outcome", self.record(second))
        self.assertNotIn("recurrence", self.record(second))
        self.assertIsNone(self.backend.get_native_outcome(second))

        third = self.claim()
        self.assertNotIn(third, (first, second))
        self.assertEqual(self.record(third)["retry_of"], second)
        self.assertEqual(self.record(third)["state"], "prepared")
        self.dispatch(third, "agent://early-3")
        done = self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=third,
                        task_handle="agent://early-3", agent_id=None,
                        result_json=json.dumps(self.review_result()), result_file=None,
                        exit_code=0, error="")
        self.assertTrue(done["completed"], done)
        self.assertTrue(done["ok"], done)
        self.assertEqual(self.ticket()["state"], "awaiting authorization")
        self.assertEqual(self.record(third)["state"], "finalized")

    def test_genuine_recurrence_refusal_after_two_real_failures(self):
        first = self.claim()
        self.dispatch(first, "agent://fail-1")
        res1 = self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=first,
                        task_handle="agent://fail-1", agent_id=None,
                        result_json=json.dumps(self.review_result(verdict="fail", summary="first real defect")),
                        result_file=None, exit_code=0, error="")
        self.assertTrue(res1["completed"], res1)
        self.assertFalse(res1["ok"], res1)
        self.assertEqual(self.record(first)["state"], "blocked")
        self.assertIn("recurrence", self.record(first))
        self.clear_blocker(TICKET)

        second = self.claim()
        self.assertNotEqual(second, first)
        self.dispatch(second, "agent://fail-2")
        res2 = self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=second,
                        task_handle="agent://fail-2", agent_id=None,
                        result_json=json.dumps(self.review_result(verdict="fail", summary="second real defect")),
                        result_file=None, exit_code=0, error="")
        self.assertTrue(res2["completed"], res2)
        self.assertFalse(res2["ok"], res2)
        self.assertEqual(self.record(second)["state"], "blocked")
        self.assertIn("recurrence", self.record(second))
        self.clear_blocker(TICKET)

        refused = self.claim_raw()
        self.assertFalse(refused["claimed"], refused)
        self.assertIn("will not be retried unchanged", refused["reason"])
        self.assertEqual([b["ticketId"] for b in refused["blockedTopics"]], [TICKET])
        self.assertIn("will not be retried unchanged", refused["blockedTopics"][0]["reason"])
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertEqual(self.ticket()["state"], "review")

    def test_torn_bind_rollback_with_null_ledger_handle_retires_observed_backend_handle(self):
        old_run = self.claim()
        with self.fail_ledger_rename():
            with self.assertRaises(OSError):
                self.cli(self.bridge.cmd_record_dispatch, state_dir=str(self.scratch),
                         ticket_id=TICKET, run_id=old_run, task_handle=HANDLE)
        self.assertIsNone(self.ticket()["native_claim"]["task_handle"])
        self.assertEqual(self.record(old_run)["state"], "background_dispatched")
        self.assertEqual(self.record(old_run)["task_handle"], HANDLE)

        wrong = self.cli(self.bridge.cmd_rollback, ticket_id=TICKET, run_id=old_run,
                         task_handle="agent://other", previous_state="review", reason="wrong handle")
        self.assertFalse(wrong["rolled_back"], wrong)
        self.assertEqual(self.record(old_run)["state"], "background_dispatched")

        rolled = self.cli(self.bridge.cmd_rollback, ticket_id=TICKET, run_id=old_run,
                          task_handle="", previous_state="review", reason="torn dispatch failed")
        self.assertTrue(rolled["rolled_back"], rolled)
        self.assertEqual(rolled["retired_run_id"], old_run)
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertEqual(self.record(old_run)["state"], "retired")
        self.assertEqual(self.record(old_run)["task_handle"], HANDLE)
        self.assertNotIn("outcome", self.record(old_run))
        self.assertIsNone(self.backend.get_native_outcome(old_run))

        new_run = self.claim()
        self.assertNotEqual(new_run, old_run)
        self.assertEqual(self.record(new_run)["retry_of"], old_run)
        self.dispatch(new_run, "agent://replacement")
        self.assertEqual(self.record(new_run)["state"], "background_dispatched")
        self.assertEqual(self.record(new_run)["task_handle"], "agent://replacement")

    def test_orphaned_bound_recover_protects_live_handle_and_retires_absent_worker(self):
        owner = self.start_live_owner()
        old_run = self.claim(host_pid=owner.pid)
        with self.fail_ledger_rename():
            with self.assertRaises(OSError):
                self.cli(self.bridge.cmd_record_dispatch, state_dir=str(self.scratch),
                         ticket_id=TICKET, run_id=old_run, task_handle=HANDLE)
        live_torn = self.cli(self.bridge.cmd_recover, running_worker_ids="checkpoint-test")
        self.assertEqual(live_torn["recovered"], [], live_torn)
        self.assertEqual(self.record(old_run)["state"], "background_dispatched")
        self.assertEqual(self.ticket()["native_claim"]["state"], "active")
        self.assertEqual(self.ticket()["native_claim"]["task_handle"], HANDLE)
        self.assertEqual(self.ticket()["native_claim"]["worker_id"], "checkpoint-test")
        self.assertEqual(self.ticket()["native_claim"]["host"]["pid"], owner.pid)

        live_bound = self.cli(self.bridge.cmd_recover, running_worker_ids="checkpoint-test")
        self.assertEqual(live_bound["recovered"], [], live_bound)
        self.assertEqual(self.record(old_run)["state"], "background_dispatched")
        self.assertEqual(self.ticket()["native_claim"]["state"], "active")

        dead_pid = self.stop_owner(owner)
        orphaned = self.cli(self.bridge.cmd_recover, running_worker_ids="unrelated-worker")
        self.assertEqual(orphaned["recovered"], [TICKET], orphaned)
        self.assertEqual(orphaned["retired"], [TICKET], orphaned)
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertEqual(self.ticket()["history"][-1]["native_retired_run_id"], old_run)
        self.assertEqual(self.record(old_run)["state"], "retired")
        self.assertEqual(self.record(old_run)["task_handle"], HANDLE)
        self.assertNotIn("outcome", self.record(old_run))
        self.assertIsNone(self.backend.get_native_outcome(old_run))

        new_run = self.claim(host_pid=os.getpid())
        self.assertNotEqual(new_run, old_run)
        self.assertEqual(self.record(new_run)["retry_of"], old_run)
        self.dispatch(new_run, "agent://recovered-replacement")
        self.assertEqual(self.record(new_run)["state"], "background_dispatched")
        self.assertTrue(self.admit(new_run, "agent://recovered-replacement", host_pid=os.getpid())["admitted"])
        stale_admit = self.admit(old_run, HANDLE, host_pid=dead_pid)
        self.assertFalse(stale_admit["admitted"], stale_admit)
        self.assertTrue(stale_admit.get("error"), stale_admit)

    def test_torn_terminal_write_recovers_exact_success_once(self):
        run_id = self.claim()
        self.dispatch(run_id)
        passing = self.review_result()
        with self.fail_ledger_rename():
            with self.assertRaises(OSError):
                self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=run_id,
                         task_handle=HANDLE, agent_id=None, result_json=json.dumps(passing),
                         result_file=None, exit_code=0, error="")
        self.assertEqual(self.record(run_id)["state"], "finalized")
        self.assertTrue(self.record(run_id)["outcome"]["ok"])
        self.assertEqual(self.ticket()["state"], "review")
        self.assertEqual(self.ticket()["native_claim"]["state"], "active")

        rec = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(rec["recovered"], [TICKET], rec)
        self.assertNotIn("retired", rec)
        self.assertEqual(rec["reconciled_outcomes"], [{
            "ticket_id": TICKET, "run_id": run_id, "ok": True, "state": "awaiting authorization",
        }])
        ticket = self.ticket()
        self.assertEqual(ticket["state"], "awaiting authorization")
        self.assertEqual(ticket["native_claim"]["state"], "retryable")
        self.assertEqual(len(ticket["evidence"]), 1)
        worker_entries = [e for e in ticket["history"] if e.get("actor") == "WorkerBackend"]
        self.assertEqual(len(worker_entries), 1)
        self.assertEqual(worker_entries[0]["native_run_id"], run_id)
        self.assertEqual(worker_entries[0]["to_state"], "awaiting authorization")

        rec_again = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(rec_again["recovered"], [], rec_again)
        self.assertFalse(self.claim_raw()["claimed"])
        late = self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=run_id,
                        task_handle=HANDLE, agent_id=None, result_json=json.dumps(passing),
                        result_file=None, exit_code=0, error="")
        self.assertFalse(late["completed"], late)
        self.assertEqual(self.ticket(), ticket)

    def test_torn_build_result_cannot_rewind_a_newer_request_head(self):
        request = self.ticket()
        request["state"] = "implementation"
        request["stage"] = "build"
        self.write_requests({TICKET: request})
        run_id = self.claim()
        self.dispatch(run_id)
        tree = self.git("rev-parse", "HEAD^{tree}")

        def advance_commit(parent, message):
            head = self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                            "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", parent, "-m", message)
            self.git("update-ref", "HEAD", head, parent)
            return head

        old_result_head = advance_commit(self.head, "worker output")
        passing = {**self.review_result(), "stage": "build", "head_sha": old_result_head}
        with self.fail_ledger_rename(), self.assertRaises(OSError):
            self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=run_id,
                     task_handle=HANDLE, agent_id=None, result_json=json.dumps(passing),
                     result_file=None, exit_code=0, error="")
        durable = self.record(run_id)
        self.assertEqual(durable["state"], "finalized")
        self.assertTrue(durable["outcome"]["ok"])
        new_head = advance_commit(old_result_head, "new request head")
        request = self.ticket()
        request["head"] = new_head
        self.write_requests({TICKET: request})

        recovered = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(recovered["reconciled_outcomes"], [{
            "ticket_id": TICKET, "run_id": run_id, "ok": False, "discarded": True,
            "state": "implementation",
        }])
        request = self.ticket()
        self.assertEqual(request["head"], new_head)
        self.assertEqual(request["state"], "implementation")
        self.assertFalse(request.get("evidence"))
        self.assertEqual(request["native_claim"]["state"], "retryable")
        self.assertEqual(self.record(run_id), durable)
        self.assertEqual(self.cli(self.bridge.cmd_recover, running_worker_ids="")["recovered"], [])
        next_attempt = self.claim_raw(host_pid=os.getpid())
        self.assertTrue(next_attempt["claimed"], next_attempt)
        self.assertEqual(next_attempt["ticket"]["head"], new_head)
        self.assertNotEqual(next_attempt["ticket"]["runId"], run_id)

    def test_candidate_local_recurrence_refusal_claims_unrelated_eligible_ticket(self):
        self.write_requests({
            "alpha-blocked": self.make_request(prompt="Verify alpha commit", topic="Workflow"),
            "beta-ready": self.make_request(prompt="Verify beta commit", topic="Workflow"),
        })
        for idx, handle in enumerate(("agent://alpha-1", "agent://alpha-2"), start=1):
            first_claim = self.claim_raw()
            self.assertTrue(first_claim["claimed"], first_claim)
            self.assertEqual(first_claim["ticket"]["id"], "alpha-blocked")
            run_id = first_claim["ticket"]["runId"]
            self.dispatch(run_id, handle, ticket_id="alpha-blocked")
            res = self.cli(
                self.bridge.cmd_complete, ticket_id="alpha-blocked", run_id=run_id,
                task_handle=handle, agent_id=None,
                result_json=json.dumps(self.review_result(
                    ticket_id="alpha-blocked", verdict="fail", summary=f"alpha failure {idx}",
                )),
                result_file=None, exit_code=0, error="",
            )
            self.assertTrue(res["completed"], res)
            self.assertFalse(res["ok"], res)
            self.clear_blocker("alpha-blocked")

        claimed_beta = self.claim_raw()
        self.assertTrue(claimed_beta["claimed"], claimed_beta)
        self.assertEqual(claimed_beta["ticket"]["id"], "beta-ready")
        self.assertEqual([b["ticketId"] for b in claimed_beta["blockedTopics"]], ["alpha-blocked"])
        self.assertIn("will not be retried unchanged", claimed_beta["blockedTopics"][0]["reason"])
        self.assertEqual(self.ticket("alpha-blocked")["native_claim"]["state"], "retryable")
        self.assertEqual(self.ticket("beta-ready")["native_claim"]["state"], "active")

        beta_run = claimed_beta["ticket"]["runId"]
        self.dispatch(beta_run, "agent://beta-1", ticket_id="beta-ready")
        done = self.cli(
            self.bridge.cmd_complete, ticket_id="beta-ready", run_id=beta_run,
            task_handle="agent://beta-1", agent_id=None,
            result_json=json.dumps(self.review_result(ticket_id="beta-ready")),
            result_file=None, exit_code=0, error="",
        )
        self.assertTrue(done["completed"], done)
        self.assertTrue(done["ok"], done)
        self.assertEqual(self.ticket("beta-ready")["state"], "awaiting authorization")
        self.assertEqual(self.record(beta_run)["state"], "finalized")

    def test_stale_unbound_rollback_fails_after_recovery_and_replacement_bind(self):
        owner_a = self.start_live_owner()
        run_a = self.claim(host_pid=owner_a.pid)
        dead_pid = self.stop_owner(owner_a)
        rec = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(rec["recovered"], [TICKET], rec)
        self.assertEqual(rec["retired"], [TICKET], rec)
        self.assertEqual(self.record(run_a)["state"], "retired")
        self.assertIsNone(self.record(run_a)["task_handle"])
        self.assertNotIn("outcome", self.record(run_a))
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")

        run_b = self.claim(host_pid=os.getpid())
        self.assertNotEqual(run_b, run_a)
        self.assertEqual(self.record(run_b)["retry_of"], run_a)
        self.dispatch(run_b, "agent://replacement-b")
        record_b = self.record(run_b)

        stale = self.cli(self.bridge.cmd_rollback, ticket_id=TICKET, run_id=run_a,
                         task_handle="", previous_state="review", reason="stale unbound rollback")
        self.assertFalse(stale["rolled_back"], stale)
        self.assertEqual(self.record(run_a)["state"], "retired")
        self.assertEqual(self.record(run_b), record_b)
        self.assertEqual(self.ticket()["native_claim"]["run_id"], run_b)
        self.assertEqual(self.ticket()["native_claim"]["task_handle"], "agent://replacement-b")
        self.assertTrue(self.admit(run_b, "agent://replacement-b", host_pid=os.getpid())["admitted"])
        stale_admit = self.admit(run_a, "agent://replacement-b", host_pid=dead_pid)
        self.assertFalse(stale_admit["admitted"], stale_admit)
        self.assertTrue(stale_admit.get("error"), stale_admit)

    def test_live_same_host_owner_keeps_bound_and_prepared_claims_when_other_registry_is_empty(self):
        self.write_requests({
            "1-bound-live": self.make_request(prompt="Bound live owner"),
            "2-prepared-live": self.make_request(prompt="Prepared live owner"),
        })
        bound_owner = self.start_live_owner()
        bound_run = self.claim(host_pid=bound_owner.pid)
        bound_host = self.ticket("1-bound-live")["native_claim"]["host"]
        self.assertEqual(set(bound_host), {"name", "pid", "started"})
        self.assertTrue(bound_host["started"])
        self.assertIsInstance(bound_host["name"], str)
        self.assertTrue(bound_host["name"].strip())
        self.assertEqual(bound_host["pid"], bound_owner.pid)
        self.dispatch(bound_run, "agent://live-bound", ticket_id="1-bound-live")
        self.assertTrue(self.admit(bound_run, "agent://live-bound", host_pid=bound_owner.pid,
                                   ticket_id="1-bound-live")["admitted"])

        prepared_owner = self.start_live_owner()
        prepared_run = self.claim(host_pid=prepared_owner.pid)
        self.assertEqual(self.ticket("2-prepared-live")["native_claim"]["host"]["pid"], prepared_owner.pid)

        for roster in ("", "foreign-sdk-worker"):
            rec = self.cli(self.bridge.cmd_recover, running_worker_ids=roster)
            self.assertEqual(rec["recovered"], [], rec)
            self.assertNotIn("retired", rec)

        self.assertEqual(self.ticket("1-bound-live")["native_claim"]["state"], "active")
        self.assertEqual(self.ticket("1-bound-live")["native_claim"]["task_handle"], "agent://live-bound")
        self.assertEqual(self.ticket("1-bound-live")["native_claim"]["host"], bound_host)
        self.assertEqual(self.record(bound_run)["state"], "background_dispatched")
        self.assertEqual(self.ticket("2-prepared-live")["native_claim"]["state"], "active")
        self.assertIsNone(self.ticket("2-prepared-live")["native_claim"]["task_handle"])
        self.assertEqual(self.record(prepared_run)["state"], "prepared")
        self.assertTrue(self.admit(bound_run, "agent://live-bound", host_pid=bound_owner.pid,
                                   ticket_id="1-bound-live")["admitted"])

    def test_reused_pid_does_not_admit_or_pin_the_old_owner(self):
        owner_a = self.start_live_owner()
        old_run = self.claim(host_pid=owner_a.pid)
        self.dispatch(old_run, "agent://owner-a")
        req = self.ticket()
        # The OS still reports this live PID. A different birth identity means
        # it cannot be the process that owned the persisted claim.
        req["native_claim"]["host"]["started"] += ":old-birth"
        self.write_requests({TICKET: req})
        rejected = self.admit(old_run, "agent://owner-a", host_pid=owner_a.pid)
        self.assertFalse(rejected["admitted"], rejected)
        self.assertIn("creation identity", rejected["error"])
        recovered = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(recovered["recovered"], [TICKET], recovered)
        self.assertEqual(self.record(old_run)["state"], "retired")
        self.assertIsNone(owner_a.poll(), "Recovery must not signal the process holding the reused PID")
        new_run = self.claim(host_pid=os.getpid())
        self.assertNotEqual(new_run, old_run)
        self.dispatch(new_run, "agent://replacement-after-reuse")
        self.assertTrue(self.admit(new_run, "agent://replacement-after-reuse", host_pid=os.getpid())["admitted"])

    def test_owner_exit_recovery_repairs_and_admits_only_replacement_owner(self):
        owner_a = self.start_live_owner()
        old_run = self.claim(host_pid=owner_a.pid)
        self.dispatch(old_run, "agent://owner-a")
        self.assertTrue(self.admit(old_run, "agent://owner-a", host_pid=owner_a.pid)["admitted"])
        wrong_pid = self.admit(old_run, "agent://owner-a", host_pid=os.getpid())
        self.assertFalse(wrong_pid["admitted"], wrong_pid)
        self.assertTrue(wrong_pid.get("error"), wrong_pid)

        still_live = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(still_live["recovered"], [], still_live)
        self.assertEqual(self.record(old_run)["state"], "background_dispatched")

        dead_pid = self.stop_owner(owner_a)
        repaired = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(repaired["recovered"], [TICKET], repaired)
        self.assertEqual(repaired["retired"], [TICKET], repaired)
        self.assertEqual(self.record(old_run)["state"], "retired")
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertEqual(self.ticket()["history"][-1]["native_retired_run_id"], old_run)

        for probe_pid in (dead_pid, os.getpid()):
            stale = self.admit(old_run, "agent://owner-a", host_pid=probe_pid)
            self.assertFalse(stale["admitted"], stale)
            self.assertTrue(stale.get("error"), stale)

        new_run = self.claim(host_pid=os.getpid())
        self.assertNotEqual(new_run, old_run)
        self.assertEqual(self.record(new_run)["retry_of"], old_run)
        self.dispatch(new_run, "agent://owner-b")
        self.assertTrue(self.admit(new_run, "agent://owner-b", host_pid=os.getpid())["admitted"])

        for args in (
            (old_run, "agent://owner-a", dead_pid),
            (old_run, "agent://owner-a", os.getpid()),
            (new_run, "agent://owner-a", os.getpid()),
            (new_run, "agent://owner-b", dead_pid),
        ):
            rejected = self.admit(*args)
            self.assertFalse(rejected["admitted"], (args, rejected))
            self.assertTrue(rejected.get("error"), (args, rejected))

    def test_stale_queued_admit_rejected_after_rollback_and_replacement(self):
        old_run = self.claim(host_pid=os.getpid())
        self.dispatch(old_run, "agent://queued-old")
        self.assertTrue(self.admit(old_run, "agent://queued-old", host_pid=os.getpid())["admitted"])

        rolled = self.cli(self.bridge.cmd_rollback, ticket_id=TICKET, run_id=old_run,
                          task_handle="agent://queued-old", previous_state="review",
                          reason="cancelled while queued")
        self.assertTrue(rolled["rolled_back"], rolled)
        after_rollback = self.admit(old_run, "agent://queued-old", host_pid=os.getpid())
        self.assertFalse(after_rollback["admitted"], after_rollback)
        self.assertTrue(after_rollback.get("error"), after_rollback)

        new_run = self.claim(host_pid=os.getpid())
        self.assertNotEqual(new_run, old_run)
        self.dispatch(new_run, "agent://queued-new")
        self.assertTrue(self.admit(new_run, "agent://queued-new", host_pid=os.getpid())["admitted"])
        after_replace = self.admit(old_run, "agent://queued-old", host_pid=os.getpid())
        self.assertFalse(after_replace["admitted"], after_replace)
        self.assertTrue(after_replace.get("error"), after_replace)

    def test_foreign_anonymous_roster_live_and_malformed_owners_preserved_and_legacy_direct_ops_work(self):
        self.write_requests({
            "1-foreign-dead": self.make_request(prompt="Foreign host dead numeric pid"),
            "2-anonymous-legacy": self.make_request(prompt="Anonymous legacy claim"),
            "3-dead-roster-live": self.make_request(prompt="Dead pid still in running roster"),
            "4-malformed-host": self.make_request(prompt="Malformed host claim"),
            "5-anonymous-rollback": self.make_request(prompt="Anonymous legacy rollback"),
        })
        foreign_proc = self.start_live_owner()
        foreign_run = self.claim(host_pid=foreign_proc.pid)
        self.dispatch(foreign_run, "agent://foreign-worker", ticket_id="1-foreign-dead")
        foreign_pid = self.stop_owner(foreign_proc)

        legacy_run = self.claim(host_pid=None)
        self.dispatch(legacy_run, "agent://legacy-worker", ticket_id="2-anonymous-legacy")
        self.assertNotIn("host", self.ticket("2-anonymous-legacy")["native_claim"])

        roster_proc = self.start_live_owner()
        roster_run = self.claim(host_pid=roster_proc.pid)
        self.dispatch(roster_run, "agent://roster-worker", ticket_id="3-dead-roster-live")
        self.stop_owner(roster_proc)

        malformed_run = self.claim(host_pid=os.getpid())
        self.dispatch(malformed_run, "agent://malformed-worker", ticket_id="4-malformed-host")

        legacy_rb_run = self.claim(host_pid=None)
        self.dispatch(legacy_rb_run, "agent://legacy-rb", ticket_id="5-anonymous-rollback")

        ledger_data = json.loads(self.ledger.read_text(encoding="utf-8"))
        ledger_data["requests"]["1-foreign-dead"]["native_claim"]["host"]["name"] = "foreign-sdk-host.invalid"
        ledger_data["requests"]["4-malformed-host"]["native_claim"]["host"] = {"name": "local", "pid": 0}
        self.ledger.write_text(json.dumps(ledger_data), encoding="utf-8")

        rec = self.cli(self.bridge.cmd_recover, running_worker_ids="roster-worker")
        self.assertEqual(rec["recovered"], [], rec)
        self.assertNotIn("retired", rec)
        for tid, rid in (
            ("1-foreign-dead", foreign_run),
            ("2-anonymous-legacy", legacy_run),
            ("3-dead-roster-live", roster_run),
            ("4-malformed-host", malformed_run),
            ("5-anonymous-rollback", legacy_rb_run),
        ):
            self.assertEqual(self.ticket(tid)["native_claim"]["state"], "active", tid)
            self.assertEqual(self.record(rid)["state"], "background_dispatched", tid)

        foreign_admit = self.admit(foreign_run, "agent://foreign-worker", host_pid=foreign_pid,
                                   ticket_id="1-foreign-dead")
        self.assertFalse(foreign_admit["admitted"], foreign_admit)
        self.assertTrue(foreign_admit.get("error"), foreign_admit)

        done = self.cli(self.bridge.cmd_complete, ticket_id="2-anonymous-legacy", run_id=legacy_run,
                        task_handle="agent://legacy-worker", agent_id=None,
                        result_json=json.dumps(self.review_result(ticket_id="2-anonymous-legacy")),
                        result_file=None, exit_code=0, error="")
        self.assertTrue(done["completed"], done)
        self.assertTrue(done["ok"], done)
        self.assertEqual(self.ticket("2-anonymous-legacy")["state"], "awaiting authorization")
        self.assertEqual(self.ticket("2-anonymous-legacy")["native_claim"]["state"], "retryable")

        rolled = self.cli(self.bridge.cmd_rollback, ticket_id="5-anonymous-rollback", run_id=legacy_rb_run,
                          task_handle="agent://legacy-rb", previous_state="review",
                          reason="legacy direct rollback")
        self.assertTrue(rolled["rolled_back"], rolled)
        self.assertEqual(self.ticket("5-anonymous-rollback")["native_claim"]["state"], "retryable")
        self.assertEqual(self.record(legacy_rb_run)["state"], "retired")

    def test_admit_rejects_unbound_torn_bind_and_live_handle_mismatch_without_healing_while_projecting_terminal_outcome(self):
        run_id = self.claim(host_pid=os.getpid())
        unbound_admit = self.admit(run_id, HANDLE, host_pid=os.getpid())
        self.assertFalse(unbound_admit["admitted"], unbound_admit)
        self.assertTrue(unbound_admit.get("error"), unbound_admit)

        with self.fail_ledger_rename():
            with self.assertRaises(OSError):
                self.cli(self.bridge.cmd_record_dispatch, state_dir=str(self.scratch),
                         ticket_id=TICKET, run_id=run_id, task_handle=HANDLE)
        torn_admit = self.admit(run_id, HANDLE, host_pid=os.getpid())
        self.assertFalse(torn_admit["admitted"], torn_admit)
        self.assertTrue(torn_admit.get("error"), torn_admit)

        ledger_data = json.loads(self.ledger.read_text(encoding="utf-8"))
        host_info = ledger_data["requests"][TICKET]["native_claim"]["host"]
        ledger_data["requests"][TICKET]["native_claim"] = {
            "version": 1, "state": "active", "worker_id": "other-worker",
            "run_id": run_id, "task_handle": "agent://other-worker", "host": host_info,
        }
        self.ledger.write_text(json.dumps(ledger_data), encoding="utf-8")

        mismatch_rec = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(mismatch_rec["recovered"], [], mismatch_rec)
        self.assertTrue(mismatch_rec.get("errors"), mismatch_rec)
        self.assertEqual(self.ticket()["native_claim"]["task_handle"], "agent://other-worker")
        self.assertEqual(self.ticket()["native_claim"]["worker_id"], "other-worker")
        self.assertEqual(self.record(run_id)["state"], "background_dispatched")
        self.assertEqual(self.record(run_id)["task_handle"], HANDLE)
        self.assertFalse(self.admit(run_id, "agent://other-worker", host_pid=os.getpid())["admitted"])
        self.assertFalse(self.admit(run_id, HANDLE, host_pid=os.getpid())["admitted"])

        ledger_data = json.loads(self.ledger.read_text(encoding="utf-8"))
        ledger_data["requests"][TICKET]["native_claim"] = {
            "version": 1, "state": "active", "worker_id": "checkpoint-test",
            "run_id": run_id, "task_handle": HANDLE,
            "host": {"name": "foreign-terminal.invalid", "pid": os.getpid()},
        }
        self.ledger.write_text(json.dumps(ledger_data), encoding="utf-8")
        self.assertFalse(self.admit(run_id, HANDLE, host_pid=os.getpid())["admitted"])
        with self.fail_ledger_rename():
            with self.assertRaises(OSError):
                self.cli(self.bridge.cmd_complete, ticket_id=TICKET, run_id=run_id,
                         task_handle=HANDLE, agent_id=None,
                         result_json=json.dumps(self.review_result()),
                         result_file=None, exit_code=0, error="")

        terminal_rec = self.cli(self.bridge.cmd_recover, running_worker_ids="")
        self.assertEqual(terminal_rec["recovered"], [TICKET], terminal_rec)
        self.assertNotIn("retired", terminal_rec)
        self.assertEqual(self.ticket()["state"], "awaiting authorization")
        self.assertEqual(self.ticket()["native_claim"]["state"], "retryable")
        self.assertFalse(self.admit(run_id, HANDLE, host_pid=os.getpid())["admitted"])


if __name__ == "__main__":
    unittest.main()
