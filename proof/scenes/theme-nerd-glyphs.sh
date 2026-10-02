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
settle 12
shot search-card
t "/model"
pause 1.2
k Escape
pause 0.6
k Return
settle 4
shot model-context
k Escape
pause 1
