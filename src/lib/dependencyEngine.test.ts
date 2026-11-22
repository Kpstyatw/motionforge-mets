import { describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { ModuleData, TaskKind, TimeConfig } from '@/types'
import {
  collectDescendantIds, computeSchedule, flattenTree, hierarchyPath,
  renumberHierarchyCodes, resolvePredecessorLeaf, syncLegacyFields,
  wouldCreateCycle, wouldCreateHierarchyConflict
} from './dependencyEngine'
import { DEFAULT_TIME_CONFIG, normalizeTimeConfig, parseTimeInput, quantize } from './timeScale'
import { computeTotalDurationMs } from './timingModel'

const CONFIG: TimeConfig = { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }

let seq = 0
function task(
  partial: Partial<ModuleData> & { startMs?: number; durationMs?: number },
  kind: TaskKind = 'action'
): ModuleData {
  seq += 1
  const startMs = partial.startMs ?? 0
  const durationMs = partial.durationMs ?? 100
  return {
    id: partial.id ?? `id-${seq}`,
    code: partial.code ?? `T${String(seq).padStart(2, '0')}`,
    kind,
    parentId: partial.parentId ?? null,
    moduleName: partial.moduleName ?? '机构 A',
    actionDescription: partial.actionDescription ?? `动作 ${seq}`,
    startMs,
    durationMs,
    endMs: startMs + durationMs,
    startMode: partial.startMode ?? 'auto',
    predecessors: partial.predecessors ?? [],
    startX: startMs / CONFIG.scaleMs,
    calculatedStartX: startMs / CONFIG.scaleMs,
    moveCount: durationMs / CONFIG.scaleMs,
    duration: CONFIG.scaleMs,
    isSequentialAction: false
  }
}

function dep(fromId: string, type: 'FS' | 'SS' | 'FF' | 'SF' = 'FS', lagMs = 0) {
  return { id: uuidv4(), fromId, type, lagMs }
}

/** Simulate a store mutation: resolve the schedule, write it back, re-resolve. */
function resolve(modules: ModuleData[], config: TimeConfig = CONFIG): ModuleData[] {
  const schedule = computeSchedule(modules, config)
  return syncLegacyFields(modules, schedule, config)
}

describe('time scale & precision', () => {
  it('keeps every canonical value an integer millisecond, down to 1 ms', () => {
    const config = normalizeTimeConfig({ scaleMs: 1, precisionMs: 1 })
    const modules = resolve([
      task({ startMs: 0, durationMs: 1 }),
      task({ durationMs: 3, predecessors: [dep('id-A')] })
    ].map((m, i) => i === 0 ? { ...m, id: 'id-A' } : m), config)
    const schedule = computeSchedule(modules, config)
    expect(schedule.byId['id-A'].startMs).toBe(0)
    expect(schedule.byId['id-A'].endMs).toBe(1)
    expect(schedule.tasks[1].startMs).toBe(1)
    expect(schedule.tasks[1].endMs).toBe(4)
    expect(schedule.totalMs).toBe(4)
    expect(schedule.tasks.every(t => Number.isInteger(t.startMs) && Number.isInteger(t.endMs))).toBe(true)
  })

  it('snaps to the configured precision and never lets scale be finer than precision', () => {
    expect(quantize(1234, 5, 'ceil')).toBe(1235)
    expect(quantize(1234, 5, 'floor')).toBe(1230)
    const cfg = normalizeTimeConfig({ scaleMs: 1, precisionMs: 10 })
    expect(cfg.scaleMs).toBe(10)
  })

  it('parses ms / s / min:sec input', () => {
    expect(parseTimeInput('1234')).toBe(1234)
    expect(parseTimeInput('1234ms')).toBe(1234)
    expect(parseTimeInput('1.234s')).toBe(1234)
    expect(parseTimeInput('01:23.456')).toBe(83456)
    expect(parseTimeInput('nonsense')).toBeNull()
  })
})

describe('dependency cascade', () => {
  it('FS: changing a predecessor duration shifts the whole successor chain', () => {
    const a = { ...task({ startMs: 0, durationMs: 1000 }), id: 'A' }
    const b = { ...task({ durationMs: 500, predecessors: [dep('A')] }), id: 'B' }
    const c = { ...task({ durationMs: 200, predecessors: [dep('B')] }), id: 'C' }
    let modules = resolve([a, b, c])
    let schedule = computeSchedule(modules, CONFIG)
    expect([schedule.byId.A.startMs, schedule.byId.B.startMs, schedule.byId.C.startMs]).toEqual([0, 1000, 1500])

    // A runs 250 ms longer -> B and C both move, by exactly 250 ms.
    modules = resolve(modules.map(m => m.id === 'A' ? { ...m, durationMs: 1250 } : m))
    schedule = computeSchedule(modules, CONFIG)
    expect([schedule.byId.B.startMs, schedule.byId.C.startMs]).toEqual([1250, 1750])
    expect(schedule.totalMs).toBe(1950)
  })

  it('changing a predecessor start cascades downstream', () => {
    const a = { ...task({ startMs: 100, durationMs: 300 }), id: 'A' }
    const b = { ...task({ durationMs: 100, predecessors: [dep('A')] }), id: 'B' }
    let modules = resolve([a, b])
    modules = resolve(modules.map(m => m.id === 'A' ? { ...m, startMs: 900, anchorMs: 900 } : m))
    expect(computeSchedule(modules, CONFIG).byId.B.startMs).toBe(1200)
  })

  it('editing the end time changes duration and therefore every successor', () => {
    const a = { ...task({ startMs: 200, durationMs: 300 }), id: 'A' }
    const b = { ...task({ durationMs: 100, predecessors: [dep('A')] }), id: 'B' }
    let modules = resolve([a, b])
    expect(computeSchedule(modules, CONFIG).byId.B.startMs).toBe(500)
    // End moved from 500 to 1750 => duration 1550.
    modules = resolve(modules.map(m => m.id === 'A' ? { ...m, durationMs: 1750 - 200 } : m))
    expect(computeSchedule(modules, CONFIG).byId.B.startMs).toBe(1750)
  })

  it('takes the max of multiple predecessors, with lag and SS/FF/SF relations', () => {
    const a = { ...task({ startMs: 0, durationMs: 1000 }), id: 'A' }
    const b = { ...task({ startMs: 100, durationMs: 200 }), id: 'B' }
    const c = {
      ...task({
        durationMs: 300,
        predecessors: [dep('A', 'FS', 50), dep('B', 'SS', 900)]
      }),
      id: 'C'
    }
    const schedule = computeSchedule(resolve([a, b, c]), CONFIG)
    // A end + 50 = 1050 ; B start + 900 = 1000 => 1050 wins.
    expect(schedule.byId.C.startMs).toBe(1050)

    const ff = { ...task({ durationMs: 300, predecessors: [dep('A', 'FF', 0)] }), id: 'FF' }
    const sf = { ...task({ durationMs: 300, predecessors: [dep('A', 'SF', 0)] }), id: 'SF' }
    const s2 = computeSchedule(resolve([a, ff, sf]), CONFIG)
    expect(s2.byId.FF.startMs).toBe(700)   // 1000 - 300
    expect(s2.byId.SF.startMs).toBe(0)     // 0 - 300 clamped
  })

  it('adding / editing / removing a predecessor re-schedules immediately', () => {
    const a = { ...task({ startMs: 0, durationMs: 800 }), id: 'A' }
    let b = { ...task({ startMs: 0, durationMs: 100 }), id: 'B' }
    let modules = resolve([a, b])
    // add
    modules = resolve(modules.map(m => m.id === 'B' ? { ...m, predecessors: [dep('A')] } : m))
    expect(computeSchedule(modules, CONFIG).byId.B.startMs).toBe(800)
    // edit lag
    modules = resolve(modules.map(m => m.id === 'B'
      ? { ...m, predecessors: [{ ...m.predecessors![0], lagMs: 125 }] } : m))
    expect(computeSchedule(modules, CONFIG).byId.B.startMs).toBe(925)
    // remove -> back to its own anchor
    modules = resolve(modules.map(m => m.id === 'B' ? { ...m, predecessors: [] } : m))
    expect(computeSchedule(modules, CONFIG).byId.B.startMs).toBe(0)
    void b
  })

  it('rejects edges that would create a cycle', () => {
    const a = { ...task({ startMs: 0, durationMs: 100, predecessors: [dep('B')] }), id: 'A' }
    const b = { ...task({ startMs: 0, durationMs: 100, predecessors: [] }), id: 'B' }
    expect(wouldCreateCycle([a, b], 'B', 'A')).toBe(true)
    expect(wouldCreateCycle([a, b], 'B', 'B')).toBe(true)
    expect(wouldCreateCycle([a, b], 'B', 'C')).toBe(false)
    const cyclic = computeSchedule([
      a,
      { ...b, predecessors: [dep('A')] }
    ], CONFIG)
    expect(cyclic.cycles.length).toBeGreaterThan(0)
    expect(cyclic.warnings.some(w => w.includes('循环'))).toBe(true)
  })

  it('pinned (manual) starts are still pushed when a dependency requires it', () => {
    const a = { ...task({ startMs: 0, durationMs: 1000 }), id: 'A' }
    const b = { ...task({ startMs: 100, durationMs: 100, startMode: 'manual', predecessors: [dep('A')] }), id: 'B' }
    const schedule = computeSchedule(resolve([a, b]), CONFIG)
    expect(schedule.byId.B.startMs).toBe(1000)
    expect(schedule.byId.B.clamped).toBe(true)
  })

  it('timing model total agrees with the scheduler', () => {
    const modules = resolve([
      { ...task({ startMs: 0, durationMs: 1200 }), id: 'A' },
      { ...task({ durationMs: 300, predecessors: [dep('A')] }), id: 'B' }
    ])
    expect(computeTotalDurationMs(modules)).toBe(1500)
    expect(computeSchedule(modules, CONFIG).totalMs).toBe(1500)
  })
})

describe('hierarchy 模块 → 机构 → 动作 → 子动作 → ...', () => {
  function buildTree() {
    const module = { ...task({ moduleName: '进样模块', actionDescription: '进样模块', durationMs: 0 }), id: 'M', kind: 'module' as TaskKind }
    const mechanism = { ...task({ moduleName: 'Feeder_1', actionDescription: 'Feeder_1', durationMs: 0, parentId: 'M' }), id: 'K', kind: 'mechanism' as TaskKind }
    const action = { ...task({ startMs: 100, durationMs: 400, parentId: 'K' }), id: 'A' }
    const sub1 = { ...task({ startMs: 500, durationMs: 100, parentId: 'A' }), id: 'S1', kind: 'subaction' as TaskKind }
    const sub2 = { ...task({ startMs: 600, durationMs: 50, parentId: 'S1' }), id: 'S2', kind: 'subaction' as TaskKind }
    const sub3 = { ...task({ startMs: 650, durationMs: 25, parentId: 'S2' }), id: 'S3', kind: 'subaction' as TaskKind }
    return resolve([module, mechanism, action, sub1, sub2, sub3])
  }

  it('rolls summary rows up from all descendants', () => {
    const schedule = computeSchedule(buildTree(), CONFIG)
    expect(schedule.byId.M.isSummary).toBe(true)
    expect(schedule.byId.K.isSummary).toBe(true)
    // Nested chain S1→S2→S3: each container inherits the deepest leaf's window.
    expect(schedule.byId.A.startMs).toBe(650)
    expect(schedule.byId.A.endMs).toBe(675)
    expect(schedule.byId.S1.startMs).toBe(650)
    expect(schedule.byId.S2.startMs).toBe(650)
    expect(schedule.byId.S3.startMs).toBe(650)
    expect(schedule.byId.M.rollupStartMs).toBe(650)
    expect(schedule.byId.M.rollupEndMs).toBe(675)
    expect(schedule.byId.K.rollupStartMs).toBe(650)
    expect(schedule.byId.S3.depth).toBe(5) // 模块 → 机构 → 动作 → 子动作 → 子动作 → 子动作
    expect(hierarchyPath(schedule, 'S3')[0]).toBe('进样模块')
    expect(hierarchyPath(schedule, 'S3')[1]).toBe('Feeder_1')
    expect(hierarchyPath(schedule, 'S3')).toHaveLength(6)
    expect(collectDescendantIds(schedule.tasks.map(t => t.module), 'A')).toEqual(expect.arrayContaining(['S1', 'S2', 'S3']))
  })

  it('assigns parent-prefixed codes so the number itself shows the hierarchy', () => {
    const numbered = renumberHierarchyCodes(buildTree())
    const codes = Object.fromEntries(numbered.map(m => [m.id, m.code]))
    expect(codes).toEqual({
      M: '01', K: '01.01', A: '01.01.01',
      S1: '01.01.01.01', S2: '01.01.01.01.01', S3: '01.01.01.01.01.01'
    })
    // The parent code is always the code prefix, including nested sub-actions.
    numbered.filter(m => m.parentId).forEach(m => {
      expect(m.code).toMatch(new RegExp(`^${codes[m.parentId!]}\\.\\d+$`))
    })
  })

  it('numbers sibling branches in stable tree order', () => {
    const modules = [
      { ...task({}), id: 'A', code: 'T9', parentId: null, kind: 'module' as TaskKind },
      { ...task({}), id: 'B', code: 'T8', parentId: 'A', kind: 'mechanism' as TaskKind },
      { ...task({}), id: 'C', code: 'T7', parentId: 'A', kind: 'mechanism' as TaskKind },
      { ...task({}), id: 'D', code: 'T6', parentId: 'B' },
      { ...task({}), id: 'E', code: 'T5', parentId: null, kind: 'module' as TaskKind }
    ]
    expect(Object.fromEntries(renumberHierarchyCodes(modules).map(m => [m.id, m.code]))).toEqual({
      A: '01', B: '01.01', C: '01.02', D: '01.01.01', E: '02'
    })
  })

  it('sub-actions nest to arbitrary depth and can be hidden by collapsing any ancestor', () => {
    const schedule = computeSchedule(buildTree(), CONFIG)
    expect(flattenTree(schedule).map(r => r.task.id)).toEqual(['M', 'K', 'A', 'S1', 'S2', 'S3'])
    // Collapse the action: all sub-actions disappear.
    expect(flattenTree(schedule, new Set(['A'])).map(r => r.task.id)).toEqual(['M', 'K', 'A'])
    // Collapse only a nested sub-action: its own descendants disappear.
    expect(flattenTree(schedule, new Set(['S2'])).map(r => r.task.id)).toEqual(['M', 'K', 'A', 'S1', 'S2'])
    // Collapse the module: only the module row remains.
    expect(flattenTree(schedule, new Set(['M'])).map(r => r.task.id)).toEqual(['M'])
  })

  it('ignores dependency edges attached to summary rows and reports them', () => {
    const module = { ...task({ moduleName: 'M', actionDescription: 'M', durationMs: 0, parentId: null }), id: 'M', kind: 'module' as TaskKind }
    const action = { ...task({ startMs: 0, durationMs: 100, parentId: 'M', predecessors: [dep('M')] }), id: 'A' }
    const schedule = computeSchedule([module, action], CONFIG)
    expect(schedule.byId.A.startMs).toBe(0)
    expect(schedule.warnings.some(w => w.includes('汇总行'))).toBe(true)
  })
})

describe('legacy mirror fields', () => {
  it('writes canonical ms back into the legacy grid fields used by MP4/PDF', () => {
    const config = { ...DEFAULT_TIME_CONFIG, scaleMs: 50, precisionMs: 1 }
    const modules = resolve([
      { ...task({ startMs: 125, durationMs: 75 }), id: 'A' }
    ], config)
    expect(modules[0].calculatedStartX).toBe(2.5)
    expect(modules[0].moveCount).toBe(1.5)
    expect(modules[0].duration).toBe(50)
    expect(modules[0].endMs).toBe(200)
  })
})

describe('child-driven parent/child time association', () => {
  const fixture = () => [
    { ...task({ id: 'M', moduleName: '模块', durationMs: 0, parentId: null }), kind: 'module' as TaskKind },
    { ...task({ id: 'K', moduleName: '机构', durationMs: 0, parentId: 'M' }), kind: 'mechanism' as TaskKind },
    { ...task({ id: 'A', startMs: 1000, durationMs: 800, parentId: 'K' }) }
  ]

  it('uses the child absolute time; the container rolls up to its bounds', () => {
    const [m, k, a] = fixture()
    const sub = task({ id: 'S', parentId: 'A', startMs: 1200, durationMs: 300 })
    const s = computeSchedule([m, k, a, sub], CONFIG)
    expect(s.byId.S.startMs).toBe(1200)
    expect(s.byId.S.endMs).toBe(1500)
    expect(s.byId.A.startMs).toBe(1200) // container = earliest child
    expect(s.byId.A.endMs).toBe(1500)   // container = latest child end
  })

  it('a leaf action with no children stays on its authored absolute time', () => {
    const [m, k] = fixture()
    const leaf = task({ id: 'L', parentId: 'K', startMs: 4300, durationMs: 250 })
    const s = computeSchedule([m, k, leaf], CONFIG)
    expect(s.byId.L.startMs).toBe(4300)
    expect(s.byId.L.endMs).toBe(4550)
    expect(s.byId.L.isLeaf).toBe(true)
  })

  it('keeps the container time independent of its own authored start', () => {
    const [m, k, a] = fixture()
    const sub = task({ id: 'S', parentId: 'A', startMs: 1200, durationMs: 300 })
    const moved = { ...a, startMs: 5000, anchorMs: 5000 }
    const s = computeSchedule([m, k, moved, sub], CONFIG)
    expect(s.byId.A.startMs).toBe(1200) // authored 5000 ignored; child decides
    expect(s.byId.S.startMs).toBe(1200)
  })

  it('shifts the whole sub-tree as one when the container predecessor requires it', () => {
    const [m, k] = fixture()
    const trigger = task({ id: 'T', startMs: 0, durationMs: 400, parentId: 'K' })
    const container = { ...task({ id: 'A', parentId: 'K', predecessors: [dep('T')] }) }
    const s1 = task({ id: 'S1', parentId: 'A', startMs: 500, durationMs: 200 })
    const s2 = task({ id: 'S2', parentId: 'A', startMs: 900, durationMs: 100 })
    const before = computeSchedule([m, k, trigger, container, s1, s2], CONFIG)
    // Sub-tree earliest = 500, predecessor ends 400 → already satisfied, no shift.
    expect(before.byId.A.startMs).toBe(500)
    expect(before.byId.S2.startMs).toBe(900)

    const movedTrigger = { ...trigger, startMs: 1000, anchorMs: 1000 }
    const after = computeSchedule([m, k, movedTrigger, container, s1, s2], CONFIG)
    // Predecessor now ends 1400 → whole sub-tree shifts +900, preserving gaps.
    expect(after.byId.A.startMs).toBe(1400)
    expect(after.byId.S1.startMs).toBe(1400)
    expect(after.byId.S2.startMs).toBe(1800)
    expect(after.byId.A.endMs).toBe(1900)
  })

  it('nested containers compose: outer shift carries the inner sub-tree', () => {
    const [m, k] = fixture()
    const trigger = task({ id: 'T', startMs: 0, durationMs: 1000, parentId: 'K' })
    const outer = { ...task({ id: 'A', parentId: 'K', predecessors: [dep('T')] }) }
    const inner = task({ id: 'S1', parentId: 'A', startMs: 200, durationMs: 50, kind: 'subaction' })
    const grand = task({ id: 'S2', parentId: 'S1', startMs: 300, durationMs: 50, kind: 'subaction' })
    const s = computeSchedule([m, k, trigger, outer, inner, grand], CONFIG)
    // Only the deepest leaf S2 is schedulable; its window (300..350) shifts by
    // +700 so the sub-tree earliest meets the predecessor end of 1000. Both
    // container ancestors then roll up to that single leaf's window.
    expect(s.byId.A.startMs).toBe(1000)
    expect(s.byId.S1.startMs).toBe(1000)
    expect(s.byId.S2.startMs).toBe(1000)
  })

  it('keeps a child predecessor as a hard lower bound', () => {
    const [m, k, a] = fixture()
    const gate = task({ id: 'G', startMs: 3000, durationMs: 100, parentId: 'K' })
    const sub = task({ id: 'S', parentId: 'A', startMs: 1100, durationMs: 200, predecessors: [dep('G')] })
    const s = computeSchedule([m, k, a, gate, sub], CONFIG)
    expect(s.byId.S.startMs).toBe(3100)
    expect(s.byId.A.startMs).toBe(3100) // container follows the child
  })
})

describe('hierarchy vs predecessor conflict', () => {
  const tree = () => {
    const m = { ...task({ id: 'M', moduleName: '模块', durationMs: 0, parentId: null }), kind: 'module' as TaskKind }
    const k = { ...task({ id: 'K', moduleName: '机构', durationMs: 0, parentId: 'M' }), kind: 'mechanism' as TaskKind }
    const a = task({ id: 'A', startMs: 100, durationMs: 500, parentId: 'K' })
    const s1 = task({ id: 'S1', startMs: 200, durationMs: 100, parentId: 'A', kind: 'subaction' })
    const s2 = task({ id: 'S2', startMs: 400, durationMs: 100, parentId: 'A', kind: 'subaction' })
    return { modules: [m, k, a, s1, s2], m, k, a, s1, s2 }
  }

  it('flags a child depending on its own ancestor container', () => {
    const { modules, s1 } = tree()
    expect(wouldCreateHierarchyConflict(modules, s1.id, 'A')).toBe(true)
    expect(wouldCreateHierarchyConflict(modules, s1.id, 'K')).toBe(true)
  })

  it('flags an ancestor container depending on its own descendant', () => {
    const { modules, a, s2 } = tree()
    expect(wouldCreateHierarchyConflict(modules, a.id, s2.id)).toBe(true)
  })

  it('allows sibling sub-actions to depend on each other', () => {
    const { modules, s1, s2 } = tree()
    expect(wouldCreateHierarchyConflict(modules, s2.id, s1.id)).toBe(false)
  })

  it('allows unrelated actions to depend on each other', () => {
    const { modules, s1 } = tree()
    const other = task({ id: 'X', startMs: 0, durationMs: 100, parentId: s1.id, kind: 'subaction' })
    expect(wouldCreateHierarchyConflict([...modules, other], other.id, 'S2')).toBe(false)
  })
})

describe('resolvePredecessorLeaf (UI container -> latest leaf)', () => {
  const tree = () => {
    const m = { ...task({ id: 'M', moduleName: '模块', durationMs: 0, parentId: null }), kind: 'module' as TaskKind }
    const k = { ...task({ id: 'K', moduleName: '机构', durationMs: 0, parentId: 'M' }), kind: 'mechanism' as TaskKind }
    const a = task({ id: 'A', startMs: 0, durationMs: 0, parentId: 'K' })
    const s1 = task({ id: 'S1', startMs: 100, durationMs: 80, parentId: 'A', kind: 'subaction' })
    const s2 = task({ id: 'S2', startMs: 400, durationMs: 120, parentId: 'A', kind: 'subaction' })
    const peer = task({ id: 'B', startMs: 200, durationMs: 50, parentId: 'K' })
    return { modules: [m, k, a, s1, s2, peer] }
  }

  it('maps a leaf to itself', () => {
    const schedule = computeSchedule(tree().modules, CONFIG)
    expect(resolvePredecessorLeaf(schedule, 'S1')).toBe('S1')
  })

  it('maps a container to the latest-ending leaf in its sub-tree', () => {
    const schedule = computeSchedule(tree().modules, CONFIG)
    // S2 ends at 520, S1 at 180 -> latest is S2.
    expect(resolvePredecessorLeaf(schedule, 'A')).toBe('S2')
  })

  it('honours nested sub-actions when picking the latest leaf', () => {
    const base = tree().modules
    const nested = task({ id: 'S2a', startMs: 500, durationMs: 90, parentId: 'S2', kind: 'subaction' })
    const schedule = computeSchedule([...base, nested], CONFIG)
    // S2 is now a container (rolls up to S2a at 590); S1 is the only other leaf.
    expect(resolvePredecessorLeaf(schedule, 'A')).toBe('S2a')
  })

  it('returns null for an id that is not in the schedule', () => {
    const schedule = computeSchedule(tree().modules, CONFIG)
    expect(resolvePredecessorLeaf(schedule, 'missing')).toBeNull()
  })
})

describe('cross-container dependency with container shift', () => {
  it('a leaf depending on another container leaf keeps a hard lower bound after shifts', () => {
    const m = { ...task({ id: 'M', moduleName: '模块', durationMs: 0, parentId: null }), kind: 'module' as TaskKind }
    const k = { ...task({ id: 'K', moduleName: '机构', durationMs: 0, parentId: 'M' }), kind: 'mechanism' as TaskKind }
    // Container A with predecessor T; its child SA is a dependency source.
    const t = task({ id: 'T', startMs: 0, durationMs: 1000, parentId: 'K' })
    const a = { ...task({ id: 'A', parentId: 'K', predecessors: [dep('T')] }) }
    const sa = task({ id: 'SA', parentId: 'A', startMs: 200, durationMs: 100, kind: 'subaction' })
    // Leaf SB (outside A) depends on SA with FS.
    const b = { ...task({ id: 'B', parentId: 'K', startMs: 0, durationMs: 50, predecessors: [dep('SA')] }) }
    const s = computeSchedule([m, k, t, a, sa, b], CONFIG)
    // SA shifts to T end (1000); B must not start before SA's shifted end (1100).
    expect(s.byId.SA.startMs).toBe(1000)
    expect(s.byId.B.startMs).toBeGreaterThanOrEqual(s.byId.SA.endMs)
  })
})
