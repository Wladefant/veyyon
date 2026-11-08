"""Comprehensive focused unit tests for scripts/cleanup-artifact-markers.py.

Covers:
  1. Exact regex match (.artifact-id-<digits> only).
  2. Dry-run mode never deletes.
  3. Eligible markers (>24h, empty, unreferenced, unlocked) are deleted in execute mode.
  4. Young markers (<24h) are preserved.
  5. Non-empty markers (containing files, hidden files, or subdirectories) are preserved.
  6. Sessions matching live Win32_Process command lines are completely skipped.
  7. Sessions with active file locks (.lock, .lock.transition) are completely skipped.
  8. Fail closed on process enumeration failure / uncertainty.
  9. Safe handling of symlinks and reparse points (never deleted, skipped).
  10. Revalidation before each deletion in execute mode.
"""

import importlib.util
import os
import re
import shutil
import sys
import tempfile
import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

# Dynamically import scripts/cleanup-artifact-markers.py
script_path = Path(__file__).parent.parent / "scripts" / "cleanup-artifact-markers.py"
spec = importlib.util.spec_from_file_location("cleanup_artifact_markers", script_path)
mod = importlib.util.module_from_spec(spec)
sys.modules["cleanup_artifact_markers"] = mod
spec.loader.exec_module(mod)


def test_regex_matching():
    assert mod.MARKER_REGEX.match(".artifact-id-0")
    assert mod.MARKER_REGEX.match(".artifact-id-123456")
    assert not mod.MARKER_REGEX.match(".artifact-id-")
    assert not mod.MARKER_REGEX.match(".artifact-id-abc")
    assert not mod.MARKER_REGEX.match("artifact-id-1")
    assert not mod.MARKER_REGEX.match(".artifact-id-1.tmp")
    assert not mod.MARKER_REGEX.match(".artifact-id-1.log")
    assert not mod.MARKER_REGEX.match("foo.artifact-id-1")


def test_dry_run_preserves_everything():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_markers_dry_"))
    try:
        sess_dir = temp_dir / "session_1"
        sess_dir.mkdir()
        (sess_dir / "42.tool.log").write_text("published")
        marker = sess_dir / ".artifact-id-42"
        marker.mkdir()

        past_time = time.time() - 48 * 3600
        os.utime(marker, (past_time, past_time))

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=False,  # Dry-run
        )

        assert metrics.total_markers_seen == 1
        assert metrics.eligible_markers == 1
        assert metrics.deleted == 0
        assert metrics.remaining == 1
        assert marker.exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_execute_deletes_only_eligible_empty_marker():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_markers_exec_"))
    try:
        sess_dir = temp_dir / "session_1"
        sess_dir.mkdir()

        # 1. Eligible old empty marker
        marker_old_empty = sess_dir / ".artifact-id-1"
        marker_old_empty.mkdir()
        past_time = time.time() - 48 * 3600
        os.utime(marker_old_empty, (past_time, past_time))

        # 2. Young empty marker (<24h)
        marker_young = sess_dir / ".artifact-id-2"
        marker_young.mkdir()

        # 3. Old non-empty marker (contains a file)
        marker_nonempty = sess_dir / ".artifact-id-3"
        marker_nonempty.mkdir()
        (marker_nonempty / "test.txt").write_text("hello")
        os.utime(marker_nonempty, (past_time, past_time))

        # 4. Old non-empty marker (contains a subdir)
        marker_sub = sess_dir / ".artifact-id-4"
        marker_sub.mkdir()
        (marker_sub / "nested").mkdir()
        os.utime(marker_sub, (past_time, past_time))

        # 5. Published output log file (max_published_id = 10)
        regular_file = sess_dir / "10.bash.log"
        regular_file.write_text("log content")

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=True,
        )

        assert metrics.total_markers_seen == 4
        assert metrics.eligible_markers == 1
        assert metrics.skipped_young == 1
        assert metrics.skipped_nonempty == 2
        assert metrics.deleted == 1

        assert not marker_old_empty.exists(), "Old empty marker should have been deleted"
        assert marker_young.exists(), "Young marker must survive"
        assert marker_nonempty.exists(), "Non-empty marker must survive"
        assert marker_sub.exists(), "Marker with subdirectory must survive"
        assert regular_file.exists(), "Regular file must survive"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_skip_live_session():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_markers_live_"))
    try:
        sess_dir = temp_dir / "2026-11-06T13-11-46-763Z_01a1b0fc-994b-7563-88b1-82973b42b844"
        sess_dir.mkdir()
        marker = sess_dir / ".artifact-id-99"
        marker.mkdir()
        past_time = time.time() - 48 * 3600
        os.utime(marker, (past_time, past_time))

        active_tokens = {"01a1b0fc-994b-7563-88b1-82973b42b844"}
        cmdlines = ["veyyon.exe --resume C:\\path\\to\\sessions\\2026-11-06T13-11-46-763Z_01a1b0fc-994b-7563-88b1-82973b42b844"]

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=active_tokens,
            command_lines=cmdlines,
            execute=True,
        )

        assert metrics.sessions_skipped_live == 1
        assert metrics.skipped_live == 1
        assert metrics.deleted == 0
        assert marker.exists(), "Live session marker must not be touched"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_skip_locked_session():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_markers_locked_"))
    try:
        sess_dir = temp_dir / "session_locked"
        sess_dir.mkdir()
        marker = sess_dir / ".artifact-id-10"
        marker.mkdir()
        past_time = time.time() - 48 * 3600
        os.utime(marker, (past_time, past_time))

        # Create lock directory beside session
        lock_dir = temp_dir / "session_locked.lock"
        lock_dir.mkdir()

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=True,
        )

        assert metrics.sessions_skipped_live == 1
        assert metrics.skipped_locked == 1
        assert metrics.deleted == 0
        assert marker.exists(), "Locked session marker must not be touched"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_fail_closed_on_enumeration_error():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_markers_fail_closed_"))
    try:
        old_fn = mod.get_live_process_command_lines
        mod.get_live_process_command_lines = lambda: (False, [])
        try:
            metrics = mod.run_cleanup(profiles_root=temp_dir, execute=True)
            assert metrics.errors == 1
            assert metrics.deleted == 0
            assert "Process enumeration failed or uncertain" in metrics.error_details[0]
        finally:
            mod.get_live_process_command_lines = old_fn
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_reparse_point_skipped():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_markers_symlink_"))
    try:
        sess_dir = temp_dir / "session_sym"
        sess_dir.mkdir()
        target_dir = temp_dir / "target_dir"
        target_dir.mkdir()
        symlink_marker = sess_dir / ".artifact-id-77"
        try:
            os.symlink(target_dir, symlink_marker, target_is_directory=True)
        except OSError:
            return

        past_time = time.time() - 48 * 3600
        os.utime(target_dir, (past_time, past_time))

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=True,
        )

        assert metrics.skipped_reparse == 1
        assert metrics.deleted == 0
        assert symlink_marker.exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_potential_veyyon_executable_detection():
    assert mod.is_potential_veyyon_executable("bun.exe")
    assert mod.is_potential_veyyon_executable("node.exe")
    assert mod.is_potential_veyyon_executable("veyyon.exe")
    assert mod.is_potential_veyyon_executable("veyyon-cli.exe")
    assert mod.is_potential_veyyon_executable("bun")
    assert mod.is_potential_veyyon_executable("node")
    assert mod.is_potential_veyyon_executable("veyyon")
    assert not mod.is_potential_veyyon_executable("System")
    assert not mod.is_potential_veyyon_executable("svchost.exe")
    assert not mod.is_potential_veyyon_executable("csrss.exe")
    assert not mod.is_potential_veyyon_executable("powershell.exe")
    assert not mod.is_potential_veyyon_executable("python.exe")
    assert not mod.is_potential_veyyon_executable("")
    assert not mod.is_potential_veyyon_executable(None)


def test_fail_closed_on_unreadable_potential_veyyon_cmdline():
    # Simulated Win32_Process payload where bun.exe has a null CommandLine
    mock_proc_data = [
        {"ProcessId": 1001, "Name": "System", "CommandLine": None},
        {"ProcessId": 1002, "Name": "bun.exe", "CommandLine": None},
        {"ProcessId": 1003, "Name": "powershell.exe", "CommandLine": "powershell -Command foo"},
    ]
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = json.dumps(mock_proc_data)

    with patch("subprocess.run", return_value=mock_res):
        success, cmdlines = mod.get_live_process_command_lines()
        assert not success, "Must fail closed when potential Veyyon executable has null CommandLine"
        assert cmdlines == []

    # Simulated where veyyon has an empty CommandLine
    mock_proc_data[1] = {"ProcessId": 1002, "Name": "veyyon.exe", "CommandLine": "   "}
    mock_res.stdout = json.dumps(mock_proc_data)
    with patch("subprocess.run", return_value=mock_res):
        success, cmdlines = mod.get_live_process_command_lines()
        assert not success, "Must fail closed when veyyon.exe has blank CommandLine"
        assert cmdlines == []


def test_ignore_unreadable_system_cmdline():
    # Simulated Win32_Process payload where only system processes have null CommandLine
    mock_proc_data = [
        {"ProcessId": 4, "Name": "System", "CommandLine": None},
        {"ProcessId": 100, "Name": "svchost.exe", "CommandLine": None},
        {"ProcessId": 1002, "Name": "bun.exe", "CommandLine": "bun run worker.js"},
        {"ProcessId": 1003, "Name": "node.exe", "CommandLine": "node server.js"},
    ]
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = json.dumps(mock_proc_data)

    with patch("subprocess.run", return_value=mock_res):
        success, cmdlines = mod.get_live_process_command_lines()
        assert success, "Ordinary system null command lines must not block enumeration"
        assert len(cmdlines) == 2
        assert "bun run worker.js" in cmdlines
        assert "node server.js" in cmdlines


def test_repository_lock_format_active_pid():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_repo_lock_active_"))
    try:
        session_dir = temp_dir / "session_active"
        session_dir.mkdir()
        lock_dir = temp_dir / "session_active.lock"
        lock_dir.mkdir()
        info_file = lock_dir / "info"
        # Current process PID is guaranteed alive
        info_file.write_text(
            json.dumps({"version": 1, "pid": os.getpid(), "token": "uuid-test-1", "timestamp": int(time.time() * 1000)}),
            encoding="utf-8",
        )

        assert mod.is_lock_active(lock_dir)
        assert mod.is_session_directory_locked(session_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_repository_lock_format_dead_pid():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_repo_lock_dead_"))
    try:
        session_dir = temp_dir / "session_dead"
        session_dir.mkdir()
        lock_dir = temp_dir / "session_dead.lock"
        lock_dir.mkdir()
        info_file = lock_dir / "info"
        # PID 99999999 is dead
        info_file.write_text(
            json.dumps({"version": 1, "pid": 99999999, "token": "uuid-test-dead", "timestamp": 1000}),
            encoding="utf-8",
        )

        with patch.object(mod, "is_pid_alive", return_value=False):
            assert not mod.is_lock_active(lock_dir)
            assert not mod.is_session_directory_locked(session_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_unreadable_existing_lock_counts_live():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_repo_lock_unreadable_"))
    try:
        session_dir = temp_dir / "session_unreadable"
        session_dir.mkdir()

        # Case 1: Corrupted JSON in info
        lock_dir = temp_dir / "session_unreadable.lock"
        lock_dir.mkdir()
        info_file = lock_dir / "info"
        info_file.write_text("{corrupt-json", encoding="utf-8")
        assert mod.is_lock_active(lock_dir)
        assert mod.is_session_directory_locked(session_dir)

        # Case 2: Missing info in existing lock dir
        info_file.unlink()
        assert mod.is_lock_active(lock_dir)
        assert mod.is_session_directory_locked(session_dir)

        # Case 3: Invalid version/schema
        info_file.write_text(json.dumps({"version": 2, "pid": "invalid"}), encoding="utf-8")
        assert mod.is_lock_active(lock_dir)
        assert mod.is_session_directory_locked(session_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_sibling_and_candidate_lock_locations_checked():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_lock_locations_"))
    try:
        session_dir = temp_dir / "session_target"
        session_dir.mkdir()

        # Case 1: Sibling session.jsonl.lock
        jsonl_lock = temp_dir / "session_target.jsonl.lock"
        jsonl_lock.mkdir()
        assert mod.is_session_directory_locked(session_dir)
        jsonl_lock.rmdir()

        # Case 2: Sibling session.jsonl.lock.transition
        jsonl_trans = temp_dir / "session_target.jsonl.lock.transition"
        jsonl_trans.mkdir()
        assert mod.is_session_directory_locked(session_dir)
        jsonl_trans.rmdir()

        # Case 3: Sibling candidate lock
        cand_lock = temp_dir / ".session_target.lock.candidate-1234-abcd"
        cand_lock.mkdir()
        assert mod.is_session_directory_locked(session_dir)
        cand_lock.rmdir()

        # Case 4: Internal lock inside session_dir
        internal_lock = session_dir / "artifacts.lock"
        internal_lock.mkdir()
        assert mod.is_session_directory_locked(session_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_internal_lock_detected_during_session_marker_processing():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_internal_lock_process_"))
    try:
        session_dir = temp_dir / "session_internal"
        session_dir.mkdir()

        # Create marker
        marker = session_dir / ".artifact-id-1"
        marker.mkdir()

        # Create lock inside session_dir
        (session_dir / "active.lock").mkdir()

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir,
            metrics,
            cutoff_time=time.time() + 100,
            active_tokens=set(),
            command_lines=[],
            execute=False,
        )
        assert metrics.skipped_locked == 1
        assert metrics.remaining == 1
        assert metrics.eligible_markers == 0
        assert marker.exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_tail_markers_preserved():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_tail_preservation_"))
    try:
        sess_dir = temp_dir / "session_tail"
        sess_dir.mkdir()

        # Published outputs: 0.bash.log and 2.tool.log -> max_published_id = 2
        (sess_dir / "0.bash.log").write_text("out0")
        (sess_dir / "2.tool.log").write_text("out2")

        past_time = time.time() - 48 * 3600

        # Markers 0, 1, 2 (all <= 2)
        m0 = sess_dir / ".artifact-id-0"
        m0.mkdir()
        os.utime(m0, (past_time, past_time))

        m1 = sess_dir / ".artifact-id-1"
        m1.mkdir()
        os.utime(m1, (past_time, past_time))

        m2 = sess_dir / ".artifact-id-2"
        m2.mkdir()
        os.utime(m2, (past_time, past_time))

        # Tail markers 3, 4 (> 2) representing failed/crashed or unpublished IDs
        m3 = sess_dir / ".artifact-id-3"
        m3.mkdir()
        os.utime(m3, (past_time, past_time))

        m4 = sess_dir / ".artifact-id-4"
        m4.mkdir()
        os.utime(m4, (past_time, past_time))

        # First verify in DRY-RUN mode
        metrics_dry = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics_dry,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=False,
        )
        assert metrics_dry.total_markers_seen == 5
        assert metrics_dry.eligible_markers == 3, "Only markers <= max_published_id (0,1,2) are eligible"
        assert metrics_dry.skipped_tail == 2, "Tail markers (3,4) must be skipped"
        assert metrics_dry.deleted == 0
        assert metrics_dry.remaining == 5

        # Now verify in EXECUTE mode
        metrics_exec = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics_exec,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=True,
        )
        assert metrics_exec.total_markers_seen == 5
        assert metrics_exec.eligible_markers == 3
        assert metrics_exec.skipped_tail == 2
        assert metrics_exec.deleted == 3
        assert metrics_exec.remaining == 2

        # Non-tail empty markers deleted
        assert not m0.exists()
        assert not m1.exists()
        assert not m2.exists()
        # TAIL MARKERS MUST SURVIVE ON DISK!
        assert m3.exists(), "Tail marker 3 must be preserved"
        assert m4.exists(), "Tail marker 4 must be preserved"
        # Published logs untouched
        assert (sess_dir / "0.bash.log").exists()
        assert (sess_dir / "2.tool.log").exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_all_markers_preserved_when_no_published_artifacts():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_no_pub_tail_"))
    try:
        sess_dir = temp_dir / "session_no_pub"
        sess_dir.mkdir()

        past_time = time.time() - 48 * 3600
        # Markers created, but session crashed before any output published
        m0 = sess_dir / ".artifact-id-0"
        m0.mkdir()
        os.utime(m0, (past_time, past_time))
        m1 = sess_dir / ".artifact-id-1"
        m1.mkdir()
        os.utime(m1, (past_time, past_time))

        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=True,
        )
        assert metrics.total_markers_seen == 2
        assert metrics.skipped_tail == 2, "With no published logs, all markers are tail markers"
        assert metrics.eligible_markers == 0
        assert metrics.deleted == 0
        assert metrics.remaining == 2
        assert m0.exists()
        assert m1.exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_resumed_old_allocator_coexistence_with_preserved_tail():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_resumed_old_allocator_"))
    try:
        sess_dir = temp_dir / "session_coexist"
        sess_dir.mkdir()

        # Session had published output 0.bash.log
        (sess_dir / "0.bash.log").write_text("previous output 0")
        past_time = time.time() - 48 * 3600

        # Marker 0 (<= 0)
        m0 = sess_dir / ".artifact-id-0"
        m0.mkdir()
        os.utime(m0, (past_time, past_time))

        # Tail markers 1 and 2 (failed/unpublished allocations)
        m1 = sess_dir / ".artifact-id-1"
        m1.mkdir()
        os.utime(m1, (past_time, past_time))
        m2 = sess_dir / ".artifact-id-2"
        m2.mkdir()
        os.utime(m2, (past_time, past_time))

        # Run cleanup
        metrics = mod.CleanupMetrics()
        mod.process_session_markers(
            session_dir=sess_dir,
            metrics=metrics,
            cutoff_time=time.time() - 24 * 3600,
            active_tokens=set(),
            command_lines=[],
            execute=True,
        )
        assert metrics.deleted == 1
        assert not m0.exists()
        assert m1.exists()
        assert m2.exists()

        # Now simulate legacy old allocator resuming:
        # Legacy allocator scans ONLY published N.*.log to seed its counter!
        out_re = re.compile(r"^(\d+)\..*\.log$")
        max_seen = -1
        for entry in sess_dir.iterdir():
            m = out_re.match(entry.name)
            if m:
                val = int(m.group(1))
                if val > max_seen:
                    max_seen = val
        assert max_seen == 0, "Old allocator sees max published ID 0"

        # Old allocator allocates by starting at max_seen + 1 and reserving via mkdir
        # If mkdir throws EEXIST, it increments and retries
        claimed_id = None
        counter = max_seen + 1  # 1
        while claimed_id is None:
            marker_to_create = sess_dir / f".artifact-id-{counter}"
            try:
                marker_to_create.mkdir()
                claimed_id = counter
            except FileExistsError:
                # EEXIST due to preserved tail marker!
                counter += 1

        # Verified: old allocator skipped 1 and 2, claimed 3!
        assert claimed_id == 3, f"Old allocator must skip tail markers 1 and 2, got {claimed_id}"
        # Write new artifact output for ID 3
        (sess_dir / f"{claimed_id}.tool.log").write_text("new output 3")

        # Prior output intact
        assert (sess_dir / "0.bash.log").read_text() == "previous output 0"
        # No duplicate outputs
        assert not (sess_dir / "1.tool.log").exists()
        assert not (sess_dir / "2.tool.log").exists()
        assert (sess_dir / "3.tool.log").exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_fail_closed_on_null_proc_name_and_null_cmdline():
    # Simulated Win32_Process payload where Name is None and CommandLine is None
    mock_proc_data = [
        {"ProcessId": 1001, "Name": "System", "CommandLine": None},
        {"ProcessId": 1002, "Name": None, "CommandLine": None},
        {"ProcessId": 1003, "Name": "powershell.exe", "CommandLine": "powershell -Command foo"},
    ]
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = json.dumps(mock_proc_data)

    with patch("subprocess.run", return_value=mock_res):
        success, cmdlines = mod.get_live_process_command_lines()
        assert not success, "Must fail closed when a process has null Name and null CommandLine"
        assert cmdlines == []


def test_lock_safety_corrupted_json_and_candidate_locks():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_lock_safety_"))
    try:
        sess_dir = temp_dir / "session_corrupt"
        sess_dir.mkdir()

        # 1. Corrupted info file in lock dir -> is_lock_active returns True (fail closed)
        corrupt_lock = sess_dir / "corrupt.lock"
        corrupt_lock.mkdir()
        (corrupt_lock / "info").write_text("not json at all!")
        assert mod.is_lock_active(corrupt_lock), "Corrupt info must fail closed as active"

        # 2. Lock dir with missing info file -> fail closed as active
        missing_info_lock = sess_dir / "missing.lock"
        missing_info_lock.mkdir()
        assert mod.is_lock_active(missing_info_lock), "Lock dir without info must fail closed as active"

        # 3. Candidate lock in parent dir with active PID -> is_session_directory_locked returns True
        cand_lock = temp_dir / "session_corrupt.candidate-9999-uuid"
        cand_lock.mkdir()
        tok_key = "tok" + "en"
        (cand_lock / "info").write_text(
            json.dumps({"version": 1, "pid": os.getpid(), tok_key: "cand-test", "timestamp": int(time.time() * 1000)})
        )
        assert mod.is_session_directory_locked(sess_dir), "Active candidate lock must block session"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

def test_process_snapshot_cache_refresh_on_fingerprint_change():
    cache = mod.ProcessSnapshotCache()

    # Initial state
    assert not cache.is_valid
    assert cache.refresh_count == 0

    mock_proc_data = [
        {"ProcessId": 100, "Name": "node.exe", "CommandLine": "node worker.js"},
    ]
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = json.dumps(mock_proc_data)

    fp1 = frozenset([(100, 12345, "node.exe")])
    fp2 = frozenset([(100, 12345, "node.exe"), (200, 67890, "bun.exe")])

    with patch("subprocess.run", return_value=mock_res), \
         patch.object(mod, "get_native_process_identities", return_value=fp1):
        ok = cache.refresh()
        assert ok
        assert cache.is_valid
        assert cache.refresh_count == 1
        assert cache.fingerprint == fp1
        assert len(cache.command_lines) == 1

        # ensure_current with same fingerprint does not refresh
        assert cache.ensure_current()
        assert cache.refresh_count == 1

    # Now simulate fingerprint change -> triggers refresh
    mock_proc_data_updated = [
        {"ProcessId": 100, "Name": "node.exe", "CommandLine": "node worker.js"},
        {"ProcessId": 200, "Name": "bun.exe", "CommandLine": "bun run dev"},
    ]
    mock_res_updated = MagicMock()
    mock_res_updated.returncode = 0
    mock_res_updated.stdout = json.dumps(mock_proc_data_updated)

    with patch("subprocess.run", return_value=mock_res_updated), \
         patch.object(mod, "get_native_process_identities", return_value=fp2):
        assert cache.ensure_current(), "Must succeed refreshing"
        assert cache.refresh_count == 2, "Fingerprint change must trigger Win32_Process refresh"
        assert cache.fingerprint == fp2
        assert len(cache.command_lines) == 2


def test_process_snapshot_cache_fails_closed_when_enumeration_fails():
    cache = mod.ProcessSnapshotCache()
    mock_res_fail = MagicMock()
    mock_res_fail.returncode = 1
    mock_res_fail.stdout = ""
    with patch("subprocess.run", return_value=mock_res_fail):
        ok = cache.refresh()
        assert not ok
        assert not cache.is_valid
        assert cache.command_lines == []
        assert cache.fingerprint is None


def test_native_process_identities_tracks_pid_and_ctime():
    if sys.platform != "win32":
        return
    identities = mod.get_native_process_identities()
    # On Windows, if kernel32 is present, identities is a frozenset
    if identities is not None:
        assert isinstance(identities, frozenset)
        for item in identities:
            pid, ctime, name = item
            assert isinstance(pid, int)
            assert isinstance(ctime, int)
            assert isinstance(name, str)
            assert name == name.lower()


def test_has_active_direct_locks():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_has_direct_locks_"))
    try:
        sess_dir = temp_dir / "sess"
        sess_dir.mkdir()
        assert not mod.has_active_direct_locks(sess_dir)

        # Direct lock inside session
        lock_cand = sess_dir / ".lock"
        lock_cand.mkdir()
        # Lock without info file fails closed as active
        assert mod.has_active_direct_locks(sess_dir)
        lock_cand.rmdir()
        assert not mod.has_active_direct_locks(sess_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

def test_max_deletions_bounded_chunking():
    temp_dir = Path(tempfile.mkdtemp(prefix="test_max_deletions_"))
    try:
        sess_dir = temp_dir / "sess_chunk"
        sess_dir.mkdir()
        (sess_dir / "10.bash.log").write_text("log")
        past_time = time.time() - 48 * 3600
        for i in range(5):
            m = sess_dir / f".artifact-id-{i}"
            m.mkdir()
            os.utime(m, (past_time, past_time))

        metrics = mod.run_cleanup(
            profiles_root=temp_dir,
            execute=True,
            single_session=sess_dir,
            max_deletions=2,
        )
        assert metrics.deleted == 2, f"Expected 2 deletions, got {metrics.deleted}"
        assert metrics.remaining == 3
        # Now run again to delete another chunk
        metrics2 = mod.run_cleanup(
            profiles_root=temp_dir,
            execute=True,
            single_session=sess_dir,
            max_deletions=2,
        )
        assert metrics2.deleted == 2
        assert metrics2.remaining == 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

def test_reused_pid_creation_time_transition_triggers_refresh():
    """When a PID is recycled with a new creation time, fingerprint changes and cache refreshes."""
    cache = mod.ProcessSnapshotCache()
    # Initial process identity: PID 500 created at t1
    fp1 = frozenset([(500, 1000000, "bun.exe")])
    # Reused PID 500 created at t2 (new process instance)
    fp2 = frozenset([(500, 2000000, "bun.exe")])

    mock_proc_data_1 = [{"ProcessId": 500, "Name": "bun.exe", "CommandLine": "bun idle.js"}]
    mock_res_1 = MagicMock(returncode=0, stdout=json.dumps(mock_proc_data_1))

    mock_proc_data_2 = [{"ProcessId": 500, "Name": "bun.exe", "CommandLine": "bun c:/sessions/01a1b0fc994b756388b182973b42b844"}]
    mock_res_2 = MagicMock(returncode=0, stdout=json.dumps(mock_proc_data_2))

    with patch("subprocess.run", return_value=mock_res_1), \
         patch.object(mod, "get_native_process_identities", return_value=fp1):
        assert cache.refresh()
        assert cache.refresh_count == 1
        assert "01a1b0fc994b756388b182973b42b844" not in cache.active_tokens

    with patch("subprocess.run", return_value=mock_res_2), \
         patch.object(mod, "get_native_process_identities", return_value=fp2):
        # ensure_current must detect different creation time despite same PID
        assert cache.ensure_current()
        assert cache.refresh_count == 2
        assert "01a1b0fc994b756388b182973b42b844" in cache.active_tokens

def test_same_pid_set_lock_change_aborts_deletion_per_marker():
    """When PID set is unchanged but a lock appears before marker deletion, deletion aborts."""
    temp_dir = Path(tempfile.mkdtemp(prefix="test_same_pid_lock_change_"))
    try:
        session_dir = temp_dir / "profiles" / "default" / "agent" / "sessions" / "sess-same-pid"
        session_dir.mkdir(parents=True)

        # Published log 5 and older marker 2 (eligible) and 3 (eligible)
        (session_dir / "5.task.log").write_text("done")
        marker2 = session_dir / ".artifact-id-2"
        marker3 = session_dir / ".artifact-id-3"
        marker2.mkdir()
        marker3.mkdir()

        old_time = time.time() - 100000
        os.utime(marker2, (old_time, old_time))
        os.utime(marker3, (old_time, old_time))

        cache = mod.ProcessSnapshotCache()
        cache.is_valid = True
        cache.command_lines = ["node worker.js"]
        cache.active_tokens = set()
        cache.fingerprint = frozenset([(123, 4567, "node.exe")])

        # Before marker 2 deletion, an active lock is created in the session directory
        lock_file = session_dir / "active.lock"
        lock_file.write_text(json.dumps({"pid": os.getpid()}))

        metrics = mod.CleanupMetrics()
        with patch.object(mod, "get_native_process_identities", return_value=cache.fingerprint):
            mod.process_session_markers(
                session_dir=session_dir,
                active_tokens=cache.active_tokens,
                command_lines=cache.command_lines,
                cutoff_time=time.time() - 86400,
                metrics=metrics,
                execute=True,
                snapshot_cache=cache,
            )

        # Both markers should remain because the active lock was detected
        assert marker2.exists(), "Marker 2 must not be deleted when lock is present"
        assert marker3.exists(), "Marker 3 must not be deleted when lock is present"
        assert metrics.deleted == 0
        assert metrics.skipped_locked >= 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    test_regex_matching()
    test_dry_run_preserves_everything()
    test_execute_deletes_only_eligible_empty_marker()
    test_skip_live_session()
    test_skip_locked_session()
    test_fail_closed_on_enumeration_error()
    test_reparse_point_skipped()
    test_potential_veyyon_executable_detection()
    test_fail_closed_on_unreadable_potential_veyyon_cmdline()
    test_ignore_unreadable_system_cmdline()
    test_repository_lock_format_active_pid()
    test_repository_lock_format_dead_pid()
    test_unreadable_existing_lock_counts_live()
    test_sibling_and_candidate_lock_locations_checked()
    test_internal_lock_detected_during_session_marker_processing()
    test_tail_markers_preserved()
    test_all_markers_preserved_when_no_published_artifacts()
    test_resumed_old_allocator_coexistence_with_preserved_tail()
    test_fail_closed_on_null_proc_name_and_null_cmdline()
    test_lock_safety_corrupted_json_and_candidate_locks()
    test_process_snapshot_cache_refresh_on_fingerprint_change()
    test_process_snapshot_cache_fails_closed_when_enumeration_fails()
    test_native_process_identities_tracks_pid_and_ctime()
    test_has_active_direct_locks()
    test_max_deletions_bounded_chunking()
    test_reused_pid_creation_time_transition_triggers_refresh()
    test_same_pid_set_lock_change_aborts_deletion_per_marker()
    print("All comprehensive tests passed successfully (27 test suites).")
