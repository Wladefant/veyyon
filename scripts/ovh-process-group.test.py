#!/usr/bin/env python3
"""Regression coverage for OVH step process-group cleanup; Linux only."""
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = Path(os.environ.get("OVH_PROCESS_GROUP_WRAPPER", ROOT / "scripts" / "ovh-process-group.sh"))
TREE = """import os,signal,time,sys
def publish_pid(path, pids):
 temp=path+'.tmp.'+str(os.getpid())
 with open(temp,'w') as file: file.write(' '.join(map(str,pids)))
 os.replace(temp,path)
mode=sys.argv[1]
child=os.fork()
if child == 0:
 grandchild=os.fork()
 if grandchild == 0:
  if mode in ('stubborn','deadline-stubborn'): signal.signal(signal.SIGTERM,signal.SIG_IGN)
  publish_pid(os.environ['PIDFILE']+'.grandchild',[os.getpid()])
  time.sleep(60); os._exit(0)
 publish_pid(os.environ['PIDFILE']+'.child',[os.getpid()])
 time.sleep(60); os._exit(0)
def read_pid(path):
 try:
  with open(path) as file: return int(file.read())
 except (FileNotFoundError, ValueError): return None
deadline=time.monotonic()+3
while (read_pid(os.environ['PIDFILE']+'.child') is None or read_pid(os.environ['PIDFILE']+'.grandchild') is None) and time.monotonic()<deadline: time.sleep(.005)
pids=list(dict.fromkeys([os.getpid(),child,read_pid(os.environ['PIDFILE']+'.child'),read_pid(os.environ['PIDFILE']+'.grandchild')]))
publish_pid(os.environ['PIDFILE'],pids)
if mode == 'exit': os._exit(0)
time.sleep(60)
"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


def wait_for_file(path, proc):
    deadline = time.monotonic() + 3
    while not path.exists() and proc.poll() is None and time.monotonic() < deadline:
        time.sleep(.02)
    require(path.exists(), "child tree did not start")


def kill_test_pids(pids):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

def wait_for_cleanup_sleep(proc):
    # The wrapper's sleep is the real escalation window, not a guessed delay.
    deadline = time.monotonic() + 3
    children = Path(f"/proc/{proc.pid}/task/{proc.pid}/children")
    while proc.poll() is None and time.monotonic() < deadline:
        for pid in children.read_text().split():
            try:
                if Path(f"/proc/{pid}/comm").read_text().strip() == "sleep":
                    return
            except (FileNotFoundError, ProcessLookupError):
                pass
        time.sleep(.005)
    raise AssertionError("wrapper did not enter cleanup escalation")

def run_case(name, command, expected, sig=None, need_tree=False, timeout=None, env_extra=None, repeated_sig=None):
    with tempfile.TemporaryDirectory() as directory:
        pidfile = Path(directory) / "pids"
        env = dict(os.environ, PIDFILE=str(pidfile), **(env_extra or {}))
        if timeout is not None:
            env["OVH_STEP_TIMEOUT"] = timeout
        proc = subprocess.Popen(["bash", str(WRAPPER), *command], env=env, start_new_session=True)
        pids = []
        try:
            if need_tree:
                wait_for_file(pidfile, proc)
                pids = [int(pid) for pid in pidfile.read_text().split()]
                require(len(pids) == len(set(pids)), f"{name}: PID file contains duplicate PIDs: {pids}")
            if sig is not None:
                os.kill(proc.pid, sig)
            if repeated_sig is not None:
                wait_for_cleanup_sleep(proc)
                os.kill(proc.pid, repeated_sig)
            if timeout is not None and pids:
                snapshot = subprocess.run(["ps", "-o", "pid,ppid,pgid,sid,stat,args", "-p", ",".join(map(str, pids))], text=True, capture_output=True, check=True).stdout.strip()
                print(f"{name} ps before:\n{snapshot}")
            status = proc.wait(timeout=8)
            require(status == expected, f"{name}: status {status}, expected {expected}")
            if pids:
                require(not any(alive(pid) for pid in pids), f"{name}: live descendants remain: {pids}")
                if timeout is not None:
                    after = subprocess.run(["ps", "-o", "pid,ppid,pgid,sid,stat,args", "-p", ",".join(map(str, pids))], text=True, capture_output=True, check=False).stdout.strip() or "no matching live processes"
                    print(f"{name} ps after:\n{after}")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            kill_test_pids(pids)


def run_cleanup_case(matrix_index):
    with tempfile.TemporaryDirectory() as directory:
        pidfile = Path(directory) / "pids"
        workspace = str(Path(directory) / "ci-workspace")
        identity = dict(GITHUB_WORKSPACE=workspace, GITHUB_RUN_ID="12345", GITHUB_RUN_ATTEMPT="1", GITHUB_JOB="toy", PIDFILE=str(pidfile))
        environment = dict(os.environ, **identity)
        environment.pop("OVH_MATRIX_INDEX", None)
        if matrix_index is not None:
            environment["OVH_MATRIX_INDEX"] = matrix_index
        owner = f"{workspace}|12345|1|toy|{matrix_index or ''}"
        tagged = subprocess.Popen(["python3", "-c", TREE, "sleep"], env=dict(environment, OVH_PROCESS_OWNER=owner), start_new_session=True)
        foreign_workspace = workspace + "-foreign"
        foreign_identity = dict(identity, GITHUB_WORKSPACE=foreign_workspace, PIDFILE=str(pidfile) + ".foreign")
        foreign = subprocess.Popen(["python3", "-c", TREE, "sleep"], env=dict(environment, **foreign_identity, OVH_PROCESS_OWNER=f"{foreign_workspace}|12345|1|toy|{matrix_index or ''}"), start_new_session=True)
        tagged_pids, foreign_pids = [], []
        try:
            wait_for_file(pidfile, tagged)
            wait_for_file(Path(str(pidfile) + ".foreign"), foreign)
            tagged_pids = [int(pid) for pid in pidfile.read_text().split()]
            foreign_pids = [int(pid) for pid in Path(str(pidfile) + ".foreign").read_text().split()]
            tagged_group = os.getpgid(tagged.pid)
            tagged.kill()  # Simulate runner actor loss; the tagged group remains.
            tagged.wait(timeout=2)
            cleanup = subprocess.run(["bash", str(WRAPPER), "--cleanup"], env=environment, timeout=4, check=False)
            require(cleanup.returncode == 0, f"cleanup returned {cleanup.returncode}")
            require(not any(alive(pid) for pid in tagged_pids), f"cleanup left tagged group {tagged_group}: {tagged_pids}")
            require(any(alive(pid) for pid in foreign_pids), f"cleanup killed foreign group: {foreign_pids}")
        finally:
            for proc in (tagged, foreign):
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=2)
            kill_test_pids(tagged_pids + foreign_pids)


def run_startup_cancellation():
    with tempfile.TemporaryDirectory() as directory:
        pidfile = Path(directory) / "pids"
        proc = subprocess.Popen(
            ["bash", str(WRAPPER), "python3", "-c", TREE, "sleep"],
            env=dict(os.environ, PIDFILE=str(pidfile)),
            start_new_session=True,
        )
        pids = []
        try:
            os.kill(proc.pid, signal.SIGTERM)
            status = proc.wait(timeout=4)
            require(status in (-signal.SIGTERM, 143), f"startup cancellation: status {status}")
            if pidfile.exists():
                pids = [int(pid) for pid in pidfile.read_text().split()]
                require(not any(alive(pid) for pid in pids), f"startup cancellation left live PIDs: {pids}")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            kill_test_pids(pids)


def run_deadline_case(mode):
    run_case(f"independent deadline {mode}", ["python3", "-c", TREE, mode], 124, need_tree=True, timeout="5s")


def main():
    require(sys.platform.startswith("linux"), "requires Linux process groups")
    require(WRAPPER.is_file(), f"missing wrapper: {WRAPPER}")
    if os.environ.get("OVH_TEST_DEADLINE_ONLY") == "1":
        run_deadline_case("sleep")
        run_deadline_case("deadline-stubborn")
        print("ovh-process-group: 2 passed, 0 failed")
        return
    run_case("success", ["bash", "-c", "exit 0"], 0)
    run_case("failure", ["bash", "-c", "exit 7"], 7)
    run_startup_cancellation()
    run_case("normal descendant", ["python3", "-c", TREE, "exit"], 0, need_tree=True)
    run_case("timeout", ["timeout", "--signal=TERM", "1.5", "python3", "-c", TREE, "sleep"], 124, need_tree=True)
    run_case("INT", ["python3", "-c", TREE, "sleep"], 130, sig=signal.SIGINT, need_tree=True)
    run_case("TERM escalation", ["python3", "-c", TREE, "stubborn"], 143, sig=signal.SIGTERM, need_tree=True)
    run_case("repeated TERM escalation", ["python3", "-c", TREE, "stubborn"], 143, sig=signal.SIGTERM, need_tree=True, repeated_sig=signal.SIGTERM)
    run_deadline_case("sleep")
    run_deadline_case("deadline-stubborn")
    run_cleanup_case(None)
    run_cleanup_case("0")
    workflow_shell = "bash scripts/ovh-process-group.sh bash --noprofile --norc -eo pipefail"
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "step.sh"
        output = Path(directory) / "output"
        script.write_text("printf ok | tee \"$OUTPUT\"\n")
        result = subprocess.run(["bash", str(WRAPPER), "bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)], env=dict(os.environ, OUTPUT=str(output)), timeout=4, check=False)
        require(result.returncode == 0 and output.read_text() == "ok", f"workflow shell pipeline failed: {workflow_shell}")
    print("ovh-process-group: 13 passed, 0 failed")


if __name__ == "__main__":
    main()


