#!/usr/bin/env bash
# Theme colour depth under a terminal that does not advertise truecolor.
#
# Recorded with the environment macOS Terminal.app hands its child (TERM_PROGRAM
# set, TERM=xterm-256color, no COLORTERM, none of kitty's own markers), which
# proof/docker/color-depth-seed/cmd.sh sets up:
#
#   SCENE_COMMAND="bash /repo/proof/docker/color-depth-seed/cmd.sh" \
#     proof/record.sh --pair proof/scenes/theme-color-depth.sh
#
# The before arm sends 24-bit SGR to that terminal; the after arm sends the
# 256-colour palette. /out/theme-color-depth-sgr.txt counts each form in what
# the app wrote, so the frames are backed by the bytes.
set +e
# The first frame paints the composer before the session lands; the model in
# the footer is the session.
expect_screen "Qwen2.5 1.5B (local)" 120 launch
settle 6
shot startup
t "/"
pause 2
shot commands
# Escape as a pty byte: an XTEST key did not reach the window on the
# containerised recorder.
kitty @ --to "${KITTY_SOCKET}" send-text -- $'\e'
pause 1
{
	f=/out/theme-color-depth-app.raw
	echo "-- ${f}: $(wc -c <"$f") bytes"
	echo "-- 24-bit fg/bg $(grep -aoE $'\e\\[[0-9;]*[34]8;2;' "$f" | wc -l), 256-colour fg/bg $(grep -aoE $'\e\\[[0-9;]*[34]8;5;' "$f" | wc -l)"
} >/out/theme-color-depth-sgr.txt 2>&1
