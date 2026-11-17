import { describe, expect, it } from 'vitest'
import { ModuleData, Resource, ResourceAllocation } from '@/types'
import { computeSchedule } from './dependencyEngine'
import { computeResourceSchedule } from './resourceScheduler'
import {
  collapseCycleProjection, cycleIndexOf, expandCycles, instanceId,
  isMultiCycle, normalizeCycleConfig, templateIdOf
} from './cycleEngine'

const CYCLE = { enabled: true, cycleMs: 10_000, repeats: 3 }

function task(
  id: string, code: string, parentId: string | null,
  startMs: number, durationMs: number, predecessors: ModuleData['predecessors'] = [],
  kind: ModuleData['kind'] = 'action'
): ModuleData {
  return {
    id, code, parentId, kind,
    moduleName: kind === 'module' ? '模块' : '机构',
    actionDescription: code,
    startMs, anchorMs: startMs, durationMs, endMs: startMs + durationMs,
    startMode: 'auto', predecessors,
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 100,
    isSequentialAction: false
  }
}

function fixture(): { modules: ModuleData[]; allocations: ResourceAllocation[] } {
  const modules = [
    task('M', 'T01', null, 0, 0, [], 'module'),
    task('K', 'T02', 'M', 0, 0, [], 'mechanism'),
    task('A', 'T03', 'K', 1000, 800),
    task('B', 'T04', 'K', 0, 500, [{ id: 'e1', fromId: 'A', type: 'FS', lagMs: 200 }])
  ]
  const allocations: ResourceAllocation[] = [
    { id: 'al1', taskId: 'A', resourceId: 'GRIP', offsetMs: 100, durationMs: 300 }
  ]
  return { modules, allocations }
}

describe('cycle projection', () => {
  it('defaults to a single cycle and never projects when disabled', () => {
    expect(normalizeCycleConfig({}).enabled).toBe(false)
    expect(isMultiCycle({ enabled: true, cycleMs: 1000, repeats: 1 })).toBe(false)
    const { modules, allocations } = fixture()
    const view = expandCycles(modules, allocations, undefined)
    expect(view.expanded).toBe(false)
    expect(view.modules).toBe(modules)
    expect(view.allocations).toBe(allocations)
    expect(view.boundaries).toEqual([0, 30_000])
  })

  it('projects every row into N cycles with whole-cycle time shifts', () => {
    const { modules, allocations } = fixture()
    const view = expandCycles(modules, allocations, CYCLE)
    expect(view.expanded).toBe(true)
    expect(view.modules).toHaveLength(modules.length * 3)
    expect(view.allocations).toHaveLength(3)
    expect(view.boundaries).toEqual([0, 10_000, 20_000, 30_000])

    const a2 = view.modules.find(m => m.id === instanceId('A', 2))!
    expect(a2.code).toBe('T03@C2')
    expect(a2.startMs).toBe(11_000)
    expect(a2.endMs).toBe(11_800)
    expect(a2.cycleIndex).toBe(2)
    expect(a2.cycleTemplateId).toBe('A')
    expect(view.modules.find(m => m.id === instanceId('M', 3))?.startMs).toBe(20_000)
  })

  it('keeps hierarchy and dependencies inside the same cycle', () => {
    const { modules, allocations } = fixture()
    const view = expandCycles(modules, allocations, CYCLE)
    const b2 = view.modules.find(m => m.id === instanceId('B', 2))!
    const a2 = view.modules.find(m => m.id === instanceId('A', 2))!
    expect(b2.parentId).toBe(instanceId('K', 2))
    expect(b2.predecessors?.[0].fromId).toBe(a2.id)
    expect(b2.predecessors?.[0].lagMs).toBe(200)
    expect(view.instanceToTemplate[b2.id]).toBe('B')
    expect(view.templateToInstances.A).toHaveLength(3)
  })

  it('shifts resource claims with their owning instance', () => {
    const { modules, allocations } = fixture()
    const view = expandCycles(modules, allocations, CYCLE)
    const al3 = view.allocations.find(a => a.id.endsWith('@C3'))!
    expect(al3.taskId).toBe(instanceId('A', 3))
    expect(al3.offsetMs).toBe(100)
    expect(al3.durationMs).toBe(300)
  })

  it('folds a projected workbook back to one lossless template', () => {
    const { modules, allocations } = fixture()
    const view = expandCycles(modules, allocations, CYCLE)
    const folded = collapseCycleProjection(view.modules, view.allocations)
    expect(folded.modules).toHaveLength(modules.length)
    expect(folded.dropped).toBe(modules.length * 2)
    expect(folded.modules.find(m => m.id === 'B')?.predecessors?.[0].fromId).toBe('A')
    expect(folded.modules.find(m => m.id === 'B')?.parentId).toBe('K')
    expect(folded.allocations).toHaveLength(1)
    expect(folded.allocations[0]).toMatchObject({ id: 'al1', taskId: 'A', offsetMs: 100 })
    expect(templateIdOf(instanceId('A', 4))).toBe('A')
    expect(cycleIndexOf('T03@C3')).toBe(3)
    expect(cycleIndexOf('T03')).toBe(1)
  })

  it('detects a conflict that only exists between two adjacent cycles', () => {
    // A overlaps the C1→C2 boundary; B starts at 0 in every cycle.
    // Single cycle: A=[9500,10500), B=[0,500) → no overlap.
    // Two cycles: C1 A=[9500,10500) vs C2 B=[10000,10500) → 500 ms overlap.
    const modules: ModuleData[] = [
      task('A', 'T01', null, 9500, 1000),
      task('B', 'T02', null, 0, 500)
    ]
    const allocations: ResourceAllocation[] = [
      { id: 'ga', taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 1000 },
      { id: 'gb', taskId: 'B', resourceId: 'GRIP', offsetMs: 0, durationMs: 500 }
    ]
    const resources: Resource[] = [{ id: 'GRIP', name: '管库抓手' }]
    const single = expandCycles(modules, allocations, { enabled: false, cycleMs: 10_000, repeats: 1 })
    const noConflict = computeResourceSchedule(
      computeSchedule(single.modules, { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }),
      single.allocations, resources
    )
    expect(noConflict.conflicts).toHaveLength(0)

    const multi = expandCycles(modules, allocations, { enabled: true, cycleMs: 10_000, repeats: 2 })
    const found = computeResourceSchedule(
      computeSchedule(multi.modules, { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }),
      multi.allocations, resources
    )
    expect(found.conflicts).toHaveLength(1)
    expect(found.conflicts[0].overlapMs).toBe(500)
    expect(found.conflicts[0].a.task.id).toBe(instanceId('A', 1))
    expect(found.conflicts[0].b.task.id).toBe(instanceId('B', 2))
  })

  it('warns when a template task overruns one cycle', () => {
    const { modules, allocations } = fixture()
    const long = { ...modules[2], code: 'T03', startMs: 9500, durationMs: 900, endMs: 10_400 }
    const view = expandCycles(
      modules.map(m => m.id === 'A' ? long : m), allocations, CYCLE
    )
    expect(view.warnings.some(w => w.includes('超出周期'))).toBe(true)
  })
})
