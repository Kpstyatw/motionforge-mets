import { describe, expect, it } from 'vitest'
import { ModuleData, TaskKind } from '@/types'
import { autoExpandParentTimes } from './parentTimeConstraint'

function node(
  id: string, kind: TaskKind, parentId: string | null,
  startMs: number, durationMs: number
): ModuleData {
  return {
    id, code: id, kind, parentId,
    moduleName: id, actionDescription: id, startMs, anchorMs: startMs, durationMs,
    endMs: startMs + durationMs, startMode: 'auto',
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 0
  }
}

describe('autoExpandParentTimes', () => {
  it('grows a parent action to contain an overrun sub-action', () => {
    // mechanism → action(0..100) → subaction(50..80 edited to 90..160)
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 100),
      { ...node('S', 'subaction', 'A', 50, 30), startMs: 90, anchorMs: 90, durationMs: 70, endMs: 160 }
    ]
    const { modules: out, changes } = autoExpandParentTimes(modules, 'S', 1)
    const a = out.find(m => m.id === 'A')!
    expect(a.startMs).toBe(0)
    expect(a.durationMs).toBe(160)
    expect(changes.some(c => c.id === 'A' && c.newEndMs === 160)).toBe(true)
    // physical nodes untouched
    expect(out.find(m => m.id === 'K')!.durationMs).toBe(0)
    expect(out.find(m => m.id === 'M')!.durationMs).toBe(0)
  })

  it('cascades expansion up the whole action → sub-action chain', () => {
    // action(0..100) → subaction(10..80) → sub-sub(20..50 edited to 120..200)
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 100),
      node('S1', 'subaction', 'A', 10, 70),
      { ...node('S2', 'subaction', 'S1', 20, 30), startMs: 120, anchorMs: 120, durationMs: 80, endMs: 200 }
    ]
    const { modules: out, changes } = autoExpandParentTimes(modules, 'S2', 1)
    expect(out.find(m => m.id === 'S1')!.durationMs).toBe(190) // 120..200 - 10
    expect(out.find(m => m.id === 'A')!.durationMs).toBe(200)  // 0..200
    expect(changes.map(c => c.id).sort()).toEqual(['A', 'S1'])
  })

  it('extends the start earlier when a sub-action begins before its parent', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 100, 100), // 100..200
      { ...node('S', 'subaction', 'A', 100, 20), startMs: 40, anchorMs: 40, durationMs: 20, endMs: 60 }
    ]
    const { modules: out } = autoExpandParentTimes(modules, 'S', 1)
    const a = out.find(m => m.id === 'A')!
    expect(a.startMs).toBe(40)
    expect(a.anchorMs).toBe(40)
    expect(a.endMs).toBe(200)
  })

  it('does nothing when the sub-action is already inside the parent', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 100),
      { ...node('S', 'subaction', 'A', 10, 20), startMs: 20, anchorMs: 20, durationMs: 20, endMs: 40 }
    ]
    const { modules: out, changes } = autoExpandParentTimes(modules, 'S', 1)
    expect(changes).toHaveLength(0)
    expect(out).toBe(modules)
  })

  it('never edits a physical parent (module / mechanism)', () => {
    // a mechanism directly parents an action that overruns the mechanism's own span
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 50),
      { ...node('A', 'action', 'K', 10, 40), startMs: 10, anchorMs: 10, durationMs: 200, endMs: 210 }
    ]
    const { modules: out, changes } = autoExpandParentTimes(modules, 'A', 1)
    expect(out.find(m => m.id === 'K')!.durationMs).toBe(50)
    expect(changes.some(c => c.id === 'K')).toBe(false)
  })

  it('rounds out to the configured precision', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 100),
      { ...node('S', 'subaction', 'A', 50, 10), startMs: 50, anchorMs: 50, durationMs: 53.4, endMs: 103.4 }
    ]
    const { modules: out } = autoExpandParentTimes(modules, 'S', 10)
    const duration = out.find(m => m.id === 'A')!.durationMs ?? 0
    expect(duration % 10).toBe(0)
    expect(duration).toBeGreaterThanOrEqual(110)
  })
})
