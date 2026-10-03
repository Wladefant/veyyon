#!/usr/bin/env bash
# Leaving settings on a terminal that re-reports its size when the alternate
# screen toggles.
#
# WHAT IT SHOWS. Settings is a fullscreen overlay on the alternate screen. Some
# terminals answer the switch back to the normal buffer with a SIGWINCH that
# changes only the height. The resize fast path used to borrow the alternate
# screen for every resize, so that echo re-entered the alternate screen for one
# frame after settings had closed: the transcript flashed away and back. A
# height-only resize reflows nothing in the normal buffer, so the fast path now
# repaints the normal screen in place, and the transcript stays put.
#
# WHY THE ECHO IS DRIVEN BY HAND. kitty does not re-report its size on an
# alternate-screen toggle, so the scene sends the same echo itself once settings
# has closed: it shrinks the window by two rows and grows it back, which is the
# height-only SIGWINCH pair those terminals send. The width never changes. The
# resize goes through kitty remote control rather than the X window id, which a
# take can lose between arms.
#
# WHAT kitty DRAWS. The fast path paints inside synchronized output, so kitty
# shows the borrowed alternate screen and the normal one as the same pixels: at
# 60 fps both arms change luminance exactly twice in the resize window (the
# shrink and the grow) with no frame in between. The differential is therefore
# the write log: run the pair with
#
#   SCENE_COMMAND="env VEYYON_TUI_WRITE_LOG=/out/settings-exit-resize-tui.log bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"
#
# and count `ESC [ ? 1049 h` in each arm's log: settings enters the alternate
# screen once in both arms, and only the before arm enters it again per resize.
#
# HOW TO RECORD THE PAIR. With the SCENE_COMMAND above:
#
#   SCENE_FPS=60 SCENE_HEIGHT=1080 SCENE_MOTION_FLOOR=0 proof/record.sh --pair proof/scenes/settings-exit-resize.sh

STEM="2026-08-14T11-00-00-000Z_0198ab02-9d53-7000-9d0e-4a1f2b6c8e22"

# One height-only SIGWINCH: resize the terminal window by <rows> cell rows,
# keeping its width. The offset into the clip goes to the log, so the frames
# inside the 120 ms resize window can be cut from the 60 fps video.
resize_rows() { # resize_rows <rows>
	echo "scene: resize ${1} rows at $(($(date +%s%3N) - ${SCENE_T0:-0})) ms" >&2
	kitty @ --to "${KITTY_SOCKET}" resize-os-window --incremental --unit cells --height "$1"
}

settle 16
submit "/resume ${STEM}"
settle 6
# needle-source: A session starts in Working and ends from Archived. -- the seeded reply's closing line
expect_screen "A session starts in Working and ends from Archived." 30
shot transcript

submit "/settings"
settle 3
# needle-source: Appearance -- the settings sidebar, so the overlay holds the alternate screen
expect_screen "Appearance" 30
shot settings

k Escape
# needle-source: A session starts in Working and ends from Archived. -- settings has closed and the transcript is back
expect_screen "A session starts in Working and ends from Archived." 30
shot closed

resize_rows -2
settle 2
shot shrunk
resize_rows 2
settle 3
# needle-source: A session starts in Working and ends from Archived. -- the transcript is back after the echo settles
expect_screen "A session starts in Working and ends from Archived." 30
shot settled
