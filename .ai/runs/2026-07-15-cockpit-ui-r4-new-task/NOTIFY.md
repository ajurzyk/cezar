# Notifications — R4
- 2026-07-15T00:08:14Z — run start (R4), 4 steps.
- 2026-07-15T02:35:01Z — run end (R4): step 1.4 done — table inline rename (spec step 15), highlighter tokenizeTimeLimit flake root-caused and fixed, /new links SPA-routed, tarball verified clean; R4 complete.
- 2026-07-15T04:47:30Z — om-auto-continue-pr-loop resume by @pkarw. Resume point: step 1.4 (HANDOFF said 1.1 — stale; the crashed session left 1.4 implemented but uncommitted in the worktree; reconciled from the working tree + its own NOTIFY run-end entry). PR head was c0680f0.
- 2026-07-15T04:47:35Z — step 1.4 salvaged: verified (typecheck + 41 targeted tests) and landed as 2e82aa4.
- 2026-07-15T04:47:40Z — final gate found a real bug: SSE streams leak sockets into bfcache on full navigations; per-origin pool exhaustion wedged the next page load (e2e smoke flake was the symptom). Fixed as step 1.5 (d6e6bbb), reproduced + re-verified outside the suite.
- 2026-07-15T04:48:00Z — run end (R4, resumed): 5/5 steps done, final gate green (typecheck · build · 1475/1475 unit · 103/103 e2e). Note: the 02:35 "run end" entry above was premature — that session died before committing.
