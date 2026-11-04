#!/usr/bin/env bash
# Search the General settings page for two families of rows and count what the
# page draws for each: the rows the host sends and the row a condition hides.
#
# Records visual evidence for:
#   1. settings-reach-rest      (the General page as the query field found it)
#   2. settings-reach-unset     (the page searched for `mnemopi`)
#   3. settings-reach-condition (the same page searched for `auto thinking`)
#
# THE CLAIM. Two settings the terminal offers were unreachable on the desktop
# for two different reasons, and both are the host's answer rather than the
# window's drawing.
#
#   * A setting with no value and no default -- a memory database path nobody
#     set -- was dropped from the settings the host sends, because a field whose
#     value is `undefined` does not survive `JSON.stringify`. The page drew no
#     row for it at all. It crosses as null now and draws as an empty control.
#   * `providers.autoThinkingModel` declares `ui.condition:
#     "autoThinkingActive"`, and the desktop resolved conditions through its own
#     copy of the predicate table, which had no entry under that name. An
#     unknown condition draws the row, so the desktop offered a knob the
#     terminal hides while the thinking level is not `auto`.
#
# WHAT IS MEASURED. The control bands of the body under the query field, read
# by `desktop-settings-body.sh`: one band per row the page lists, and none for
# a query the page answers with its empty state.
#
#   * `mnemopi`: the memory backend's eight paths and keys. The after arm draws
#     at least six bands, the before arm at most one -- the row the query
#     matches on its description rather than its key.
#   * `auto thinking`: one label in the whole schema, `Auto Thinking Model`,
#     and no key, description or group. The before arm draws its control; the
#     after arm draws none, since the thinking level is not `auto` and the
#     condition the row declares is unmet.
#
# Both arms seed `memory.backend: mnemopi`, since the mnemopi rows carry
# `ui.condition: "mnemopiActive"` on both front ends and are hidden for any
# other backend. The seeded value is what makes the first reading a statement
# about the host's answer rather than about the condition.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The sheet is still between keystrokes, so
# the take carries a motion floor. Record the after arm with:
#
#   SCENE_MOTION_FLOOR=4 SCENE_SETTINGS='memory.backend: mnemopi' \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-reach.sh
#
# The differential is in the host the window talks to rather than in the
# executable, so the before arm holds the source at the commit before the fix
# and shares this tree's binary:
#
#   SCENE_ARM=before PROOF_BASE_REF=8619f031b0^ SCENE_MOTION_FLOOR=4 \
#     SCENE_SETTINGS='memory.backend: mnemopi' \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-reach.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-settings-body.sh"

# The memory backend declares eight paths and keys with no default. The after
# arm draws at least six of them in the body; the before arm draws at most the
# one row whose description the query matches.
UNSET_ROWS_MIN=6
UNSET_ROWS_MAX=1

# ─── Open The General Page ───────────────────────────────────────────────────
open_general_page
measure_search_field
shot settings-reach-rest

# ─── A Search For The Rows With No Default ───────────────────────────────────
move_px "${SEARCH_X}" "${SEARCH_Y}"
click
pause 0.4
t "mnemopi"
pause 1.0
shot settings-reach-unset
UNSET_QUERY_PX="$(query_ink_moved settings-reach-rest settings-reach-unset)"
if [ "${UNSET_QUERY_PX}" -lt 40 ]; then
	abandon_take "settings-reach-unset" \
		"the field changed ${UNSET_QUERY_PX} pixels while \`mnemopi\` was typed, so the query reached no field and the count below would be of the page the scene left alone"
fi
UNSET_ROWS="$(band_count settings-reach-unset)"

# ─── A Search For The Row A Condition Governs ────────────────────────────────
# `auto thinking` matches one label in the whole schema, `Auto Thinking Model`,
# and no key, description or group, so the body draws that row and nothing
# else. The field holds the first query, so it is emptied a character at a time
# rather than by a chord the page may not bind.
for _ in 1 2 3 4 5 6 7; do k "BackSpace"; done
pause 0.4
t "auto thinking"
pause 1.0
shot settings-reach-condition
CONDITION_QUERY_PX="$(query_ink_moved settings-reach-unset settings-reach-condition)"
if [ "${CONDITION_QUERY_PX}" -lt 40 ]; then
	abandon_take "settings-reach-condition" \
		"the field changed ${CONDITION_QUERY_PX} pixels between \`mnemopi\` and \`auto thinking\`, so the second query never replaced the first"
fi
CONDITION_ROWS="$(band_count settings-reach-condition)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${UNSET_ROWS}" -gt "${UNSET_ROWS_MAX}" ]; then
		abandon_take "settings-reach-unset" \
			"the baseline drew ${UNSET_ROWS} controls for \`mnemopi\`, over the ${UNSET_ROWS_MAX} a dump that drops an unset row leaves, so this arm proves nothing about reach"
	fi
	if [ "${CONDITION_ROWS}" -lt 1 ]; then
		abandon_take "settings-reach-condition" \
			"the baseline drew ${CONDITION_ROWS} controls for \`auto thinking\`, so it never offered the knob the unmet condition governs and this arm proves nothing about it"
	fi
	echo "scene: before arm -- ${UNSET_ROWS} controls for \`mnemopi\`, ${CONDITION_ROWS} for \`auto thinking\`" >&2
else
	if [ "${UNSET_ROWS}" -lt "${UNSET_ROWS_MIN}" ]; then
		abandon_take "settings-reach-unset" \
			"the page drew ${UNSET_ROWS} controls for \`mnemopi\`, under the ${UNSET_ROWS_MIN} the backend's paths and keys hold, so a row with no value still fails to cross"
	fi
	if [ "${CONDITION_ROWS}" -ne 0 ]; then
		abandon_take "settings-reach-condition" \
			"the page drew ${CONDITION_ROWS} controls for \`auto thinking\` while the thinking level is not \`auto\`, so the row the unmet condition governs is still offered"
	fi
	echo "scene: after arm -- ${UNSET_ROWS} controls for \`mnemopi\`, ${CONDITION_ROWS} for \`auto thinking\`" >&2
fi
