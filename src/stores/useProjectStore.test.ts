import { describe, expect, it } from 'vitest'
import { useProjectStore } from './useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { ModuleData } from '@/types'

const cfg = normalizeTimeConfig({ scaleMs: 100, precisionMs: 1 })

function mk(
  id: string,
  start: number,
  dur: number,
  preds: Array<{ id: string; fromId: string; type: string; lagMs: number }> = [],
  mode: 'auto' | 'manual' = 'auto'
): ModuleData {
  return {
    id, code: id, kind: 'action', parentId: null, moduleName: '机构', actionDescription: id,
    startMs: start, anchorMs: start, durationMs: dur, endMs: start + dur, startMode: mode,
    predecessors: preds, startX: 0, calculatedStartX: 0, moveCount: 0, duration: 100,
    isSequentialAction: false
  } as ModuleData
}

function schedule() {
  return computeSchedule(useProjectStore.getState().project!.modules, cfg)
}

function load(modules: ModuleData[]) {
  useProjectStore.getState().loadProject({
    name: 't', modules,
    timeConfig: { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }
  } as never)
}

/**
 * Regression: selecting / editing a predecessor must actually move the
 * successor's start time. A task that had been pinned to manual (which happens
 * implicitly when its start time was edited) used to swallow every dependency
 * change, so the edit looked like it "did nothing".
 */
describe('predecessor edits drive successor start', () => {
  it('adding a predecessor restores auto-follow and snaps start to predecessor end', () => {
    load([mk('A', 0, 500), mk('B', 3000, 50, [], 'manual')])
    expect(schedule().byId['B'].startMs).toBe(3000)

    useProjectStore.getState().addPredecessor('B', 'A', 'FS', 0)

    const s = schedule()
    expect(s.byId['B'].startMode).toBe('auto')
    expect(s.byId['B'].startMs).toBe(s.byId['A'].endMs) // 500
  })

  it('editing a predecessor type/lag restores auto-follow and re-times the successor', () => {
    load([mk('A', 0, 100), mk('B', 3000, 50, [{ id: 'd1', fromId: 'A', type: 'FS', lagMs: 0 }], 'manual')])

    useProjectStore.getState().updatePredecessor('B', 'd1', { lagMs: 800 })

    const s = schedule()
    expect(s.byId['B'].startMode).toBe('auto')
    expect(s.byId['B'].startMs).toBe(900) // A.end 100 + lag 800
  })

  it('an explicit start-time edit stays manual and is not overridden', () => {
    load([mk('A', 0, 100), mk('B', 3000, 50, [], 'manual')])

    useProjectStore.getState().setTaskTiming('B', { startMs: 5000 })

    const s = schedule()
    expect(s.byId['B'].startMode).toBe('manual')
    expect(s.byId['B'].startMs).toBe(5000)
  })

  it('editing the predecessor task duration cascades to an auto successor', () => {
    load([mk('A', 0, 100), mk('B', 300, 50, [{ id: 'd1', fromId: 'A', type: 'FS', lagMs: 0 }])])

    useProjectStore.getState().setTaskTiming('A', { durationMs: 700 })

    const s = schedule()
    expect(s.byId['B'].startMs).toBe(700)
  })
})
