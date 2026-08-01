#!/bin/sh
# Muted while the sentinel exists. A settings-only port would silently un-mute this.
if [ -f "__HOME__/.claude/hooks/.quiet" ]; then
  exit 0
fi
say "done"
