import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  keyboardInset,
  watchKeyboardInset,
  type KeyboardViewport,
  type KeyboardWindow,
} from './keyboard-inset'

/** A drivable visualViewport: tests resize it and fire the listeners, like Safari does. */
class StubViewport implements KeyboardViewport {
  listeners = new Map<'resize' | 'scroll', Set<() => void>>()
  constructor(
    public height: number,
    public offsetTop = 0,
  ) {}
  addEventListener(type: 'resize' | 'scroll', listener: () => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: 'resize' | 'scroll', listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: 'resize' | 'scroll') {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

const win = (viewport: KeyboardViewport | null, innerHeight = 800): KeyboardWindow => ({
  innerHeight,
  visualViewport: viewport,
})

describe('keyboardInset — the --kb math', () => {
  it.each([
    // [innerHeight, vv.height, vv.offsetTop, expected]
    [800, 800, 0, 0], // keyboard closed
    [800, 460, 0, 340], // iOS keyboard open, viewport not panned
    [800, 460, 100, 240], // panned down: the pan eats into the overlap
    [800, 810, 0, 0], // URL-bar collapse makes vv taller — NOT a keyboard, clamped
    [800, 799.4, 0, 1], // fractional Safari values round, not truncate
  ])('inner %d, vv %d @ %d → %d', (innerHeight, height, offsetTop, expected) => {
    expect(keyboardInset(win(new StubViewport(height, offsetTop), innerHeight))).toBe(expected)
  })

  it('is 0 without a visualViewport (older engines)', () => {
    expect(keyboardInset(win(null))).toBe(0)
  })
})

describe('watchKeyboardInset — the stubbed adapter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies on install, tracks every viewport event, settles once after the burst', () => {
    const viewport = new StubViewport(800)
    const applied: number[] = []
    const settled: number[] = []
    watchKeyboardInset(win(viewport), (px) => applied.push(px), (px) => settled.push(px), 250)

    expect(applied).toEqual([0]) // the install-time apply

    // Safari streams resize events through the keyboard animation.
    viewport.height = 700
    viewport.fire('resize')
    viewport.height = 540
    viewport.fire('resize')
    viewport.height = 460
    viewport.fire('resize')
    expect(applied).toEqual([0, 100, 260, 340]) // the composer tracked the animation…

    expect(settled).toEqual([]) // …but nothing settled yet
    vi.advanceTimersByTime(249)
    expect(settled).toEqual([])
    vi.advanceTimersByTime(1)
    expect(settled).toEqual([340]) // one settle, at the final inset, after the debounce
  })

  it('viewport pans (scroll events) re-derive the inset too', () => {
    const viewport = new StubViewport(460)
    const applied: number[] = []
    watchKeyboardInset(win(viewport), (px) => applied.push(px))
    viewport.offsetTop = 120
    viewport.fire('scroll')
    expect(applied).toEqual([340, 220])
  })

  it('cleanup removes the listeners, cancels the pending settle, and resets to 0', () => {
    const viewport = new StubViewport(800)
    const applied: number[] = []
    const settled: number[] = []
    const stop = watchKeyboardInset(win(viewport), (px) => applied.push(px), (px) => settled.push(px))

    viewport.height = 460
    viewport.fire('resize')
    stop()

    expect(applied).toEqual([0, 340, 0]) // the reset — a stale --kb must not outlive the view
    vi.runAllTimers()
    expect(settled).toEqual([]) // the in-flight settle died with the watcher
    viewport.fire('resize')
    expect(applied).toEqual([0, 340, 0]) // detached
  })

  it('degrades to a no-op apply(0) without a visualViewport', () => {
    const applied: number[] = []
    const stop = watchKeyboardInset(win(null), (px) => applied.push(px))
    expect(applied).toEqual([0])
    stop() // must not throw
  })
})
