#!/usr/bin/env bash
# `veyyon usage` for two Codex accounts that each carry a chat meter and a
# Spark meter over the same 5-hour and weekly windows.
#
# The capacity line at the bottom sums every account per window. Before the
# fix the chat and Spark meters of one window share a bucket; after, each
# meter has its own entry, labelled Chat or Spark.
#
#   SCENE_COMMAND="bash /repo/proof/docker/codex-usage-seed/cmd.sh" \
#     proof/record.sh --pair proof/scenes/codex-usage-meters.sh
set +e
settle 10
shot usage-capacity
