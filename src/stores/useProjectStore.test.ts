import { describe, expect, it } from 'vitest'
import { useProjectStore } from './useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { ModuleData, TaskKind } from '@/types'
import { buildResourceOwnerIndex } from '@/lib/resourceTree'

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

describe('parent action auto-expands to contain sub-action timing', () => {
  const module = (id: string, kind: TaskKind, parentId: string | null, start: number, dur: number): ModuleData => ({
    ...mk(id, start, dur), kind, parentId
  })

  it('grows the parent action after a sub-action is pushed past its end', () => {
    load([
      module('M', 'module', null, 0, 0),
      module('K', 'mechanism', 'M', 0, 0),
      module('A', 'action', 'K', 0, 100),
      module('S', 'subaction', 'A', 10, 20)
    ])
    // Child-driven: the container already mirrors its child's window.
    expect(schedule().byId['A'].startMs).toBe(10)
    expect(schedule().byId['A'].endMs).toBe(30)

    // Push sub-action to 150..250; the container follows automatically.
    const changes = useProjectStore.getState().setTaskTiming('S', { startMs: 150, durationMs: 100 })

    const s = schedule()
    expect(s.byId['S'].startMs).toBe(150)
    expect(s.byId['S'].endMs).toBe(250)
    expect(s.byId['A'].startMs).toBe(150)
    expect(s.byId['A'].endMs).toBe(250)
    expect(changes.some(c => c.id === 'A')).toBe(true)
  })

  it('reports no manual expansion when the parent is a physical mechanism', () => {
    load([
      module('M', 'module', null, 0, 0),
      module('K', 'mechanism', 'M', 0, 50),
      module('A', 'action', 'K', 0, 40)
    ])
    const changes = useProjectStore.getState().setTaskTiming('A', { durationMs: 200 })
    // The engine must not emit a manual change for a physical parent.
    // (The mechanism's own duration still rolls up via the scheduler — that
    // is existing auto-summary behaviour, deliberately left intact.)
    expect(changes.some(c => c.id === 'K' || c.id === 'M')).toBe(false)
    expect(useProjectStore.getState().project!.modules.find(m => m.id === 'A')!.durationMs).toBe(200)
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

describe('setResourceOwner — reverse ownership from the resource side', () => {
  function loadWithMechanisms() {
    useProjectStore.getState().loadProject({
      name: 't',
      modules: [
        { ...mk('M1', 0, 0), kind: 'module' as TaskKind, moduleName: '进样', actionDescription: '进样' },
        { ...mk('MECH1', 0, 0), kind: 'mechanism' as TaskKind, parentId: 'M1', moduleName: '取血针', actionDescription: '取血针' },
        { ...mk('MECH2', 0, 0), kind: 'mechanism' as TaskKind, parentId: 'M1', moduleName: '前处理盘', actionDescription: '前处理盘' },
      ],
      resources: [{ id: 'R1', name: '取血针Y轴电机', type: 'motor' }],
      timeConfig: { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }
    } as never)
  }

  const ownersNow = () => {
    const p = useProjectStore.getState().project!
    return buildResourceOwnerIndex(p.modules, p.resources)
  }

  it('binds a resource to a mechanism so the owner index finds module/mechanism', () => {
    loadWithMechanisms()
    useProjectStore.getState().setResourceOwner('R1', 'MECH1')
    expect(ownersNow().get('R1')?.mechanismId).toBe('MECH1')
    expect(ownersNow().get('R1')?.moduleName).toBe('进样')
    expect(ownersNow().get('R1')?.mechanismName).toBe('取血针')
    expect(useProjectStore.getState().project!.resources[0].ownerNodeId).toBe('MECH1')
  })

  it('moves one resource 1:1 — rebinding clears its previous mechanism', () => {
    loadWithMechanisms()
    const s = useProjectStore.getState()
    s.setResourceOwner('R1', 'MECH1')
    s.setResourceOwner('R1', 'MECH2')
    const owners = ownersNow()
    expect(owners.size).toBe(1)
    expect(owners.get('R1')?.mechanismId).toBe('MECH2')
    expect(useProjectStore.getState().project!.resources[0].ownerNodeId).toBe('MECH2')
  })

  it('lets ONE mechanism own SEVERAL resources without mutual exclusion', () => {
    loadWithMechanisms()
    const s = useProjectStore.getState()
    // Add a second resource, then assign both to the SAME mechanism.
    const r2 = s.addResource({ name: '取样针电机' })
    expect(r2).toBeTruthy()
    s.setResourceOwner('R1', 'MECH1')
    s.setResourceOwner(r2, 'MECH1')
    const p = useProjectStore.getState().project!
    expect(p.resources.find(r => r.id === 'R1')!.ownerNodeId).toBe('MECH1')
    expect(p.resources.find(r => r.id === r2)!.ownerNodeId).toBe('MECH1')
    const owners = buildResourceOwnerIndex(p.modules, p.resources)
    expect(owners.get('R1')?.mechanismId).toBe('MECH1')
    expect(owners.get(r2)?.mechanismId).toBe('MECH1')
    expect(owners.size).toBe(2)
  })

  it('unbinds with null', () => {
    loadWithMechanisms()
    const s = useProjectStore.getState()
    s.setResourceOwner('R1', 'MECH1')
    s.setResourceOwner('R1', null)
    expect(ownersNow().has('R1')).toBe(false)
  })

  it('allows a module (not just a mechanism) as the owner', () => {
    loadWithMechanisms()
    useProjectStore.getState().setResourceOwner('R1', 'M1')
    expect(ownersNow().get('R1')?.moduleId).toBe('M1')
    expect(ownersNow().get('R1')?.mechanismId).toBe('')
  })

  it('addAction creates a node in the flow tree that can own a resource', () => {
    loadWithMechanisms()
    const s = useProjectStore.getState()
    const newId = s.addAction({ kind: 'mechanism', parentId: 'M1', moduleName: '加样针', actionDescription: '加样针' })
    expect(newId).toBeTruthy()
    useProjectStore.getState().setResourceOwner('R1', newId!)
    const p = useProjectStore.getState().project!
    expect(p.modules.some(m => m.id === newId && m.kind === 'mechanism' && m.parentId === 'M1')).toBe(true)
    expect(buildResourceOwnerIndex(p.modules, p.resources).get('R1')?.mechanismName).toBe('加样针')
  })
})

describe('event-bound allocations', () => {
  function loadWithResource() {
    useProjectStore.getState().loadProject({
      name: 't', modules: [mk('A', 1000, 500), mk('B', 5000, 500), mk('C', 8000, 500)],
      resources: [{ id: 'GRIP', name: '抓手' }],
      allocations: [],
      timeConfig: { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }
    } as never)
  }

  it('rejects a bound claim whose event actions do not exist', () => {
    loadWithResource()
    const id = useProjectStore.getState().addAllocation({
      taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 0,
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'start' },
      endRef: { taskId: 'MISSING', at: 'end' }
    })
    expect(id).toBeNull()
    expect(useProjectStore.getState().project!.allocations).toHaveLength(0)
  })

  it('persists a valid bound claim and drops it when a referenced action is deleted', () => {
    loadWithResource()
    const id = useProjectStore.getState().addAllocation({
      taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 0,
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'start', offsetMs: 10 },
      endRef: { taskId: 'C', at: 'end', offsetMs: -5 }
    })
    expect(id).toBeTruthy()
    let a = useProjectStore.getState().project!.allocations[0]
    expect(a.bindMode).toBe('event')
    expect(a.startRef).toEqual({ taskId: 'A', at: 'start', offsetMs: 10 })
    expect(a.endRef).toEqual({ taskId: 'C', at: 'end', offsetMs: -5 })

    // Deleting the release action removes the now-unplaceable claim.
    useProjectStore.getState().deleteTask('C')
    expect(useProjectStore.getState().project!.allocations).toHaveLength(0)
  })

  it('keeps a bound claim when an unrelated action is deleted', () => {
    loadWithResource()
    useProjectStore.getState().addAllocation({
      taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 0,
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'start' },
      endRef: { taskId: 'C', at: 'end' }
    })
    useProjectStore.getState().deleteTask('B')
    expect(useProjectStore.getState().project!.allocations).toHaveLength(1)
  })
})

describe('child-driven time model', () => {
  function tree(withLegacyDep = false): ModuleData[] {
    const a = mk('A', 1000, 800)
    const s = {
      ...mk('S', 1200, 300, withLegacyDep
        ? [{ id: 'legacy', fromId: 'A', type: 'FS', lagMs: 0 }]
        : []),
      kind: 'subaction' as TaskKind, parentId: 'A'
    }
    return [a, s]
  }

  it('migrates a legacy offset sub-action to absolute time and drops its ancestor dependency', () => {
    // Old v1.1.x file: offset 200 from parent start 1000, stored absolute 1200.
    const legacy = [mk('A', 1000, 800), {
      ...mk('S', 1200, 300, [{ id: 'legacy', fromId: 'A', type: 'FS' as const, lagMs: 0 }]),
      kind: 'subaction' as TaskKind, parentId: 'A', offsetFromParentMs: 200
    }]
    load(legacy)
    const p = useProjectStore.getState().project!
    const s = p.modules.find(m => m.id === 'S')!
    expect(s.offsetFromParentMs).toBeUndefined() // offset is no longer a source of truth
    expect(s.startMs).toBe(1200) // absolute position preserved
    expect(s.predecessors ?? []).toHaveLength(0) // legacy FS-to-parent removed
    expect(schedule().byId.S.startMs).toBe(1200)
  })

  it('edits a sub-action start as an absolute clock', () => {
    load(tree())
    useProjectStore.getState().setTaskTiming('S', { startMs: 1500 })
    expect(schedule().byId.S.startMs).toBe(1500)
  })

  it('rolls the parent action up to the sub-tree bounds when a child is edited', () => {
    load(tree())
    expect(schedule().byId.A.startMs).toBe(1200) // A starts at earliest child
    expect(schedule().byId.A.endMs).toBe(1500)   // A ends at latest child
    useProjectStore.getState().setTaskTiming('S', { durationMs: 2000 })
    const s = schedule()
    expect(s.byId.S.endMs).toBe(3200)
    expect(s.byId.A.endMs).toBe(3200) // parent follows automatically
  })

  it('ignores writes to a container action so it stays child-driven', () => {
    load(tree())
    useProjectStore.getState().setTaskTiming('A', { startMs: 5000 })
    expect(schedule().byId.A.startMs).toBe(1200) // unchanged; child is the source
  })

  it('shifts the whole sub-tree as one when a predecessor requires a later start', () => {
    // Child at 700; predecessor ends at 2000 → the sub-tree must move +1300.
    const mods = [
      mk('T', 0, 2000),
      { ...mk('A', 600, 300, [{ id: 'd', fromId: 'T', type: 'FS' as const, lagMs: 0 }]) },
      { ...mk('S', 700, 300), kind: 'subaction' as TaskKind, parentId: 'A' }
    ]
    load(mods)
    const s = schedule()
    expect(s.byId.A.startMs).toBe(2000) // rolled-up earliest child = constraint
    expect(s.byId.S.startMs).toBe(2000) // child shifted by the same delta
  })

  it('keeps child times when the predecessor is already satisfied', () => {
    const mods = [
      mk('T', 0, 400),
      { ...mk('A', 1000, 800, [{ id: 'd', fromId: 'T', type: 'FS' as const, lagMs: 0 }]) },
      { ...mk('S', 1200, 300), kind: 'subaction' as TaskKind, parentId: 'A' }
    ]
    load(mods)
    const s = schedule()
    expect(s.byId.A.startMs).toBe(1200) // child is source of truth, not the authored 1000
    expect(s.byId.S.startMs).toBe(1200)
  })
})

describe('addAction child-driven timing', () => {
  const base = () => [mk('A', 1000, 800)]
  it('stores an absolute start for a new sub-action', () => {
    load(base())
    const id = useProjectStore.getState().addAction({
      kind: 'subaction', parentId: 'A', actionDescription: '新子动作', durationMs: 100, startMs: 5000
    })
    expect(id).toBeTruthy()
    const node = useProjectStore.getState().project!.modules.find(m => m.id === id)!
    expect(node.startMs).toBe(5000)
    expect(schedule().byId[id!].startMs).toBe(5000)
  })

  it('defaults a new sub-action to the parent start, not its end', () => {
    load(base())
    const id = useProjectStore.getState().addAction({ kind: 'subaction', parentId: 'A' })!
    expect(schedule().byId[id].startMs).toBe(1000)
    expect(schedule().byId[id].startMode).toBe('auto')
  })

  it('defaults a new action to start 0 even when its parent starts later', () => {
    // A mechanism that rolls up to 1000; a new action under it still starts at 0.
    load([mk('Mech', 1000, 800), { ...mk('A', 1000, 800), parentId: 'Mech' }])
    const id = useProjectStore.getState().addAction({ kind: 'action', parentId: 'Mech' })!
    const node = useProjectStore.getState().project!.modules.find(m => m.id === id)!
    expect(node.startMs).toBe(0)
    expect(schedule().byId[id].startMs).toBe(0)
  })

  it('holds the default time until a predecessor is added, then follows the dependency', () => {
    load([mk('Seed', 0, 1000), mk('A', 1000, 800)])
    const id = useProjectStore.getState().addAction({ kind: 'action' })!
    expect(schedule().byId[id].startMs).toBe(0) // no predecessor -> anchor holds

    useProjectStore.getState().addPredecessor(id, 'Seed', 'FS', 0)
    const s = schedule()
    expect(s.byId[id].startMode).toBe('auto')
    expect(s.byId[id].startMs).toBe(1000) // predecessor end takes over
  })
})

describe('leaf-to-container transition', () => {
  it('an action is editable while childless, then becomes rolled-up once a child is added', () => {
    load([mk('A', 1000, 800)])
    // Childless: a timing edit takes effect directly.
    useProjectStore.getState().setTaskTiming('A', { startMs: 2000 })
    expect(schedule().byId.A.startMs).toBe(2000)

    // Add a child at an absolute time; the parent now mirrors the child.
    useProjectStore.getState().addAction({ kind: 'subaction', parentId: 'A', startMs: 3000, durationMs: 100 })
    expect(schedule().byId.A.startMs).toBe(3000)
    expect(schedule().byId.A.endMs).toBe(3100)

    // Further edits to the action itself are ignored (child-driven).
    useProjectStore.getState().setTaskTiming('A', { startMs: 9000 })
    expect(schedule().byId.A.startMs).toBe(3000)
  })

  it('editing the child refreshes the container after the transition', () => {
    load([mk('A', 1000, 800)])
    const childId = useProjectStore.getState().addAction({ kind: 'subaction', parentId: 'A', startMs: 3000, durationMs: 100 })!
    expect(schedule().byId.A.startMs).toBe(3000)
    useProjectStore.getState().setTaskTiming(childId, { startMs: 5000, durationMs: 200 })
    const s = schedule()
    expect(s.byId[childId].startMs).toBe(5000)
    expect(s.byId.A.startMs).toBe(5000)
    expect(s.byId.A.endMs).toBe(5200)
  })
})

describe('hierarchy-crossing predecessor guards', () => {
  const tree = () => [
    mk('A', 1000, 800),
    { ...mk('S', 1200, 300), kind: 'subaction' as TaskKind, parentId: 'A' },
    mk('X', 200, 100)
  ]

  it('rejects making a child depend on its own ancestor action', () => {
    load(tree())
    const s = useProjectStore.getState()
    expect(s.addPredecessor('S', 'A')).toBe(false)
    expect(schedule().byId.S.predecessorIds).toHaveLength(0)
    expect(useProjectStore.getState().scheduleWarnings.join('')).toContain('上下级')
  })

  it('rejects making an ancestor action depend on its own child', () => {
    load(tree())
    const s = useProjectStore.getState()
    expect(s.addPredecessor('A', 'S')).toBe(false)
    expect(schedule().byId.A.predecessorIds).toHaveLength(0)
  })

  it('allows a normal cross-action dependency', () => {
    load(tree())
    expect(useProjectStore.getState().addPredecessor('X', 'A')).toBe(true)
    expect(schedule().byId.X.predecessorIds).toContain('A')
  })

  it('migration drops an existing hierarchy-crossing dependency', () => {
    load([
      mk('A', 1000, 800, [{ id: 'bad', fromId: 'S', type: 'FS', lagMs: 0 }]),
      { ...mk('S', 1200, 300), kind: 'subaction' as TaskKind, parentId: 'A' }
    ])
    expect(schedule().byId.A.predecessorIds).toHaveLength(0)
  })
})
