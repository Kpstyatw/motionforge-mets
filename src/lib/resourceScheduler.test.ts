import { describe, expect, it } from 'vitest'
import { ModuleData, Resource, ResourceAllocation, TaskKind } from '@/types'
import { computeSchedule } from './dependencyEngine'
import { DEFAULT_TIME_CONFIG } from './timeScale'
import {
  clampAllocationWindow, computeResourceSchedule, detectConflicts,
  placeAllocations, resourceBusyMs
} from './resourceScheduler'

const CONFIG = { ...DEFAULT_TIME_CONFIG }

function node(
  id: string, kind: TaskKind, parentId: string | null,
  startMs: number, durationMs: number, predecessors: ModuleData['predecessors'] = []
): ModuleData {
  return {
    id, code: id, kind, parentId,
    moduleName: kind === 'module' ? '模块' : kind === 'mechanism' ? '机构' : `动作${id}`,
    actionDescription: `动作${id}`, stage: 'A', color: '#3b82f6',
    startMs, anchorMs: startMs, durationMs, endMs: startMs + durationMs,
    startMode: 'auto', predecessors,
    startX: startMs / CONFIG.scaleMs, calculatedStartX: startMs / CONFIG.scaleMs,
    moveCount: durationMs / CONFIG.scaleMs, duration: CONFIG.scaleMs,
    isSequentialAction: false
  }
}

const RESOURCES: Resource[] = [
  { id: 'GRIP', name: '管库抓手', type: 'gripper' },
  { id: 'ARM', name: '样本臂', type: 'arm' }
]

function alloc(
  id: string, taskId: string, resourceId: string, offsetMs: number, durationMs: number
): ResourceAllocation {
  return { id, taskId, resourceId, offsetMs, durationMs }
}

describe('Resource scheduler', () => {
  it('resolves exact windows relative to each action start', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 2000, 4000)
    ]
    const schedule = computeSchedule(modules, CONFIG)
    const placed = placeAllocations(schedule, [
      alloc('g', 'A', 'GRIP', 0, 1200),
      alloc('a', 'A', 'ARM', 1000, 1500)
    ], RESOURCES)
    expect(placed).toHaveLength(2)
    const grip = placed.find(p => p.resource?.id === 'GRIP')!
    const arm = placed.find(p => p.resource?.id === 'ARM')!
    expect(grip.startMs).toBe(2000)
    expect(grip.endMs).toBe(3200)
    expect(arm.startMs).toBe(3000)
    expect(arm.endMs).toBe(4500)
  })

  it('cascades claim windows when the owning action is re-scheduled', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 2000, 1000),
      node('B', 'action', 'K', 0, 500, [{ id: 'e', fromId: 'A', type: 'FS', lagMs: 0 }])
    ]
    const allocations = [alloc('g', 'B', 'GRIP', 100, 200)]
    const before = computeResourceSchedule(computeSchedule(modules, CONFIG), allocations, RESOURCES)
    expect(before.placed.find(p => p.task.id === 'B')!.startMs).toBe(3100)

    // Change A's duration → B cascades → the claim on B follows automatically.
    const changed = modules.map(m => m.id === 'A' ? { ...m, durationMs: 2500 } : m)
    const after = computeResourceSchedule(computeSchedule(changed, CONFIG), allocations, RESOURCES)
    expect(after.placed.find(p => p.task.id === 'B')!.startMs).toBe(4600)
  })

  it('detects a cross-flow conflict on the shared gripper', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 2000, 4000), // 加样流程：抓管 2.0–3.2s
      node('B', 'action', 'K', 3000, 2000)  // 稀释流程：丢管 3.0–4.4s
    ]
    const allocations = [
      alloc('g1', 'A', 'GRIP', 0, 1200),
      alloc('g2', 'B', 'GRIP', 0, 1400)
    ]
    const rs = computeResourceSchedule(computeSchedule(modules, CONFIG), allocations, RESOURCES)
    expect(rs.conflicts).toHaveLength(1)
    const c = rs.conflicts[0]
    expect(c.resourceId).toBe('GRIP')
    expect(c.overlapStartMs).toBe(3000)
    expect(c.overlapEndMs).toBe(3200)
    expect(c.overlapMs).toBe(200)
    expect(rs.conflictedTaskIds.has('A')).toBe(true)
    expect(rs.conflictedTaskIds.has('B')).toBe(true)
    expect(rs.lanes.find(l => l.resource.id === 'GRIP')!.conflicts).toHaveLength(1)
    expect(rs.lanes.find(l => l.resource.id === 'ARM')!.conflicts).toHaveLength(0)
  })

  it('does not flag claims that merely touch at the boundary', () => {
    const placed = [
      { allocation: alloc('x', 'A', 'GRIP', 0, 1000), task: { id: 'A' } as never, resource: RESOURCES[0], startMs: 0, endMs: 1000 },
      { allocation: alloc('y', 'B', 'GRIP', 0, 1000), task: { id: 'B' } as never, resource: RESOURCES[0], startMs: 1000, endMs: 2000 }
    ]
    expect(detectConflicts(placed)).toHaveLength(0)
  })

  it('supports many-to-many: one action holds several resources, one resource serves many actions', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 2000, 4000),
      node('B', 'action', 'K', 10000, 1000)
    ]
    const allocations = [
      alloc('g1', 'A', 'GRIP', 0, 1200),
      alloc('a1', 'A', 'ARM', 1000, 1500),
      alloc('g2', 'B', 'GRIP', 0, 500)
    ]
    const rs = computeResourceSchedule(computeSchedule(modules, CONFIG), allocations, RESOURCES)
    expect(rs.byResource.GRIP).toHaveLength(2)
    expect(rs.byResource.ARM).toHaveLength(1)
    expect(rs.placed.filter(p => p.task.id === 'A')).toHaveLength(2)
    expect(rs.conflicts).toHaveLength(0) // no overlap in time
  })

  it('ignores claims on summary rows and on removed tasks', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 1000)
    ]
    const schedule = computeSchedule(modules, CONFIG)
    const placed = placeAllocations(schedule, [
      alloc('s', 'M', 'GRIP', 0, 500),       // summary
      alloc('gone', 'NOPE', 'GRIP', 0, 500)  // removed task
    ], RESOURCES)
    expect(placed).toHaveLength(0)
  })

  it('computes union busy time so double-booked overlaps are counted once', () => {
    const lane = {
      resource: RESOURCES[0],
      allocations: [
        { allocation: alloc('x', 'A', 'GRIP', 0, 0), task: { id: 'A' } as never, resource: RESOURCES[0], startMs: 0, endMs: 1000 },
        { allocation: alloc('y', 'B', 'GRIP', 0, 0), task: { id: 'B' } as never, resource: RESOURCES[0], startMs: 500, endMs: 1500 }
      ],
      conflicts: []
    }
    expect(resourceBusyMs(lane)).toBe(1500)
  })

  it('clamps an edited claim window inside its action duration', () => {
    expect(clampAllocationWindow(800, 500, 1000, 1)).toEqual({ offsetMs: 800, durationMs: 200 })
    expect(clampAllocationWindow(-50, 2000, 1000, 1)).toEqual({ offsetMs: 0, durationMs: 1000 })
  })

  it('anchors a claim to two different action events (grip start → inject end)', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 500),      // 抓取 1000–1500
      node('B', 'action', 'K', 1500, 500),      // 移送 1500–2000
      node('C', 'action', 'K', 2000, 1500)      // 加样 2000–3500
    ]
    const bound: ResourceAllocation = {
      ...alloc('bound', 'A', 'GRIP', 0, 0),
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'start', offsetMs: 0 },
      endRef: { taskId: 'C', at: 'end', offsetMs: 0 }
    }
    const rs = computeResourceSchedule(computeSchedule(modules, CONFIG), [bound], RESOURCES)
    expect(rs.placed).toHaveLength(1)
    expect(rs.placed[0].startMs).toBe(1000)
    expect(rs.placed[0].endMs).toBe(3500)
    expect(rs.warnings).toHaveLength(0)
  })

  it('follows cascades and honours fine offsets on both events', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 500),
      node('C', 'action', 'K', 5000, 1500)
    ]
    const bound: ResourceAllocation = {
      ...alloc('bound', 'A', 'GRIP', 0, 0),
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'end', offsetMs: 100 },   // A 结束后 100 → 1600
      endRef: { taskId: 'C', at: 'end', offsetMs: -50 }      // C 结束前 50 → 6450
    }
    const before = computeResourceSchedule(computeSchedule(modules, CONFIG), [bound], RESOURCES)
    expect([before.placed[0].startMs, before.placed[0].endMs]).toEqual([1600, 6450])

    // Push A later by 2000 ms; the start event follows while the release stays.
    const changed = modules.map(m => m.id === 'A' ? { ...m, anchorMs: 3000, startMs: 3000 } : m)
    const after = computeResourceSchedule(computeSchedule(changed, CONFIG), [bound], RESOURCES)
    expect([after.placed[0].startMs, after.placed[0].endMs]).toEqual([3600, 6450])
  })

  it('degrades an inverted event window with a warning', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 500),
      node('C', 'action', 'K', 2000, 500)
    ]
    const inverted: ResourceAllocation = {
      ...alloc('bad', 'A', 'GRIP', 0, 0),
      bindMode: 'event',
      startRef: { taskId: 'C', at: 'start' },   // 2000
      endRef: { taskId: 'A', at: 'start' }      // 1000 → earlier
    }
    const rs = computeResourceSchedule(computeSchedule(modules, CONFIG), [inverted], RESOURCES)
    expect(rs.placed).toHaveLength(0)
    expect(rs.warnings.length).toBeGreaterThan(0)
  })

  it('drops a bound claim whose referenced action was deleted', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 500)
    ]
    const bound: ResourceAllocation = {
      ...alloc('bound', 'A', 'GRIP', 0, 0),
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'start' },
      endRef: { taskId: 'DELETED', at: 'end' }
    }
    const warnings: string[] = []
    const placed = placeAllocations(computeSchedule(modules, CONFIG), [bound], RESOURCES, warnings)
    expect(placed).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('still detects conflicts between bound and manual claims on the same resource', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 1000),
      node('B', 'action', 'K', 1500, 1000)
    ]
    const bound: ResourceAllocation = {
      ...alloc('bound', 'A', 'GRIP', 0, 0),
      bindMode: 'event',
      startRef: { taskId: 'A', at: 'start' },
      endRef: { taskId: 'A', at: 'end' }
    }
    const rs = computeResourceSchedule(
      computeSchedule(modules, CONFIG),
      [bound, alloc('manual', 'B', 'GRIP', 0, 1000)],
      RESOURCES
    )
    expect(rs.conflicts).toHaveLength(1)
    expect(rs.conflicts[0].overlapStartMs).toBe(1500)
    expect(rs.conflicts[0].overlapEndMs).toBe(2000)
  })
})
