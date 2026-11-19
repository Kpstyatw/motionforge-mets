import { describe, expect, it } from 'vitest'
import { useProjectStore } from './useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { ModuleData, TaskKind } from '@/types'

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

describe('hierarchy presentation', () => {
  it('renumbers loaded projects with parent-prefixed hierarchical codes', () => {
    const module = {
      ...mk('M', 0, 0), kind: 'module' as const, moduleName: '模块', actionDescription: '模块'
    }
    const mechanism = { ...mk('K', 0, 0), kind: 'mechanism' as const, parentId: 'M' }
    const action = { ...mk('A', 0, 100), parentId: 'K' }
    const sub = { ...mk('S', 0, 50), kind: 'subaction' as const, parentId: 'A' }
    load([module, mechanism, action, sub])

    const codes = Object.fromEntries(useProjectStore.getState().project!.modules.map(m => [m.id, m.code]))
    expect(codes).toEqual({ M: '01', K: '01.01', A: '01.01.01', S: '01.01.01.01' })
  })

  it('can edit one colour or apply it to the whole subtree', () => {
    const module = {
      ...mk('M', 0, 0), kind: 'module' as const, moduleName: '模块', actionDescription: '模块', color: '#111111'
    }
    const mechanism = { ...mk('K', 0, 0), kind: 'mechanism' as const, parentId: 'M', color: '#222222' }
    const action = { ...mk('A', 0, 100), parentId: 'K', color: '#333333' }
    load([module, mechanism, action])

    useProjectStore.getState().setTaskColor('K', '#ff0000')
    let modules = useProjectStore.getState().project!.modules
    expect(modules.find(m => m.id === 'K')!.color).toBe('#ff0000')
    expect(modules.find(m => m.id === 'A')!.color).toBe('#333333')

    useProjectStore.getState().setTaskColor('K', '#00ff00', true)
    modules = useProjectStore.getState().project!.modules
    expect(modules.find(m => m.id === 'K')!.color).toBe('#00ff00')
    expect(modules.find(m => m.id === 'A')!.color).toBe('#00ff00')
  })
})

describe('source file association for one-click save', () => {
  it('remembers the imported workbook and clears it only on a new project', () => {
    load([mk('A', 0, 100)])
    useProjectStore.getState().setSourceFile({ path: 'C:\\plan\\cycle.xlsx', name: 'cycle.xlsx', kind: 'xlsx' })
    expect(useProjectStore.getState().sourceFile?.path).toBe('C:\\plan\\cycle.xlsx')

    // Re-loading project data (as an Excel import does) must keep the path.
    load([mk('B', 0, 200)])
    expect(useProjectStore.getState().sourceFile?.name).toBe('cycle.xlsx')

    // Starting a brand-new project drops the stale association.
    useProjectStore.getState().createNewProject()
    expect(useProjectStore.getState().sourceFile).toBeNull()
  })
})

describe('unique module/mechanism/resource names', () => {
  const module = (id: string, name: string, kind: TaskKind = 'module'): ModuleData => ({
    ...mk(id, 0, 0), kind, moduleName: name, actionDescription: name
  })

  it('rejects a duplicate mechanism name and keeps the original value', () => {
    load([module('M', '进样模块'), module('K', '抓手', 'mechanism')])
    const ok = useProjectStore.getState().setTaskField('K', 'actionDescription', '进样模块')
    expect(ok).toBe(false)
    expect(useProjectStore.getState().project!.modules.find(m => m.id === 'K')!.actionDescription).toBe('抓手')
    expect(useProjectStore.getState().scheduleWarnings[0]).toContain('重复')
  })

  it('keeps moduleName and actionDescription in sync when renaming a summary node', () => {
    load([module('M', '进样模块')])
    expect(useProjectStore.getState().setTaskField('M', 'actionDescription', '加样模块')).toBe(true)
    const m = useProjectStore.getState().project!.modules.find(x => x.id === 'M')!
    expect(m.moduleName).toBe('加样模块')
    expect(m.actionDescription).toBe('加样模块')
  })

  it('refuses a second resource with the same name but allows blank auto-naming', () => {
    useProjectStore.getState().createNewProject()
    const first = useProjectStore.getState().addResource({ name: '管库抓手' })
    const duplicate = useProjectStore.getState().addResource({ name: ' 管库抓手 ' })
    useProjectStore.getState().addResource({})
    expect(first).toBeTruthy()
    expect(duplicate).toBe('')
    expect(useProjectStore.getState().project!.resources).toHaveLength(2)
    expect(useProjectStore.getState().project!.resources[1].name).toBe('新资源')

    const renamed = useProjectStore.getState().updateResource(first, { name: '新资源' })
    expect(renamed).toBe(false)
    expect(useProjectStore.getState().project!.resources[0].name).toBe('管库抓手')
    expect(useProjectStore.getState().project!.resources[1].name).toBe('新资源')
  })

  it('surfaces duplicates from an imported project as warnings', () => {
    load([module('K1', '抓手', 'mechanism'), module('K2', '抓手', 'mechanism')])
    expect(useProjectStore.getState().scheduleWarnings.some(w => w.includes('名称重复'))).toBe(true)
  })
})

describe('hierarchy parent selection', () => {
  const module = (id: string, name: string, kind: TaskKind, parentId: string | null = null): ModuleData => ({
    ...mk(id, 0, 100), kind, parentId, moduleName: name, actionDescription: name
  })

  it('reparents an action and refreshes its mechanism label', () => {
    load([
      module('M', '进样模块', 'module'),
      module('K1', '抓手一', 'mechanism', 'M'),
      module('K2', '抓手二', 'mechanism', 'M'),
      module('A', '抓取', 'action', 'K1')
    ])
    expect(useProjectStore.getState().setTaskParent('A', 'K2')).toBe(true)
    const modules = useProjectStore.getState().project!.modules
    expect(modules.find(m => m.id === 'A')!.parentId).toBe('K2')
    expect(modules.find(m => m.id === 'A')!.moduleName).toBe('抓手二')
  })

  it('allows a top-level module but rejects invalid or cyclic parents', () => {
    load([
      module('M', '整机', 'module'),
      module('K', '抓手', 'mechanism', 'M'),
      module('A', '抓取', 'action', 'K'),
      module('S', '子动作', 'subaction', 'A')
    ])
    const store = useProjectStore.getState()
    expect(store.setTaskParent('M', null)).toBe(true)
    expect(store.setTaskParent('K', 'A')).toBe(false)
    expect(store.setTaskParent('M', 'K')).toBe(false)
    expect(store.setTaskParent('A', 'S')).toBe(false)
    expect(useProjectStore.getState().project!.modules.find(m => m.id === 'A')!.parentId).toBe('K')
  })
})
