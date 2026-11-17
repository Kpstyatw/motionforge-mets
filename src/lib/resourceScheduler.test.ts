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
})
