#!/usr/bin/env bash
# The effort a session starts with when its model comes from an extension.
#
# WHAT IT SHOWS. With no model on the command line and none in config, startup
# picks a model only after the extensions have registered their providers. That
# late pick kept the effort settled before any model existed, so the any-model
# row (`high`, clamped to the model's `med`) won over the row the profile saves
# for that model (`low`). The late pick now settles the effort against the
# model it picked, and the status line shows `@low`.
#
# The extension, the enabledModels filter, the two effort rows and the missing
# default model are seeded by proof/docker/seed-demo.sh for this scene only.
# The launch names no model, so the scene needs its own command:
#
#   SCENE_COMMAND="bun /repo/packages/coding-agent/src/cli.ts" \
#   PROOF_BASE_REF=<merge>^1 proof/record.sh --pair proof/scenes/late-model-effort.sh

settle 16
# needle-source: Late Model -- the extension's model, the only one enabledModels admits
expect_screen "Late Model" 30
shot status-line
