import { describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { ModuleData, TaskKind, TimeConfig } from '@/types'
import {
  collectDescendantIds, computeSchedule, flattenTree, hierarchyPath,
  syncLegacyFields, wouldCreateCycle
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
    const sub1 = { ...task({ durationMs: 100, parentId: 'A', predecessors: [dep('A')] }), id: 'S1', kind: 'subaction' as TaskKind }
    const sub2 = { ...task({ durationMs: 50, parentId: 'S1', predecessors: [dep('S1')] }), id: 'S2', kind: 'subaction' as TaskKind }
    const sub3 = { ...task({ durationMs: 25, parentId: 'S2', predecessors: [dep('S2')] }), id: 'S3', kind: 'subaction' as TaskKind }
    return resolve([module, mechanism, action, sub1, sub2, sub3])
  }

  it('rolls summary rows up from all descendants', () => {
    const schedule = computeSchedule(buildTree(), CONFIG)
    expect(schedule.byId.M.isSummary).toBe(true)
    expect(schedule.byId.K.isSummary).toBe(true)
    expect(schedule.byId.A.startMs).toBe(100)
    expect(schedule.byId.S1.startMs).toBe(500)
    expect(schedule.byId.S2.startMs).toBe(600)
    expect(schedule.byId.S3.startMs).toBe(650)
    expect(schedule.byId.M.rollupStartMs).toBe(100)
    expect(schedule.byId.M.rollupEndMs).toBe(675)
    expect(schedule.byId.K.rollupStartMs).toBe(100)
    expect(schedule.byId.S3.depth).toBe(5) // 模块 → 机构 → 动作 → 子动作 → 子动作 → 子动作
    expect(hierarchyPath(schedule, 'S3')[0]).toBe('进样模块')
    expect(hierarchyPath(schedule, 'S3')[1]).toBe('Feeder_1')
    expect(hierarchyPath(schedule, 'S3')).toHaveLength(6)
    expect(collectDescendantIds(schedule.tasks.map(t => t.module), 'A')).toEqual(expect.arrayContaining(['S1', 'S2', 'S3']))
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
