# Execution plan — GitHub comment counts + threads (#499)

Source doc: `.ai/specs/2026-07-18-github-comment-threads.md`
Tracking issue: #499
Branch: `cez/d59e473a`

## Progress

### Phase 1 — counts + icons
- [x] 1. `github.ts`: `fetchCommentCounts` (GraphQL, zod, ≤10-page pagination) + merge into mappers. Unit tests. — 45c1c05
- [x] 2. `github.tsx`: `MessageSquareIcon` + count in `GithubRow`/`GithubDetail` meta. Component tests. — 45c1c05
- [x] 3. `mockGithub()` counts flow under `CEZ_DRY_RUN=1` (fixtures already carry counts). — 45c1c05

### Phase 2 — comment threads
- [x] 4. `types.ts`: `ForgeComment`/`ForgeCommentsData`. `github.ts`: `fetchGithubComments` (gh calls, zod, review filter, caps, 60s bounded LRU cache, mock). Unit tests.
- [x] 5. `server.ts`: `GET /api/github/comments/:kind/:number` (zod params, 400, refresh, degrade). Re-export via `github.ts`. Route test.
- [x] 6. `web/app/src/api/`: mirror types, `getGithubComments`, `useGithubComments` (staleTime 60s).
- [x] 7. `github.tsx`: `GithubThread` section (list, skeleton, error, review chips, shortAge). Component tests.

### Phase 3 — polish
- [x] 8. `github.tsx`: avatar + letter fallback; review-state chips; truncation row; image-bearing mock comment test.
- [x] 9. dry-run coverage: route test serves the mock thread (image + PR review) end-to-end via createApp+CEZ_DRY_RUN; component test asserts image renders `<img>` through Markdown. (Browser `test:e2e` is outside the validation gate + needs a browser provider — the jsdom component + server route tests cover the same path.)
- [ ] 10. Full gate + self-review + PR ready.

## PR
- PR: (pending)
