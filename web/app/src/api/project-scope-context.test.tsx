import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectScopeProvider, useProjectScope } from './project-scope-context'
import { getApiScope, queryScope, scopeApiPath, setApiScope } from './project-scope'

afterEach(() => {
  cleanup()
  setApiScope(null)
})

/** Reads everything a scoped child would: the context AND the module seam, during render —
 *  exactly when queries.ts computes keys and client calls fire from event handlers. */
function Probe() {
  const { projectId, apiBase } = useProjectScope()
  return (
    <output data-testid="probe">
      {`${projectId ?? '-'}|${apiBase}|${queryScope()}|${scopeApiPath('/api/runs')}`}
    </output>
  )
}

describe('ProjectScopeProvider', () => {
  it('defaults to unscoped outside any provider — the pre-3.2 app, byte-identical', () => {
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('-|/api|default|/api/runs')
  })

  it('scopes both the context and the module seam before the children render', () => {
    const view = render(
      <ProjectScopeProvider projectId="cezar">
        <Probe />
      </ProjectScopeProvider>,
    )
    // The probe read scopeApiPath/queryScope during ITS render — if the provider had waited
    // for an effect, the first paint would have fetched and cached under the wrong scope.
    expect(view.getByTestId('probe').textContent).toBe('cezar|/api/p/cezar|cezar|/api/p/cezar/runs')
    expect(getApiScope()).toBe('cezar')
  })

  it('follows a projectId change and resets to unscoped on unmount', () => {
    const view = render(
      <ProjectScopeProvider projectId="a">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(getApiScope()).toBe('a')

    view.rerender(
      <ProjectScopeProvider projectId="b">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('b|/api/p/b|b|/api/p/b/runs')

    view.unmount()
    expect(getApiScope()).toBeNull()
  })

  it('passes null through as the unscoped boot project', () => {
    const view = render(
      <ProjectScopeProvider projectId={null}>
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('-|/api|default|/api/runs')
  })
})
