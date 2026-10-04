#!/usr/bin/env bash
# The notice /loop prints when it turns the loop on while idle.
#
# A fresh session at default settings. /loop enables the loop without a
# provider call, and its status line names what Esc does to a running loop:
# the before arm says Esc cancels the current iteration, the after arm says it
# suspends the loop until a new prompt.
#
#   proof/record.sh --pair proof/scenes/loop-escape-notice.sh
#
# A still of a status line, so the motion floor is off for both arms
# (SCENE_MOTION_FLOOR=0).
set -euo pipefail

# The composer placeholder is the first string that proves the composer takes
# input; typing before it lands keys in the launching shell instead.
expect_screen "ask anything" 60 launch
# Keys typed before the session lands reach the first-frame composer, which
# keeps the startup hero mounted; keys typed after it dismiss the hero. Waiting
# for the model in the footer puts both arms on the same side of that race.
expect_screen "Qwen2.5 1.5B (local)" 90 session
settle 4

# Typed and submitted through kitty's remote control, Return included. No
# completion popup opens for the exact command, so there is nothing for an
# Escape to dismiss, and an XTEST Return did not reach the window on this
# recorder (the composer kept "/loop" for 30 s), while the pty carriage return
# submits it.
t "/loop"
# needle-source: › /loop -- the prompt prefix and typed slash command in the composer
expect_screen "› /loop" 90 typed
pause 1
kitty @ --to "${KITTY_SOCKET}" send-text -- $'\r'
expect_screen "Loop mode enabled" 30 loop-enabled
if [ "${SCENE_ARM:-after}" != before ]; then
	expect_screen "Esc suspends the ongoing loop" 30 loop-enabled
fi
settle 3
shot loop-enabled
settle 2
