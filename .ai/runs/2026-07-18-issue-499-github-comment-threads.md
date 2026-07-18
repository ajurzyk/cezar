# Execution plan — GitHub comment counts + threads (#499)

Source doc: `.ai/specs/2026-07-18-github-comment-threads.md`
Tracking issue: #499
Branch: `cez/d59e473a`

## Progress

### Phase 1 — counts + icons
- [ ] 1. `github.ts`: `fetchCommentCounts` (GraphQL, zod, ≤10-page pagination) as 4th `Promise.all` entry in `fetchGithub`; degrade-to-empty on failure; merge into issue/PR mappers (replace `comments: 0`). Unit tests.
- [ ] 2. `github.tsx`: `MessageSquareIcon` + count in `GithubRow` meta (only when `> 0`) and `GithubDetail` meta. Component tests.
- [ ] 3. Verify `mockGithub()` counts flow under `CEZ_DRY_RUN=1`.

### Phase 2 — comment threads
- [ ] 4. `types.ts`: `ForgeComment`/`ForgeCommentsData`. `github.ts`: `fetchGithubComments` (gh calls, zod, review filter, caps, 60s LRU cache, mock). Unit tests.
- [ ] 5. `server.ts`: `GET /api/github/comments/:kind/:number` (zod params, 400, refresh, degrade). Re-export via `github.ts`. Route test.
- [ ] 6. `web/app/src/api/`: mirror types, `getGithubComments`, `useGithubComments`.
- [ ] 7. `github.tsx`: `GithubThread` section (list, skeleton, error, review chips, shortAge). Component tests.

### Phase 3 — polish
- [ ] 8. `github.tsx`: avatar + letter fallback; review-state chips; truncation row; image-bearing mock comment test.
- [ ] 9. e2e: extend dry-run smoke (thread badge → entries → image).
- [ ] 10. Full gate + self-review + PR ready.

## PR
- PR: (pending)
