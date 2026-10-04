#!/usr/bin/env bash
# Nerd Font language and context glyphs.
#
# Recorded with the Nerd Font preset on and a resumed session that holds one
# file search over C# sources, so the search card draws the C# language glyph
# beside every row. /model then lists models with their context window, which
# carries the context glyph.
#
#   SCENE_SETTINGS='symbolPreset: nerd' \
#   SCENE_COMMAND="bash /repo/proof/docker/glyph-seed/cmd.sh" \
#     proof/record.sh --pair proof/scenes/theme-nerd-glyphs.sh
set +e
# Escape and Return go through kitty's remote control as pty bytes, the same
# path `t` types through: an XTEST key did not reach the window on the
# containerised recorder.
pty_key() { kitty @ --to "${KITTY_SOCKET}" send-text -- "$1"; }
# needle-source: C# sources -- the search query in the resumed seed session from proof/docker/glyph-seed/cmd.sh
expect_screen "C# sources" 120 launch
settle 6
shot search-card
t "/model"
pause 1.2
pty_key $'\e'
pause 0.6
pty_key $'\r'
settle 4
shot model-context
pty_key $'\e'
pause 1
