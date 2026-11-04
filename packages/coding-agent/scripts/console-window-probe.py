"""Console-window probe for Windows spawn flags (issue: agent children open visible consoles).

Run as the *child* of a spawn variant. It starts N console grandchildren. Each grandchild
asks the kernel which processes share its console (GetConsoleProcessList) and prints it.
One JSON summary line results:

  {"n": 5, "own_console": <child has a console>, "shared": s, "new_console": c, "none": z}

- shared:      grandchild attached to the child's console (inherited, hidden or not): no new window.
- new_console: grandchild got a console of its own (conhost.exe spawned, visible window): THE BUG.
- none:        grandchild has no console at all.

Measured via Win32 console process lists, never by looking.
"""

import ctypes
import json
import os
import subprocess
import sys

N = 5
GRANDCHILD = (
    "import ctypes,json;k=ctypes.windll.kernel32;"
    "a=(ctypes.c_uint32*64)();n=k.GetConsoleProcessList(a,64);"
    "print(json.dumps({'pids':list(a)[:n]}))"
)


def main() -> None:
    me = os.getpid()
    shared = new_console = none = hung = 0
    for _ in range(N):
        try:
            out = subprocess.run([sys.executable, "-c", GRANDCHILD], capture_output=True, text=True, timeout=15)
            pids = json.loads(out.stdout.strip().splitlines()[-1])["pids"]
        except (subprocess.TimeoutExpired, IndexError, ValueError):
            # A console-less parent forcing a fresh console can stall in the console host handoff.
            hung += 1
            continue
        if not pids:
            none += 1
        elif me in pids:
            shared += 1
        else:
            new_console += 1
    arr = (ctypes.c_uint32 * 64)()
    own = ctypes.windll.kernel32.GetConsoleProcessList(arr, 64) > 0
    print(
        json.dumps(
            {"n": N, "own_console": own, "shared": shared, "new_console": new_console, "none": none, "hung": hung}
        )
    )


if __name__ == "__main__":
    main()
