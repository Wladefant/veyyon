#!/usr/bin/env python3
"""
native-ledger-bridge.py - Isolated host adapter bridge for native topic replenishment.

Enforces cross-process mutual exclusion via OS-level advisory locking (msvcrt on Windows,
fcntl on POSIX).

Integrates with portable WorkerBackend (prepare_native -> record_native_dispatch -> complete_native)
so canonical result validation governs stage progression without duplicate completion logic.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
import uuid
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

workflows_dir = os.environ.get("VEYYON_WORKFLOWS_DIR")
if workflows_dir and os.path.isdir(workflows_dir) and workflows_dir not in sys.path:
    sys.path.insert(0, workflows_dir)

# Import FileLock
FileLock = None
if workflows_dir:
    try:
        from ledger import FileLock as _WorkflowsFileLock
        FileLock = _WorkflowsFileLock
    except Exception:
        FileLock = None

if FileLock is None:
    import threading

    class FileLock:
        _tls = threading.local()

        def __init__(self, lock_path: str, timeout: float = 15.0, retry_interval: float = 0.05):
            self.lock_path = os.path.abspath(lock_path)
            self.timeout = timeout
            self.retry_interval = retry_interval
            self.fd = None

        def acquire(self):
            depth = getattr(self._tls, f"depth_{self.lock_path}", 0)
            if depth > 0:
                setattr(self._tls, f"depth_{self.lock_path}", depth + 1)
                self.fd = getattr(self._tls, f"fd_{self.lock_path}", None)
                return self

            os.makedirs(os.path.dirname(self.lock_path) or ".", exist_ok=True)
            start_time = time.time()
            while True:
                try:
                    self.fd = open(self.lock_path, "a+b")
                    self.fd.seek(0, os.SEEK_END)
                    if self.fd.tell() == 0:
                        self.fd.write(b"L")
                        self.fd.flush()

                    self.fd.seek(0)
                    if sys.platform == "win32":
                        import msvcrt
                        msvcrt.locking(self.fd.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

                    setattr(self._tls, f"depth_{self.lock_path}", 1)
                    setattr(self._tls, f"fd_{self.lock_path}", self.fd)
                    return self
                except (OSError, IOError):
                    if self.fd:
                        try:
                            self.fd.close()
                        except Exception:
                            pass
                        self.fd = None
                    if time.time() - start_time >= self.timeout:
                        raise TimeoutError(
                            f"Timed out after {self.timeout}s waiting for lock: {self.lock_path}"
                        )
                    time.sleep(self.retry_interval)

        def release(self):
            depth = getattr(self._tls, f"depth_{self.lock_path}", 0)
            if depth > 1:
                setattr(self._tls, f"depth_{self.lock_path}", depth - 1)
                return

            fd = getattr(self._tls, f"fd_{self.lock_path}", self.fd)
            if fd:
                try:
                    fd.seek(0)
                    if sys.platform == "win32":
                        import msvcrt
                        msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
                except Exception:
                    pass
                finally:
                    try:
                        fd.close()
                    except Exception:
                        pass

            setattr(self._tls, f"depth_{self.lock_path}", 0)
            setattr(self._tls, f"fd_{self.lock_path}", None)
            self.fd = None

        def __enter__(self):
            return self.acquire()

        def __exit__(self, exc_type, exc_val, exc_tb):
            self.release()

# Import WorkerBackend
WorkerBackend = None
WorkerRequest = None
try:
    from worker_backend import WorkerBackend as _WB, WorkerRequest as _WR
    WorkerBackend = _WB
    WorkerRequest = _WR
except Exception:
    WorkerBackend = None
    WorkerRequest = None


EXPLICITLY_CANCELLED_TASKS: Dict[str, str] = {}

TOPIC_KEYWORDS_MAP = {
    "gui": "Desktop GUI",
    "desktop": "Desktop GUI",
    "webprovider": "Desktop GUI",
    "chatgpt": "Desktop GUI",
    "design": "UX/design",
    "conversion": "UX/design",
    "motion": "Motion",
    "workflow": "Workflow",
    "gate": "Workflow",
    "concurrent": "Workflow",
    "todo": "Workflow",
    "scheduler": "Workflow",
    "agent": "Agent system change",
    "replenish": "Agent system change",
    "system": "Agent system change",
}

RUNNABLE_TOPIC_NAMES = [
    "Desktop GUI",
    "UX/design",
    "Motion",
    "Workflow",
    "Agent system change",
]


def resolve_topic(item_id: str, prompt: str, explicit_topic: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> str:
    if explicit_topic and explicit_topic in RUNNABLE_TOPIC_NAMES:
        return explicit_topic
    search_space = f"{item_id} {prompt} {json.dumps(metadata or {})}".lower()
    for kw, topic in TOPIC_KEYWORDS_MAP.items():
        if re.search(rf"\b{kw}\b", search_space, re.IGNORECASE):
            return topic
    for kw, topic in TOPIC_KEYWORDS_MAP.items():
        if kw in search_space:
            return topic
    return "Workflow"


def is_valid_authorization(auth: Any) -> bool:
    """Accept only a complete, explicitly authorized ledger record."""
    if not isinstance(auth, dict):
        return False
    if auth.get("status") != "authorized":
        return False
    timestamp = auth.get("timestamp")
    scope = auth.get("scope")
    authorized_by = auth.get("authorized_by")
    if not isinstance(timestamp, str) or not timestamp.strip():
        return False
    try:
        datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (
        isinstance(scope, str)
        and bool(scope.strip())
        and isinstance(authorized_by, str)
        and bool(authorized_by.strip())
    )


def is_forbidden_target(req: Dict[str, Any]) -> bool:
    """
    Structured repository and environment authorization check.
    Never inspects bare prompt words so legitimate references to agent 'Main'
    are never falsely blocked.
    """
    target = str(req.get("target") or req.get("target_branch") or req.get("branch") or req.get("base") or "").strip().lower()
    env = str(req.get("environment") or "").strip().lower()
    prompt = str(req.get("prompt") or "").strip().lower()

    # Extract target / branch if specified as key in prompt
    if not target:
        m_target = re.search(r"\btarget:\s*(\S+)", prompt)
        if m_target:
            target = m_target.group(1).lower()
        else:
            m_branch = re.search(r"\bbranch\s+(\S+)", prompt)
            if m_branch:
                target = m_branch.group(1).lower()

    forbidden_targets: Set[str] = set()
    forbidden_envs: Set[str] = set()

    extra_forbidden = os.environ.get("VEYYON_FORBIDDEN_TARGETS")
    if extra_forbidden:
        for t in extra_forbidden.split(","):
            t = t.strip().lower()
            if t:
                forbidden_targets.add(t)
                forbidden_envs.add(t)

    extra_forbidden_envs = os.environ.get("VEYYON_FORBIDDEN_ENVIRONMENTS")
    if extra_forbidden_envs:
        for e in extra_forbidden_envs.split(","):
            e = e.strip().lower()
            if e:
                forbidden_envs.add(e)

    req_forbidden = req.get("forbidden_targets") or req.get("forbidden_branches")
    if isinstance(req_forbidden, (list, set, tuple)):
        for t in req_forbidden:
            t = str(t).strip().lower()
            if t:
                forbidden_targets.add(t)

    req_forbidden_envs = req.get("forbidden_environments")
    if isinstance(req_forbidden_envs, (list, set, tuple)):
        for e in req_forbidden_envs:
            e = str(e).strip().lower()
            if e:
                forbidden_envs.add(e)

    if env and (env in forbidden_envs or env in forbidden_targets):
        return True

    if target and target in forbidden_targets:
        return True

    return False


def get_iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def native_claim_error(req: Dict[str, Any]) -> Optional[str]:
    """Validate the persisted execution identity without changing accountable ownership."""
    if any(req.get(key) not in (None, "") for key in ("native_run_id", "native_task_handle")):
        return "Legacy native identity requires an explicit owner decision"
    if "native_claim" not in req:
        return None
    claim = req["native_claim"]
    if not isinstance(claim, dict) or set(claim) != {"version", "state", "worker_id", "run_id", "task_handle"}:
        return "Malformed native claim"
    if type(claim["version"]) is not int or claim["version"] != 1:
        return "Unsupported native claim version"
    if claim["state"] == "retryable":
        if any(claim[key] is not None for key in ("worker_id", "run_id", "task_handle")):
            return "Retryable native claim still has an execution identity"
        return None
    if claim["state"] != "active":
        return "Unsupported native claim state"
    if any(not isinstance(claim[key], str) or not claim[key].strip() for key in ("worker_id", "run_id")):
        return "Active native claim has no worker or run identity"
    handle = claim["task_handle"]
    if handle is not None and (not isinstance(handle, str) or not handle.startswith("agent://") or not handle[8:].strip()):
        return "Invalid native task handle"
    if handle is not None and handle.removeprefix("agent://") != claim["worker_id"]:
        return "Conflicting native worker and task identities"
    return None


def retryable_native_claim() -> Dict[str, Any]:
    return {"version": 1, "state": "retryable", "worker_id": None, "run_id": None, "task_handle": None}


def active_native_claim(req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if native_claim_error(req):
        return None
    claim = req.get("native_claim")
    return claim if claim and claim["state"] == "active" else None


def write_ledger_atomic(ledger_path: str, data: Mapping[str, Any]) -> None:
    temp_path = f"{ledger_path}.tmp.{os.getpid()}.{int(time.time()*1000)}"
    try:
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(temp_path, ledger_path)
    except Exception:
        if os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        raise


def normalize_optional_task_handle(raw: Any) -> Tuple[Optional[str], Optional[str]]:
    if raw is None or raw == "":
        return None, None
    if not isinstance(raw, str) or not raw.startswith("agent://") or not raw[8:].strip():
        return None, "Invalid native task handle"
    return raw, None


def is_valid_task_handle(handle: Any) -> bool:
    return isinstance(handle, str) and handle.startswith("agent://") and bool(handle[8:].strip())


def has_retired_retry_authorization(req: Mapping[str, Any], run_id: str) -> bool:
    for entry in req.get("history") or []:
        if isinstance(entry, dict) and entry.get("native_retired_run_id") == run_id:
            return True
    return False


def has_legacy_rollback_retry_authorization(req: Mapping[str, Any], run_id: str) -> bool:
    for entry in req.get("history") or []:
        if isinstance(entry, dict) and entry.get("native_rollback_run_id") == run_id:
            return True
    return False


def is_backend_wide_prepare_error(exc: Exception) -> bool:
    msg = str(exc)
    return (
        "Native attempt index" in msg
        or "recurrence history that governs unchanged retry is unreadable" in msg
    )


def has_projected_native_outcome(req: Mapping[str, Any], run_id: str) -> bool:
    for entry in req.get("history") or []:
        if (
            isinstance(entry, dict)
            and entry.get("actor") == "WorkerBackend"
            and entry.get("native_run_id") == run_id
        ):
            return True
    return False


def project_native_outcome(
    req: Dict[str, Any],
    run_id: str,
    outcome_dict: Mapping[str, Any],
    now_iso: Optional[str] = None,
) -> bool:
    """
    Apply one canonical WorkerOutcome projection to a ledger request at most once.
    Returns True if applied, False if this run_id was already projected.
    """
    if has_projected_native_outcome(req, run_id):
        req["native_claim"] = retryable_native_claim()
        return False

    ts = now_iso or get_iso_now()
    from_state = req.get("state") or "implementation"
    history = req.setdefault("history", [])

    if outcome_dict.get("ok"):
        next_state = from_state
        if str(from_state).lower() in ("pending", "implementation", "build"):
            next_state = "QA"
        elif str(from_state).lower() == "qa":
            next_state = "review"
        elif str(from_state).lower() == "review":
            next_state = "awaiting authorization"

        req["state"] = next_state
        if outcome_dict.get("head_sha"):
            req["head"] = outcome_dict["head_sha"]
        req["blocker"] = None
        req["updated_at"] = ts
        req["native_claim"] = retryable_native_claim()

        evidence_list = req.setdefault("evidence", [])
        if outcome_dict.get("evidence"):
            evidence_list.append(outcome_dict["evidence"])

        history.append({
            "actor": "WorkerBackend",
            "timestamp": ts,
            "from_state": from_state,
            "to_state": next_state,
            "reason": f"Stage {outcome_dict.get('stage')} validated successfully",
            "native_run_id": run_id,
        })
    else:
        reason = outcome_dict.get("blocked_reason") or "Worker verification failed"
        req["blocker"] = reason
        req["updated_at"] = ts
        req["native_claim"] = retryable_native_claim()
        history.append({
            "actor": "WorkerBackend",
            "timestamp": ts,
            "from_state": from_state,
            "to_state": from_state,
            "reason": f"Stage {outcome_dict.get('stage')} refused/blocked: {reason}",
            "native_run_id": run_id,
        })
    return True


def cmd_claim(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    worker_id = args.worker_id or f"native-replenish-{int(time.time()*1000)}"
    covered_topics = set(args.covered_topics.split(",") if args.covered_topics else [])
    timeout = float(args.timeout)

    with FileLock(lock_path, timeout=timeout):
        if not os.path.exists(ledger_path):
            res = {"claimed": False, "reason": f"Ledger file does not exist at {ledger_path}", "blockedTopics": [], "blocked_topics": []}
            print(json.dumps(res))
            return 0

        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        requests = data.get("requests", {})
        drivable_states = {"pending", "implementation", "qa", "review"}
        candidates = []
        blocked_topics = []

        for req_id, req in requests.items():
            prompt = req.get("prompt", "")
            canonical_prompt = " ".join(prompt.strip().lower().split())

            # 1. Skip explicitly cancelled/dropped tasks
            if canonical_prompt in EXPLICITLY_CANCELLED_TASKS:
                continue
            if req.get("state") in ("cancelled", "dropped"):
                continue

            # 2. Production target guard across structured repo/project/target fields
            if is_forbidden_target(req):
                continue

            # 3. Fail-closed authorization check
            if not is_valid_authorization(req.get("authorization")):
                continue

            # 4. Check for ungranted merge authorization
            if req.get("state") == "awaiting authorization":
                continue

            state = str(req.get("state") or "pending").lower()

            # Accountable owners are not execution identities. Never-native human
            # work stays excluded; only an explicit retryable claim can resume it.
            if native_claim_error(req):
                continue
            claim = req.get("native_claim")
            if claim and claim["state"] == "active":
                continue
            if not claim and req.get("owner") and state != "pending":
                continue

            # 5. Check decision blockers
            dec_blockers = req.get("decision_blockers")
            if isinstance(dec_blockers, list) and len(dec_blockers) > 0:
                topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
                blocked_topics.append({
                    "topic": topic,
                    "ticketId": req_id,
                    "reason": f"Awaiting human decision on: {', '.join(dec_blockers)}",
                })
                continue

            # 6. Check general blockers
            blocker = req.get("blocker") or req.get("blocker_reason")
            if blocker or state == "blocked":
                topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
                blocked_topics.append({
                    "topic": topic,
                    "ticketId": req_id,
                    "reason": blocker or "Task marked blocked",
                })
                continue

            # 7. Check drivable state
            if state not in drivable_states:
                continue

            # 8. Check dependencies
            deps = req.get("dependencies")
            if isinstance(deps, list) and len(deps) > 0:
                terminal_states = {"done", "live verification", "integration", "awaiting authorization"}
                unmet = [d for d in deps if d not in requests or str(requests[d].get("state", "")).lower() not in terminal_states]
                if unmet:
                    topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
                    blocked_topics.append({
                        "topic": topic,
                        "ticketId": req_id,
                        "reason": f"Dependencies unfulfilled: {', '.join(unmet)}",
                        "dependencies": unmet,
                    })
                    continue

            topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
            priority = 1 if topic not in covered_topics else 2
            candidates.append((priority, req_id, topic, req))

        if not candidates:
            res = {
                "claimed": False,
                "reason": "No eligible authorized tickets found",
                "blockedTopics": blocked_topics,
                "blocked_topics": blocked_topics,
            }
            print(json.dumps(res))
            return 0

        if not worker_id.strip():
            print(json.dumps({"claimed": False, "reason": "Invalid native worker or run identity"}))
            return 0

        # Sort candidate by priority (uncovered first), then id
        candidates.sort(key=lambda c: (c[0], c[1]))

        backend = None
        if WorkerBackend is not None:
            try:
                backend = WorkerBackend(state_dir=os.path.dirname(ledger_path))
            except Exception as exc:
                print(json.dumps({
                    "claimed": False,
                    "reason": f"WorkerBackend preparation failed: {exc}",
                    "blockedTopics": blocked_topics,
                    "blocked_topics": blocked_topics,
                }))
                return 0

        chosen_id = None
        chosen_topic = None
        chosen_req = None
        run_id = None
        result_schema = None
        prepared_prompt = ""
        from_state = "pending"
        stage = "build"
        repo_root = os.getcwd()
        head_sha = None
        last_candidate_error = None

        for _, cand_id, cand_topic, cand_req in candidates:
            cand_from_state = cand_req.get("state") or "pending"
            cand_prompt = cand_req.get("prompt", "")
            cand_stage = str(cand_req.get("stage") or (
                "qa" if str(cand_from_state).lower() == "qa"
                else "review" if str(cand_from_state).lower() == "review"
                else "build"
            ))
            cand_repo_root = str(cand_req.get("repo_root") or os.getcwd())
            cand_head_sha = cand_req.get("head")
            cand_result_schema = None
            cand_run_id = None

            if backend is not None:
                try:
                    wb_req = WorkerRequest(
                        request_id=cand_id,
                        stage=cand_stage,
                        repo_root=cand_repo_root,
                        head_sha=cand_head_sha,
                        model=str(cand_req.get("model") or os.environ.get("VEYYON_DEFAULT_MODEL") or ""),
                        agent_role=str(cand_req.get("agent_role") or "task"),
                        prompt=cand_prompt,
                        criteria=cand_req.get("criteria", []),
                        task_type=str(cand_req.get("task_type") or "feature"),
                    )
                    native_ticket = backend.prepare_native(wb_req)
                    if native_ticket.state == "retired":
                        if not has_retired_retry_authorization(cand_req, native_ticket.run_id):
                            refusal = (
                                f"Retired native run {native_ticket.run_id} lacks matching "
                                "rollback or recovery authorization"
                            )
                            blocked_topics.append({
                                "topic": cand_topic,
                                "ticketId": cand_id,
                                "reason": refusal,
                            })
                            last_candidate_error = refusal
                            continue
                        native_ticket = backend.retry_native(native_ticket.run_id)
                    elif native_ticket.state == "blocked" and native_ticket.run_id:
                        outcome = backend.get_native_outcome(native_ticket.run_id)
                        if has_legacy_rollback_retry_authorization(cand_req, native_ticket.run_id) or (
                            outcome is not None and outcome.ok is False
                        ):
                            native_ticket = backend.retry_native(native_ticket.run_id)
                except Exception as exc:
                    if is_backend_wide_prepare_error(exc):
                        print(json.dumps({
                            "claimed": False,
                            "reason": f"WorkerBackend preparation failed: {exc}",
                            "blockedTopics": blocked_topics,
                            "blocked_topics": blocked_topics,
                        }))
                        return 0
                    refusal = str(exc)
                    blocked_topics.append({
                        "topic": cand_topic,
                        "ticketId": cand_id,
                        "reason": refusal,
                    })
                    last_candidate_error = refusal
                    continue

                if (
                    native_ticket.state != "prepared"
                    or native_ticket.task_handle is not None
                    or native_ticket.blocked_reason
                    or not isinstance(native_ticket.run_id, str)
                    or not native_ticket.run_id.strip()
                ):
                    refusal = (
                        native_ticket.blocked_reason
                        or f"WorkerBackend ticket {native_ticket.run_id or cand_id} is '{native_ticket.state}', not prepared"
                    )
                    blocked_topics.append({
                        "topic": cand_topic,
                        "ticketId": cand_id,
                        "reason": refusal,
                    })
                    last_candidate_error = refusal
                    continue

                cand_run_id = native_ticket.run_id
                cand_result_schema = native_ticket.result_schema
                if native_ticket.prompt:
                    cand_prompt = native_ticket.prompt
            else:
                cand_run_id = f"native_{cand_id}_{uuid.uuid4().hex}"

            if not isinstance(cand_run_id, str) or not cand_run_id.strip():
                refusal = "Invalid native worker or run identity"
                blocked_topics.append({
                    "topic": cand_topic,
                    "ticketId": cand_id,
                    "reason": refusal,
                })
                last_candidate_error = refusal
                continue

            chosen_id = cand_id
            chosen_topic = cand_topic
            chosen_req = cand_req
            run_id = cand_run_id
            result_schema = cand_result_schema
            prepared_prompt = cand_prompt
            from_state = cand_from_state
            stage = cand_stage
            repo_root = cand_repo_root
            head_sha = cand_head_sha
            break

        if chosen_req is None or chosen_id is None or chosen_topic is None or run_id is None:
            print(json.dumps({
                "claimed": False,
                "reason": last_candidate_error or "No eligible authorized tickets found",
                "blockedTopics": blocked_topics,
                "blocked_topics": blocked_topics,
            }))
            return 0

        now_iso = get_iso_now()
        to_state = "implementation" if str(from_state).lower() == "pending" else chosen_req.get("state")
        chosen_req["state"] = to_state
        chosen_req["claimed_at"] = now_iso
        chosen_req["updated_at"] = now_iso

        history = chosen_req.setdefault("history", [])
        history.append({
            "actor": "TopicReplenishmentEngine",
            "timestamp": now_iso,
            "from_state": from_state,
            "to_state": to_state,
            "reason": "Claimed for native replenishment",
        })
        data["updated_at"] = now_iso
        chosen_req["native_claim"] = {
            "version": 1, "state": "active", "worker_id": worker_id,
            "run_id": run_id, "task_handle": None,
        }

        # Write file atomically inside FileLock
        write_ledger_atomic(ledger_path, data)

        ticket = {
            "id": chosen_id,
            "topic": chosen_topic,
            "prompt": prepared_prompt,
            "task": prepared_prompt,
            "state": to_state,
            "previousState": from_state,
            "owner": chosen_req.get("owner", ""),
            "role": str(chosen_req.get("agent_role") or "task"),
            "criteria": chosen_req.get("criteria", []),
            "dependencies": chosen_req.get("dependencies", []),
            "head": head_sha,
            "authorization": json.dumps(chosen_req.get("authorization")) if isinstance(chosen_req.get("authorization"), dict) else str(chosen_req.get("authorization")),
            "claimedAt": now_iso,
            "runId": run_id,
            "resultSchema": result_schema,
            "stage": stage,
            "repoRoot": repo_root,
            "ledgerPath": ledger_path,
        }

        res = {
            "claimed": True,
            "ticket": ticket,
            "blockedTopics": blocked_topics,
            "blocked_topics": blocked_topics,
        }
        print(json.dumps(res))
        return 0


def cmd_record_dispatch(args: argparse.Namespace) -> int:
    run_id = args.run_id
    task_handle = args.task_handle
    if not args.ledger or not args.ticket_id:
        print(json.dumps({"recorded": False, "error": "A ledger claim is required for native dispatch"}))
        return 1
    ledger_path = os.path.abspath(args.ledger)
    with FileLock(ledger_path + ".lock", timeout=float(args.timeout)):
        if not os.path.exists(ledger_path):
            print(json.dumps({"recorded": False, "error": "Ledger not found"}))
            return 1
        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        req = data.get("requests", {}).get(args.ticket_id)
        claim = active_native_claim(req) if req else None
        if (not claim or claim["run_id"] != run_id
                or not is_valid_task_handle(task_handle)
                or claim["task_handle"] not in (None, task_handle)):
            print(json.dumps({"recorded": False, "error": "Ledger claim no longer owns this native dispatch"}))
            return 1
        ticket = None
        if WorkerBackend is not None:
            try:
                backend = WorkerBackend(state_dir=os.path.abspath(args.state_dir))
                ticket = backend.record_native_dispatch(run_id, task_handle)
                if ticket.state != "background_dispatched" or ticket.task_handle != task_handle:
                    raise ValueError(
                        f"WorkerBackend returned unexpected dispatch state {ticket.state!r} "
                        f"with handle {ticket.task_handle!r}"
                    )
            except Exception as exc:
                print(json.dumps({"recorded": False, "error": str(exc)}))
                return 1
        claim["task_handle"] = task_handle
        claim["worker_id"] = task_handle.removeprefix("agent://")
        req["updated_at"] = get_iso_now()
        data["updated_at"] = req["updated_at"]
        write_ledger_atomic(ledger_path, data)
    print(json.dumps({
        "recorded": True, "run_id": run_id, "task_handle": task_handle,
        "state": ticket.state if ticket is not None else "dispatched",
    }))
    return 0


def blocked_native_result(ticket_id: str, stage: str, reason: str) -> Dict[str, Any]:
    return {
        "request_id": ticket_id,
        "stage": stage,
        "verdict": "blocked",
        "summary": reason,
        "checks": [],
        "artifacts": [],
    }


def cmd_rollback(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    ticket_id = args.ticket_id
    reason = args.reason or "Dispatch failed"
    timeout = float(args.timeout)

    with FileLock(lock_path, timeout=timeout):
        if not os.path.exists(ledger_path):
            print(json.dumps({"rolled_back": False, "error": "Ledger not found"}))
            return 0

        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        req = data.get("requests", {}).get(ticket_id)
        if not req:
            print(json.dumps({"rolled_back": False, "error": f"Ticket {ticket_id} not found"}))
            return 0
        claim_err = native_claim_error(req)
        if claim_err:
            print(json.dumps({"rolled_back": False, "error": claim_err}))
            return 0
        claim = active_native_claim(req)
        if not claim or not args.run_id or claim["run_id"] != args.run_id:
            print(json.dumps({"rolled_back": False, "error": "Ledger claim no longer owns this native run"}))
            return 0
        requested_handle, handle_err = normalize_optional_task_handle(args.task_handle)
        if handle_err:
            print(json.dumps({"rolled_back": False, "error": handle_err}))
            return 0
        if requested_handle != claim["task_handle"]:
            print(json.dumps({"rolled_back": False, "error": "Ledger claim no longer owns this native task handle"}))
            return 0

        now_iso = get_iso_now()
        retired_run_id = None
        if WorkerBackend is not None:
            try:
                backend = WorkerBackend(state_dir=os.path.dirname(ledger_path))
                backend_ticket = backend.get_native_dispatch(claim["run_id"])
                if backend_ticket.task_handle is not None and not is_valid_task_handle(backend_ticket.task_handle):
                    raise ValueError(f"WorkerBackend has invalid task handle {backend_ticket.task_handle!r}")
                if claim["task_handle"] is not None and backend_ticket.task_handle != claim["task_handle"]:
                    raise ValueError("WorkerBackend no longer owns this native task handle")

                if backend_ticket.state in ("finalized", "blocked"):
                    outcome = backend.get_native_outcome(claim["run_id"])
                    if outcome is None:
                        raise ValueError(
                            f"WorkerBackend run {claim['run_id']} is {backend_ticket.state!r} with no readable outcome"
                        )
                    project_native_outcome(req, claim["run_id"], outcome.to_dict(), now_iso)
                    data["updated_at"] = now_iso
                    write_ledger_atomic(ledger_path, data)
                    print(json.dumps({
                        "rolled_back": False,
                        "reconciled": True,
                        "ok": outcome.ok,
                        "state": req["state"],
                        "error": (
                            f"WorkerBackend run {claim['run_id']} already reached terminal state "
                            f"{backend_ticket.state!r}; applied canonical outcome instead of rolling back"
                        ),
                    }))
                    return 0

                if backend_ticket.state not in ("prepared", "background_dispatched", "retired"):
                    raise ValueError(
                        f"WorkerBackend run {claim['run_id']} has unsupported state {backend_ticket.state!r} for rollback"
                    )

                observed_handle = backend_ticket.task_handle
                if backend_ticket.state == "prepared" and observed_handle is not None:
                    raise ValueError(f"Prepared WorkerBackend run {claim['run_id']} unexpectedly has handle {observed_handle!r}")
                if backend_ticket.state == "background_dispatched" and observed_handle is None:
                    raise ValueError(f"Dispatched WorkerBackend run {claim['run_id']} is missing its bound handle")

                retired_ticket = backend.retire_native(claim["run_id"], observed_handle, reason)
                if retired_ticket.state != "retired" or retired_ticket.task_handle != observed_handle:
                    raise ValueError(
                        f"WorkerBackend did not retire run {claim['run_id']} under handle {observed_handle!r}"
                    )
                retired_run_id = retired_ticket.run_id
            except Exception as exc:
                print(json.dumps({"rolled_back": False, "error": f"WorkerBackend rollback failed: {exc}"}))
                return 0

        from_state = req.get("state") or "implementation"
        previous_state = args.previous_state
        valid_states = {"pending", "implementation", "qa", "review"}
        if not isinstance(previous_state, str) or previous_state.lower() not in valid_states:
            inferred = None
            for entry in reversed(req.get("history") or []):
                if (
                    isinstance(entry, dict)
                    and entry.get("actor") == "TopicReplenishmentEngine"
                    and entry.get("reason") == "Claimed for native replenishment"
                    and isinstance(entry.get("from_state"), str)
                    and entry["from_state"].lower() in valid_states
                ):
                    inferred = entry["from_state"]
                    break
            to_state = inferred or "pending"
        else:
            to_state = previous_state
        req["state"] = to_state
        req["native_claim"] = retryable_native_claim()
        req["blocker"] = None
        req["updated_at"] = now_iso

        history = req.setdefault("history", [])
        history.append({
            "actor": "TopicReplenishmentEngine",
            "timestamp": now_iso,
            "from_state": from_state,
            "to_state": to_state,
            "reason": f"Rollback: {reason}",
            **({"native_retired_run_id": retired_run_id} if retired_run_id else {}),
        })
        data["updated_at"] = now_iso
        write_ledger_atomic(ledger_path, data)

        out: Dict[str, Any] = {"rolled_back": True, "ticket_id": ticket_id}
        if retired_run_id:
            out["retired_run_id"] = retired_run_id
        print(json.dumps(out))
        return 0


def cmd_recover(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    running_worker_ids = set(filter(None, args.running_worker_ids.split(",")))
    recovered: List[str] = []
    retired: List[str] = []
    reconciled_outcomes: List[Dict[str, Any]] = []
    errors: List[str] = []

    with FileLock(lock_path, timeout=float(args.timeout)):
        if not os.path.exists(ledger_path):
            print(json.dumps({"recovered": recovered}))
            return 0
        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        now_iso = get_iso_now()
        ledger_modified = False
        backend = None
        backend_init_error = None

        for ticket_id, req in data.get("requests", {}).items():
            state = str(req.get("state") or "pending").lower()
            claim = active_native_claim(req)
            if state not in {"implementation", "qa", "review"} or not claim:
                continue

            if WorkerBackend is None:
                if claim["worker_id"] in running_worker_ids:
                    continue
                owner = claim["worker_id"]
                req["native_claim"] = retryable_native_claim()
                req["updated_at"] = now_iso
                req.setdefault("history", []).append({
                    "actor": "TopicReplenishmentEngine",
                    "timestamp": now_iso,
                    "from_state": req.get("state") or state,
                    "to_state": req.get("state") or state,
                    "reason": f"Recovered orphaned claim from absent worker {owner}",
                })
                recovered.append(ticket_id)
                ledger_modified = True
                continue

            if backend is None and backend_init_error is None:
                try:
                    backend = WorkerBackend(state_dir=os.path.dirname(ledger_path))
                except Exception as exc:
                    backend_init_error = str(exc)
            if backend is None:
                errors.append(f"{ticket_id}: WorkerBackend unavailable during recovery: {backend_init_error}")
                continue

            run_id = claim["run_id"]
            try:
                backend_ticket = backend.get_native_dispatch(run_id)
            except Exception as exc:
                errors.append(f"{ticket_id}: cannot read WorkerBackend dispatch {run_id}: {exc}")
                continue

            bound_handle = backend_ticket.task_handle
            if bound_handle is not None and not is_valid_task_handle(bound_handle):
                errors.append(f"{ticket_id}: WorkerBackend dispatch {run_id} has invalid handle {bound_handle!r}")
                continue
            if claim["task_handle"] is not None and bound_handle != claim["task_handle"]:
                errors.append(
                    f"{ticket_id}: ledger task_handle {claim['task_handle']!r} conflicts with "
                    f"WorkerBackend handle {bound_handle!r} for run {run_id}"
                )
                continue

            bound_worker_id = bound_handle.removeprefix("agent://") if bound_handle is not None else None
            authoritative_live = (
                bound_worker_id in running_worker_ids
                if bound_worker_id is not None
                else claim["worker_id"] in running_worker_ids
            )

            if backend_ticket.state in ("finalized", "blocked"):
                if authoritative_live:
                    continue
                try:
                    outcome = backend.get_native_outcome(run_id)
                except Exception as exc:
                    errors.append(f"{ticket_id}: cannot read WorkerBackend outcome for {run_id}: {exc}")
                    continue
                if outcome is None:
                    errors.append(
                        f"{ticket_id}: WorkerBackend run {run_id} is {backend_ticket.state!r} with no readable outcome"
                    )
                    continue
                outcome_dict = outcome.to_dict()
                project_native_outcome(req, run_id, outcome_dict, now_iso)
                recovered.append(ticket_id)
                reconciled_outcomes.append({
                    "ticket_id": ticket_id,
                    "run_id": run_id,
                    "ok": bool(outcome_dict.get("ok")),
                    "state": req["state"],
                })
                ledger_modified = True
                continue

            if backend_ticket.state in ("prepared", "background_dispatched", "retired"):
                if authoritative_live:
                    if (
                        claim["task_handle"] is None
                        and backend_ticket.state == "background_dispatched"
                        and bound_handle is not None
                        and bound_worker_id is not None
                    ):
                        claim["task_handle"] = bound_handle
                        claim["worker_id"] = bound_worker_id
                        req["updated_at"] = now_iso
                        ledger_modified = True
                    continue

                if backend_ticket.state == "prepared" and bound_handle is not None:
                    errors.append(f"{ticket_id}: prepared WorkerBackend run {run_id} unexpectedly has handle {bound_handle!r}")
                    continue
                if backend_ticket.state == "background_dispatched" and bound_handle is None:
                    errors.append(f"{ticket_id}: dispatched WorkerBackend run {run_id} is missing its bound handle")
                    continue

                owner = bound_worker_id or claim["worker_id"]
                retire_reason = f"Recovered orphaned claim from absent worker {owner}"
                try:
                    retired_ticket = backend.retire_native(run_id, bound_handle, retire_reason)
                except Exception as exc:
                    errors.append(f"{ticket_id}: failed to retire WorkerBackend run {run_id}: {exc}")
                    continue
                if retired_ticket.state != "retired" or retired_ticket.task_handle != bound_handle:
                    errors.append(
                        f"{ticket_id}: WorkerBackend did not retire run {run_id} under handle {bound_handle!r}"
                    )
                    continue

                req["native_claim"] = retryable_native_claim()
                req["updated_at"] = now_iso
                req.setdefault("history", []).append({
                    "actor": "TopicReplenishmentEngine",
                    "timestamp": now_iso,
                    "from_state": req.get("state") or state,
                    "to_state": req.get("state") or state,
                    "reason": retire_reason,
                    "native_retired_run_id": retired_ticket.run_id,
                })
                recovered.append(ticket_id)
                retired.append(ticket_id)
                ledger_modified = True
                continue

            errors.append(f"{ticket_id}: unsupported WorkerBackend state {backend_ticket.state!r} for run {run_id}")

        if ledger_modified:
            data["updated_at"] = now_iso
            write_ledger_atomic(ledger_path, data)

    out: Dict[str, Any] = {"recovered": recovered}
    if retired:
        out["retired"] = retired
    if reconciled_outcomes:
        out["reconciled_outcomes"] = reconciled_outcomes
    if errors:
        out["errors"] = errors
    print(json.dumps(out))
    return 0


def completion_identity_error(req: Dict[str, Any], run_id: str, task_handle: str) -> Optional[str]:
    claim = active_native_claim(req)
    if not claim or claim["task_handle"] is None:
        return "Ticket has no active native dispatch identity"
    if run_id != claim["run_id"] or task_handle != claim["task_handle"]:
        return "Stale native run or task handle"
    return None


def cmd_complete(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    ticket_id = args.ticket_id
    run_id = args.run_id
    task_handle = args.task_handle or f"agent://{args.agent_id or 'unknown'}"
    timeout = float(args.timeout)

    structured_result = {}
    if args.result_json:
        try:
            structured_result = json.loads(args.result_json)
        except Exception as e:
            structured_result = {"error": f"Invalid JSON: {e}"}
    elif args.result_file and os.path.exists(args.result_file):
        try:
            with open(args.result_file, "r", encoding="utf-8") as rf:
                structured_result = json.load(rf)
        except Exception as e:
            structured_result = {"error": f"Invalid file: {e}"}

    if not isinstance(structured_result, dict):
        structured_result = {}

    with FileLock(lock_path, timeout=timeout):
        if not os.path.exists(ledger_path):
            print(json.dumps({"completed": False, "error": "Ledger not found"}))
            return 0
        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        req = data.get("requests", {}).get(ticket_id)
        if not req:
            print(json.dumps({"completed": False, "error": f"Ticket {ticket_id} not found"}))
            return 0
        identity_error = completion_identity_error(req, run_id, task_handle)
        if identity_error:
            print(json.dumps({"completed": False, "ok": False, "error": identity_error}))
            return 0

        completion_error = args.error or (
            f"Worker exited with code {args.exit_code}" if args.exit_code else None
        )
        if WorkerBackend is not None:
            try:
                backend = WorkerBackend(state_dir=os.path.dirname(ledger_path))
                ticket = backend.get_native_dispatch(run_id)
                if ticket.task_handle != task_handle or ticket.state == "retired":
                    raise ValueError(f"Native dispatch {run_id} is retired or no longer owns this handle")
                result_for_backend = (
                    blocked_native_result(ticket_id, ticket.request["stage"], completion_error)
                    if completion_error else structured_result
                )
                outcome_dict = backend.complete_native(run_id, task_handle, result_for_backend).to_dict()
                durable = backend.get_native_outcome(run_id)
                if durable is None or outcome_dict != durable.to_dict():
                    raise ValueError(outcome_dict.get("blocked_reason") or "No matching durable outcome")
                if completion_error:
                    outcome_dict["blocked_reason"] = completion_error
            except Exception as exc:
                # Recovery can project a durable outcome or retire an orphan.
                print(json.dumps({"completed": False, "ok": False, "error": f"WorkerBackend completion failed: {exc}"}))
                return 0
        else:
            verdict = structured_result.get("verdict")
            checks = structured_result.get("checks") or []
            has_verifications = any(
                isinstance(check, dict) and check.get("purpose") == "verification" and check.get("exit_code") == 0
                for check in checks
            )
            blocked_reason = completion_error
            if not blocked_reason:
                if verdict != "pass":
                    blocked_reason = f"Worker returned verdict '{verdict}'"
                elif not checks:
                    blocked_reason = "Worker returned verdict 'pass' with no executed checks"
                elif not has_verifications:
                    blocked_reason = "Worker checks contain no successful verification check"
            outcome_dict = {
                "ok": blocked_reason is None,
                "stage": structured_result.get("stage", "unknown"),
                "head_sha": structured_result.get("head_sha"),
                "evidence": structured_result,
                "blocked_reason": blocked_reason,
            }
        now_iso = get_iso_now()
        project_native_outcome(req, run_id, outcome_dict, now_iso)
        data["updated_at"] = now_iso
        write_ledger_atomic(ledger_path, data)
        print(json.dumps({
            "completed": True,
            "ok": outcome_dict["ok"],
            "stage": outcome_dict.get("stage"),
            "state": req["state"],
            "blocked_reason": outcome_dict.get("blocked_reason"),
            "head_sha": outcome_dict.get("head_sha"),
        }))
        return 0


def cmd_hold_lock(args: argparse.Namespace) -> int:
    """Acquire the lock, signal readiness, hold for duration, then release (for contention testing)."""
    lock_path = os.path.abspath(args.lock_path)
    duration = float(args.duration)
    ready_signal = args.ready_signal or "LOCKED"

    with FileLock(lock_path, timeout=float(args.timeout)):
        print(ready_signal, flush=True)
        time.sleep(duration)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Host adapter bridge for native topic replenishment")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    p_claim = subparsers.add_parser("claim", help="Claim next ready authorized ticket under FileLock")
    p_claim.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_claim.add_argument("--worker-id", default="", help="Worker ID")
    p_claim.add_argument("--covered-topics", default="", help="Comma-separated covered topic names")
    p_claim.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_record = subparsers.add_parser("record-dispatch", help="Record native dispatch binding in WorkerBackend")
    p_record.add_argument("--state-dir", required=True, help="WorkerBackend state directory")
    p_record.add_argument("--run-id", required=True, help="Native run ID")
    p_record.add_argument("--task-handle", required=True, help="Native task handle (agent://...)")
    p_record.add_argument("--ledger", default="", help="Request ledger containing the claimed ticket")
    p_record.add_argument("--ticket-id", default="", help="Claimed request ticket ID")
    p_record.add_argument("--timeout", default="15.0", help="Ledger lock timeout in seconds")

    p_rollback = subparsers.add_parser("rollback", help="Roll back claimed ticket on dispatch failure under FileLock")
    p_rollback.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_rollback.add_argument("--ticket-id", required=True, help="Ticket ID")
    p_rollback.add_argument("--run-id", required=True, help="Native run ID that still owns the claim")
    p_rollback.add_argument("--previous-state", default="auto", help="Ticket state to restore after a rejected dispatch")
    p_rollback.add_argument("--task-handle", default="", help="Native task handle that still owns the claim")
    p_rollback.add_argument("--reason", default="", help="Reason for rolling back the claim")
    p_rollback.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_recover = subparsers.add_parser("recover", help="Release claims owned by workers absent from the running roster")
    p_recover.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_recover.add_argument("--running-worker-ids", default="", help="Comma-separated running worker IDs")
    p_recover.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_complete = subparsers.add_parser("complete", help="Complete ticket on worker finish through canonical validation")
    p_complete.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_complete.add_argument("--ticket-id", required=True, help="Ticket ID")
    p_complete.add_argument("--run-id", default="", help="Native run ID")
    p_complete.add_argument("--task-handle", default="", help="Native task handle (agent://...)")
    p_complete.add_argument("--agent-id", default="", help="Agent ID fallback")
    p_complete.add_argument("--result-json", default="", help="Structured result JSON string")
    p_complete.add_argument("--result-file", default="", help="Path to structured result file")
    p_complete.add_argument("--exit-code", type=int, default=0)
    p_complete.add_argument("--error", default="")
    p_complete.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_hold = subparsers.add_parser("hold-lock", help="Hold lock for testing contention")
    p_hold.add_argument("--lock-path", required=True, help="Lock file path")
    p_hold.add_argument("--duration", default="1.0", help="Duration to hold in seconds")
    p_hold.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")
    p_hold.add_argument("--ready-signal", default="LOCKED", help="Signal printed when acquired")

    args = parser.parse_args()
    if args.subcommand == "claim":
        sys.exit(cmd_claim(args))
    elif args.subcommand == "record-dispatch":
        sys.exit(cmd_record_dispatch(args))
    elif args.subcommand == "rollback":
        sys.exit(cmd_rollback(args))
    elif args.subcommand == "recover":
        sys.exit(cmd_recover(args))
    elif args.subcommand == "complete":
        sys.exit(cmd_complete(args))
    elif args.subcommand == "hold-lock":
        sys.exit(cmd_hold_lock(args))


if __name__ == "__main__":
    main()
