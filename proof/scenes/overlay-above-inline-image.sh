#!/usr/bin/env bash
# A full-width overlay drawn over an inline image.
#
# The resumed session holds one read of a PNG, which kitty draws inline with
# Unicode placeholders. `/autoresearch status` then opens the run screen, a
# full-width overlay above the composer zone that is not fullscreen, so it is
# composited over the transcript rows rather than painted on the alt buffer.
# Before the fix the image rows kept their placeholders and the picture covered
# the screen; after, the overlay replaces them and the image returns on close.
#
#   SCENE_COMMAND="bash /repo/proof/docker/image-seed/cmd.sh" \
#     proof/record.sh --pair proof/scenes/overlay-above-inline-image.sh
set +e
# Escape and Return go through kitty's remote control as pty bytes, the same
# path `t` types through: an XTEST key did not reach the window on the
# containerised recorder.
pty_key() { kitty @ --to "${KITTY_SOCKET}" send-text -- "$1"; }
expect_screen "Diagram" 120 launch
settle 6
shot inline-image
t "/autoresearch status"
pause 1.2
pty_key $'\e'
pause 0.6
pty_key $'\r'
settle 4
shot overlay-over-image
pty_key $'\e'
settle 3
shot image-restored
