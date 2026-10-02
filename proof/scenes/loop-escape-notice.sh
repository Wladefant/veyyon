#!/usr/bin/env bash
# The notice /loop prints when it turns the loop on while idle.
#
# A fresh session at default settings. /loop enables the loop without a
# provider call, and its status line names what Esc does to a running loop.
#
#   proof/record.sh --width 1440 --pair proof/scenes/loop-escape-notice.sh
set +e
settle 8
t "/loop"
pause 1.2
k Escape
pause 0.6
k Return
settle 3
shot loop-enabled
