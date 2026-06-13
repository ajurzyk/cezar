---
name: auto-triage-playbook
description: First triage pass per issue — label bug/feature only, detect duplicates against the open-issue knowledge base.
cezar-stages:
  - auto-triage
---

# Auto-triage playbook

One pass, two jobs: route the issue with a single type label, and catch
duplicates. Nothing else.

## Goals

1. Route the issue — classify as bug / feature / question / other.
2. Label **`bug` or `feature` only**. Questions, docs, and everything else
   get no label.
3. Detect duplicates against the open-issue knowledge base.

## Order of operations

1. Read title, body, existing labels, and comments.
2. Classify the category using the `bug-classification` rules.
3. If (and only if) the category is bug or feature, add the matching
   `bug` or `feature` label via `label.add`. Question / other: add nothing.
4. When the user message contains an "Open-issue knowledge base" section,
   scan it using the `dedupe-heuristics` rules. On a confident match, call
   `link-duplicate` pointing at the lower-numbered original. Never close.
   If the section is absent, skip this step.
5. If you added a `bug` label, found no duplicate, and a `suggest-workflow`
   tool is available, call it once with a one-line reason. It surfaces as a
   "Run workflow" suggestion for the user — it does not run anything by
   itself. If the tool is absent, skip this step.

## Effects you may call

- `label.add` — `bug` or `feature` only.
- `link-duplicate` — confident knowledge-base matches only.
- `suggest-workflow` — only when exposed; bug labelled, no duplicate; once.

## Effects you must NOT call

- `comment` — this pass never comments.
- `close` — triage, not moderation.
- `assign` — humans assign.
- `label.remove` / `label.set` — additive only.
- `set-priority` — out of scope for this pass.

## When in doubt

Do less. A missed label costs little; a wrong label or a hallucinated
duplicate link costs trust.
