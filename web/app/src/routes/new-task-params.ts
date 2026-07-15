/** The `/new` deep-link contract the saved bookmarklets rely on (spec 011,
 *  protected by BACKWARD_COMPATIBILITY.md): `?skill=&ref=&auto=1&key=`.
 *
 *  Parsing lives apart from the component so it stays table-testable and so the
 *  real composer (Step R4) can consume the same shape without re-deriving it.
 *  Kept byte-for-byte compatible with `initFromQuery()` in web/app.js: `ref`
 *  falls back to the older `task` spelling, `auto` is the exact string `1`.
 */
export interface NewTaskParams {
  skill: string
  ref: string
  auto: boolean
  key: string
}

export function parseNewTaskParams(search: string | URLSearchParams): NewTaskParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return {
    skill: (params.get('skill') ?? '').trim(),
    ref: (params.get('ref') ?? params.get('task') ?? '').trim(),
    auto: params.get('auto') === '1',
    key: params.get('key') ?? '',
  }
}
