import { describe, expect, it } from 'vitest'
import { ModuleData, Resource, ResourceAllocation, RotaryMotion, TaskKind } from '@/types'
import { computeSchedule } from './dependencyEngine'
import { DEFAULT_TIME_CONFIG } from './timeScale'
import {
  claimsShareDomain, deriveMechanismAllocations, isResourceAncestor,
  resolveClaimResourceId, resourceChain, resourceDepth, selectedSlotIndex
} from './resourceTree'
import { computeResourceSchedule } from './resourceScheduler'

const CONFIG = { ...DEFAULT_TIME_CONFIG }
const MOTION: RotaryMotion = { type: 'rotary', slots: 8, stepPerCycle: 1, startSlot: 0 }

function node(
  id: string, kind: TaskKind, parentId: string | null,
  startMs: number, durationMs: number, resourceId?: string
): ModuleData {
  return {
    id, code: id, kind, parentId, resourceId,
    moduleName: kind === 'mechanism' ? '清洗盘机构' : `动作${id}`,
    actionDescription: `动作${id}`, startMs, anchorMs: startMs, durationMs,
    endMs: startMs + durationMs, startMode: 'auto',
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 0
  }
}

const TREE: Resource[] = [
  { id: 'PLATE', name: '清洗盘', motion: MOTION },
  { id: 'H0', name: '孔1', parentId: 'PLATE', slotIndex: 0 },
  { id: 'H1', name: '孔2', parentId: 'PLATE', slotIndex: 1 },
  { id: 'H2', name: '孔3', parentId: 'PLATE', slotIndex: 2 },
  { id: 'GRIP', name: '抓手' }
]

describe('resource phase engine', () => {
  it('selects successive slots per cycle and wraps around', () => {
    expect(selectedSlotIndex(MOTION, 1)).toBe(0)
    expect(selectedSlotIndex(MOTION, 2)).toBe(1)
    expect(selectedSlotIndex(MOTION, 8)).toBe(7)
    expect(selectedSlotIndex(MOTION, 9)).toBe(0)
  })

  it('handles reverse rotation and a stationary disc', () => {
    expect(selectedSlotIndex({ ...MOTION, stepPerCycle: -1, startSlot: 0 }, 2)).toBe(7)
    expect(selectedSlotIndex({ ...MOTION, stepPerCycle: 0, startSlot: 3 }, 5)).toBe(3)
  })

  it('resolves an activeSlot claim to the selected child, honouring stationOffset', () => {
    const base: ResourceAllocation = {
      id: 'a1', taskId: 'A', resourceId: 'PLATE', offsetMs: 0, durationMs: 100, slotMode: 'activeSlot'
    }
    expect(resolveClaimResourceId(base, 1, TREE)).toBe('H0')
    expect(resolveClaimResourceId(base, 3, TREE)).toBe('H2')
    const shifted = { ...base, resourceId: 'PLATE', slotMode: 'activeSlot' as const }
    expect(resolveClaimResourceId({ ...shifted, id: 'a2' }, 1, [
      { ...TREE[0], motion: { ...MOTION, stationOffset: 1 } }, ...TREE.slice(1)
    ])).toBe('H1')
  })

  it('leaves fixed claims and non-rotary parents untouched, falling back when no child matches', () => {
    const fixed: ResourceAllocation = { id: 'f', taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 100 }
    expect(resolveClaimResourceId(fixed, 4, TREE)).toBe('GRIP')
    const onFlat: ResourceAllocation = { ...fixed, id: 'x', slotMode: 'activeSlot', resourceId: 'GRIP' }
    expect(resolveClaimResourceId(onFlat, 4, TREE)).toBe('GRIP')
    const noChild: Resource[] = [{ id: 'EMPTY', name: '空盘', motion: MOTION }]
    expect(resolveClaimResourceId({ ...fixed, id: 'y', slotMode: 'activeSlot', resourceId: 'EMPTY' }, 2, noChild)).toBe('EMPTY')
  })

  it('builds ancestor chains, depths and conflict domains', () => {
    expect(resourceChain('H0', TREE)).toEqual(['H0', 'PLATE'])
    expect(resourceDepth('H0', TREE)).toBe(1)
    expect(resourceDepth('PLATE', TREE)).toBe(0)
    expect(isResourceAncestor('PLATE', 'H0', TREE)).toBe(true)
    expect(isResourceAncestor('H0', 'PLATE', TREE)).toBe(false)
    expect(claimsShareDomain('PLATE', 'H1', TREE)).toBe(true)
    expect(claimsShareDomain('H0', 'H1', TREE)).toBe(false)
    expect(claimsShareDomain('H0', 'GRIP', TREE)).toBe(false)
  })

  it('derives auto claims from a bound mechanism down to descendant actions', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0, 'GRIP'),
      node('A', 'action', 'K', 1000, 500), // has a child → summary, not claimed
      node('B', 'subaction', 'A', 1500, 300), // leaf → claimed
      node('C', 'action', 'K', 3000, 400), // leaf → claimed
      node('U', 'action', 'M', 5000, 400) // outside the mechanism
    ]
    const schedule = computeSchedule(modules, CONFIG)
    const derived = deriveMechanismAllocations(schedule)
    expect(derived).toHaveLength(2) // leaves B and C; not summary A/K, not U
    expect(derived.every(d => d.resourceId === 'GRIP' && d.source === 'mechanism')).toBe(true)
    const b = derived.find(d => d.taskId === 'B')!
    expect(b.offsetMs).toBe(0)
    expect(b.durationMs).toBe(300)
  })

  it('flags a parent claim overlapping a child slot claim but not sibling slots', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 1000),
      node('B', 'action', 'K', 2000, 1000),
      node('C', 'action', 'K', 2000, 1000),
      node('D', 'action', 'K', 2000, 1000) // whole-disc holder at the holes' window
    ]
    const schedule = computeSchedule(modules, CONFIG)
    const allocations: ResourceAllocation[] = [
      { id: 'whole', taskId: 'A', resourceId: 'PLATE', offsetMs: 0, durationMs: 1000 },
      { id: 'hole0', taskId: 'B', resourceId: 'H0', offsetMs: 0, durationMs: 1000 },
      { id: 'hole1', taskId: 'C', resourceId: 'H1', offsetMs: 0, durationMs: 1000 }
    ]
    const rs = computeResourceSchedule(schedule, allocations, TREE)
    // whole-disc claim (0–1000) does not overlap the holes (2000–3000);
    // sibling holes H0/H1 overlap in time but must NOT conflict.
    expect(rs.conflicts).toHaveLength(0)

    // Whole-disc claim on D (same window as B/C) overlaps both hole claims —
    // parent × each child conflicts, while siblings H0/H1 still do not.
    const overlapping = allocations.map(a => a.id === 'whole' ? { ...a, taskId: 'D' } : a)
    const rs2 = computeResourceSchedule(schedule, overlapping, TREE)
    expect(rs2.conflicts).toHaveLength(2) // PLATE(D) vs H0(B) and vs H1(C)
  })

  it('does not drift a slot claim when the disc rotates', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 500)
    ]
    const schedule = computeSchedule(modules, CONFIG)
    const claim: ResourceAllocation = {
      id: 'slot', taskId: 'A', resourceId: 'H0', offsetMs: 0, durationMs: 500
    }
    const rs = computeResourceSchedule(schedule, [claim], TREE)
    expect(rs.placed[0].effectiveResourceId).toBe('H0')
    expect(rs.byResource.H0).toHaveLength(1)
    expect(rs.byResource.H1).toBeUndefined()
  })
})
