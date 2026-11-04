#!/usr/bin/env bash
# The artifact rows under an isolated task's result.
#
# WHAT IT SHOWS. An isolated task that finishes with changes saves them as a
# patch, and a nested repository's changes as a nested patch. The result card
# printed the patch row and dropped the nested patch. It now lists every nested
# patch under its own `Nested patch:` label, with the home directory shortened
# to `~` and the row bounded to the content width like the `Patch:` row above.
#
# WHY THE RESULT IS SEEDED. Both arms must draw the same task result, and no
# model run produces the same artifact paths twice. proof/docker/seed-demo.sh
# writes a finished session for this scene only, and the scene resumes it.
#
# HOW TO RECORD THE PAIR. A static change, so two stills:
#
#   PROOF_BASE_REF=<merge>^1 proof/record.sh --pair proof/scenes/task-artifact-rows.sh

STEM="2026-08-14T12-00-00-000Z_0198ac11-0000-7000-9d0e-4a1f2b6c8e41"

settle 16
submit "/resume ${STEM}"
settle 6
# needle-source: The parser fix is saved as a patch for review. -- the seeded reply after the task result
expect_screen "The parser fix is saved as a patch for review." 30
# needle-source: Patch: -- the artifact row label both arms print
expect_screen "Patch:" 15
if [[ "${SCENE_ARM:-after}" != "before" ]]; then
	# needle-source: Nested patch: -- the nested repository's patch row the change adds
	expect_screen "Nested patch:" 15
fi
shot artifact-rows
