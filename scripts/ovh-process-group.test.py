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
WRAPPER = ROOT / "scripts" / "ovh-process-group.sh"
TREE = """import os,signal,time,sys
def publish_pid(path, pids):
 temp=path+'.tmp.'+str(os.getpid())
 with open(temp,'w') as file: file.write(' '.join(map(str,pids)))
 os.replace(temp,path)
def read_pid(path):
 try:
  with open(path) as file: return int(file.read())
 except (FileNotFoundError, ValueError): return None
mode=sys.argv[1]
child=os.fork()
if child == 0:
 grandchild=os.fork()
 if grandchild == 0:
  if mode == 'stubborn': signal.signal(signal.SIGTERM,signal.SIG_IGN)
  publish_pid(os.environ['PIDFILE']+'.grandchild',[os.getpid()])
  time.sleep(60); os._exit(0)
 publish_pid(os.environ['PIDFILE']+'.child',[os.getpid()])
 time.sleep(60); os._exit(0)
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


def run_case(name, command, expected, sig=None, need_tree=False):
    with tempfile.TemporaryDirectory() as directory:
        pidfile = Path(directory) / "pids"
        env = dict(os.environ, PIDFILE=str(pidfile))
        proc = subprocess.Popen(["bash", str(WRAPPER), *command], env=env, start_new_session=True)
        pids = []
        try:
            if need_tree:
                wait_for_file(pidfile, proc)
                pids = [int(pid) for pid in pidfile.read_text().split()]
                require(len(pids) == len(set(pids)), f"{name}: PID file contains duplicate PIDs: {pids}")
            if sig is not None:
                os.kill(proc.pid, sig)
            status = proc.wait(timeout=4)
            require(status == expected, f"{name}: status {status}, expected {expected}")
            if pids:
                require(not any(alive(pid) for pid in pids), f"{name}: live descendants remain: {pids}")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            kill_test_pids(pids)


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


def main():
    require(sys.platform.startswith("linux"), "requires Linux process groups")
    require(WRAPPER.is_file(), f"missing wrapper: {WRAPPER}")
    run_case("success", ["bash", "-c", "exit 0"], 0)
    run_case("failure", ["bash", "-c", "exit 7"], 7)
    run_startup_cancellation()
    run_case("normal descendant", ["python3", "-c", TREE, "exit"], 0, need_tree=True)
    run_case("timeout", ["timeout", "--signal=TERM", "1.5", "python3", "-c", TREE, "sleep"], 124, need_tree=True)
    run_case("INT", ["python3", "-c", TREE, "sleep"], 130, signal.SIGINT, True)
    run_case("TERM escalation", ["python3", "-c", TREE, "stubborn"], 143, signal.SIGTERM, True)
    workflow_shell = "bash scripts/ovh-process-group.sh bash --noprofile --norc -eo pipefail"
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "step.sh"
        output = Path(directory) / "output"
        script.write_text("printf ok | tee \"$OUTPUT\"\n")
        result = subprocess.run(["bash", str(WRAPPER), "bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)], env=dict(os.environ, OUTPUT=str(output)), timeout=4, check=False)
        require(result.returncode == 0 and output.read_text() == "ok", f"workflow shell pipeline failed: {workflow_shell}")
    print("ovh-process-group: 8 passed, 0 failed")


if __name__ == "__main__":
    main()
