#!/usr/bin/env bash
# Type in the General settings page's query field in the native GPUI window and
# photograph what each keystroke does to the rows under it.
#
# Records visual evidence for:
#   1. settings-query-rest       (the page as the field found it)
#   2. settings-query-narrowed   (the rows a typed query leaves)
#   3. settings-query-empty      (one more character, matching nothing)
#   4. settings-query-recovered  (a backspace, over the empty page)
#   5. settings-query-widened    (Escape, over the narrowed page)
#
# THE CLAIM. The page drew its field from the query string, which is an
# `EditorSlot::Static`: a picture of a field, taking no focus and receiving no
# keystroke. The field looked typeable, and every character pressed on it went
# to the surface behind the sheet, so the two hundred rows the page lists could
# only be reached by scrolling. The field now draws the editor the frame
# retains, the filter is applied on the frame each character lands on, and
# Escape widens a narrowed page before it closes the page.
#
# WHAT IS MEASURED. The control bands of the body under the field, read by
# `desktop-settings-body.sh`: one band per row the page lists, none for the
# empty state, whose prose is centred in the body and clear of the strip the
# bands are read off. The band count is what each keystroke is judged on,
# because a whole-frame difference cannot separate the rows from the queue's
# own elapsed times, which tick between any two shots.
#
#   * `batch task` matches one label in the schema, so the page narrows from
#     the rows a body holds to that one.
#   * A `z` after it matches nothing, and the page states the empty result. The
#     field stays drawn over that row: it is the query that emptied the page, so
#     editing the query is the way out, and the backspace after it proves the
#     field took the keystroke while the page listed nothing.
#   * Escape over the narrowed page widens it back to the rows it started from,
#     at the first of them, and the page is still open behind it.
#
# The before arm takes the same keystrokes and its band count does not move: an
# element is rebuilt every frame, so the field a keystroke reached is discarded
# before the next frame draws the query string again. It is judged on the
# narrowing alone -- a baseline that never narrows has no narrowed page for
# Escape to widen, so the ladder step is an after-arm reading with nothing to
# compare it against.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The sheet is still between keystrokes, so
# the take carries a motion floor. Record the after arm with:
#
#   SCENE_MOTION_FLOOR=4 \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-query.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and names a build whose query field is a picture:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=<pre-fix-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-query.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-settings-body.sh"

# `batch task` matches the `Batch Task Calls` label and no other key, label,
# description or group in the schema, and the row it names declares no
# condition, so the page narrows to that one row at the defaults this take
# runs at. A body holds several rows at rest, and the narrowing is judged on
# the drop as well as on the one row, because how many rows fit is the
# window's height.
QUERY='batch task'
REST_ROWS_MIN=4
NARROWED_ROWS_MAX=1
NARROWING_DROP=2

# ─── Open The General Page ───────────────────────────────────────────────────
open_general_page
measure_search_field
shot settings-query-rest
REST_ROWS="$(band_count settings-query-rest)"
if [ "${REST_ROWS}" -lt "${REST_ROWS_MIN}" ]; then
	abandon_take "settings-query-rest" \
		"the page drew ${REST_ROWS} controls at rest, under the ${REST_ROWS_MIN} a body of rows holds, so a narrowing of it would prove nothing"
fi

# ─── Type A Query That Matches One Row ───────────────────────────────────────
# The keyboard is the page's own: it lands in the field when the page draws
# one, so the query is typed without a press. The click is what a pointer
# operator does, and it is taken here as well, so the take covers both.
move_px "${SEARCH_X}" "${SEARCH_Y}"
click
pause 0.4
t "${QUERY}"
pause 1.0
shot settings-query-narrowed
QUERY_PX="$(query_ink_moved settings-query-rest settings-query-narrowed)"
NARROWED_ROWS="$(band_count settings-query-narrowed)"

# ─── One More Character, Matching Nothing ────────────────────────────────────
t "z"
pause 1.0
shot settings-query-empty
EMPTY_ROWS="$(band_count settings-query-empty)"
FIELD_ON_EMPTY=no
if search_field_is_drawn; then FIELD_ON_EMPTY=yes; fi

# ─── Backspace, Over The Empty Page ──────────────────────────────────────────
k "BackSpace"
pause 1.0
shot settings-query-recovered
RECOVERED_ROWS="$(band_count settings-query-recovered)"

# ─── Escape, Over The Narrowed Page ──────────────────────────────────────────
# The first press widens the page; the page is still open behind it, which is
# what the field being locatable states.
k "Escape"
pause 1.0
shot settings-query-widened
WIDENED_ROWS="$(band_count settings-query-widened)"
PAGE_IS_OPEN=no
if search_field_is_drawn; then PAGE_IS_OPEN=yes; fi

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${NARROWED_ROWS}" -le $(( REST_ROWS - NARROWING_DROP )) ]; then
		abandon_take "settings-query-narrowed" \
			"the baseline narrowed the page: ${REST_ROWS} controls -> ${NARROWED_ROWS}, a drop of at least ${NARROWING_DROP}, so this arm proves nothing about the field"
	fi
	if [ "${QUERY_PX}" -ge 40 ]; then
		abandon_take "settings-query-narrowed" \
			"the baseline's field drew what was typed: ${QUERY_PX} pixels of its own band moved, so this arm proves nothing about the field"
	fi
	echo "scene: before arm -- ${REST_ROWS} controls -> ${NARROWED_ROWS} -> ${EMPTY_ROWS} ->" \
		"${RECOVERED_ROWS}, the page answered none of the keystrokes" >&2
else
	if [ "${NARROWED_ROWS}" -gt "${NARROWED_ROWS_MAX}" ]; then
		abandon_take "settings-query-narrowed" \
			"the page drew ${NARROWED_ROWS} controls for \`${QUERY}\`, over the ${NARROWED_ROWS_MAX} the one row it matches holds, so the query narrowed less than it states"
	fi
	if [ "${FIELD_ON_EMPTY}" != yes ]; then
		abandon_take "settings-query-empty" \
			"the page took its own query field away with the rows, so the query that emptied it cannot be edited"
	fi
	if [ "${QUERY_PX}" -lt 40 ]; then
		abandon_take "settings-query-narrowed" \
			"the field drew none of the ${#QUERY} characters typed into it: ${QUERY_PX} pixels of its own band moved"
	fi
	if [ "${NARROWED_ROWS}" -gt $(( REST_ROWS - NARROWING_DROP )) ]; then
		abandon_take "settings-query-narrowed" \
			"the page drew ${NARROWED_ROWS} controls for \`${QUERY}\` against ${REST_ROWS} at rest, under a drop of ${NARROWING_DROP}"
	fi
	if [ "${NARROWED_ROWS}" -lt 1 ]; then
		abandon_take "settings-query-narrowed" \
			"the page drew no control for \`${QUERY}\`, which matches a label the schema declares, so the query narrowed past the row it names"
	fi
	if [ "${EMPTY_ROWS}" -ne 0 ]; then
		abandon_take "settings-query-empty" \
			"the page drew ${EMPTY_ROWS} controls for a query matching nothing, so a row survived the filter that emptied the page"
	fi
	if [ "${RECOVERED_ROWS}" -ne "${NARROWED_ROWS}" ]; then
		abandon_take "settings-query-recovered" \
			"a backspace over the empty page left ${RECOVERED_ROWS} controls rather than the ${NARROWED_ROWS} the query before it matched, so the field took no keystroke while the page listed nothing"
	fi
	if [ "${WIDENED_ROWS}" -ne "${REST_ROWS}" ]; then
		abandon_take "settings-query-widened" \
			"Escape left ${WIDENED_ROWS} controls rather than the ${REST_ROWS} the page opened with, so it did not widen the page the query narrowed"
	fi
	if [ "${PAGE_IS_OPEN}" != yes ]; then
		abandon_take "settings-query-widened" \
			"Escape closed the page it was pressed on rather than widening it, so the query and the page leave on one press"
	fi
	echo "scene: after arm -- ${REST_ROWS} controls -> ${NARROWED_ROWS} for \`${QUERY}\` ->" \
		"${EMPTY_ROWS} for one character more -> ${RECOVERED_ROWS} on a backspace ->" \
		"${WIDENED_ROWS} on Escape, with the page still open" >&2
fi
