#!/usr/bin/env bash
# A `!` execution block whose output line is wider than the per-line column cap
# (`tools.outputMaxColumns`, 768 bytes by default). The block's footer names the
# cap as a warning; before the fix the footer carried only the window truncation,
# so a block that lost bytes to the column cap said nothing about it.
#
# No model turn: `!` is the composer's local-execution prefix, so the block is the
# shipped CLI running a real command and drawing its own result.
settle 14
shot idle

submit "!echo short line; printf %0900d 0; echo; echo done"
settle 8
shot column-capped-block
