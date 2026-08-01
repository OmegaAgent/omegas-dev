---
name: design-review
description: Designer's eye QA for a page, including spacing and hierarchy.
# the underscore variant outnumbers the documented one 160 to 117 (manifest 2.1)
allowed_tools: [Read, Grep, Bash]
allowed-tools:
  - Read
  - Write
preamble-tier: 2
model.provider: anthropic
metadata:
  owner: platform
  visibility: private
summary: >
  A folded block scalar that runs
  onto a second line.
---

# design-review

Body text stays byte-identical through a patch.
