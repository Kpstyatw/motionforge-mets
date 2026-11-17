import { Resource, ResourceAllocation } from '@/types'
import { ScheduleResult, ScheduledTask } from './dependencyEngine'

/**
 * Resource layer — pure, DOM-free, unit-testable.
 *
 * The dependency engine owns *when an action runs*; this module owns *which
 * physical resource an action holds and for how long*. A claim (allocation)
 * stores an offset relative to its action's resolved start, so when the
 * scheduler cascades an action to a new time, every one of its claims follows
 * automatically. Conflicts are recomputed from those live absolute windows.
 *
 * This layer never changes timing — it only reports overlaps ("先做提示").
 */

/** Absolute time window of one allocation, after the owning action is scheduled. */
export interface PlacedAllocation {
  allocation: ResourceAllocation
  task: ScheduledTask
  resource: Resource | undefined
  /** Absolute start = task.startMs + allocation.offsetMs. */
  startMs: number
  /** Absolute end = start + allocation.durationMs. */
  endMs: number
}

/** A detected overlap of two claims on the same resource. */
export interface ResourceConflict {
  id: string
  resourceId: string
  resourceName: string
  a: PlacedAllocation
  b: PlacedAllocation
  /** Length of the intersecting [start, end) window, integer ms. */
  overlapMs: number
  overlapStartMs: number
  overlapEndMs: number
}

/** One resource swim-lane for the resource Gantt view. */
export interface ResourceLane {
  resource: Resource
  allocations: PlacedAllocation[]
  conflicts: ResourceConflict[]
}

export interface ResourceSchedule {
  /** Every claim with its absolute window; claims with a missing task/resource dropped. */
  placed: PlacedAllocation[]
  byResource: Record<string, PlacedAllocation[]>
  lanes: ResourceLane[]
  conflicts: ResourceConflict[]
  /** Task ids involved in any conflict (for warning badges in the flow view). */
  conflictedTaskIds: Set<string>
}

/**
 * Resolve every allocation to an absolute window using the *current* schedule.
 * Claims whose action was removed, or whose action is a summary row, are ignored.
 */
export function placeAllocations(
  schedule: ScheduleResult,
  allocations: ResourceAllocation[],
  resources: Resource[]
): PlacedAllocation[] {
  const resourceById = new Map(resources.map(r => [r.id, r]))
  const placed: PlacedAllocation[] = []
  for (const allocation of allocations) {
    const task = schedule.byId[allocation.taskId]
    if (!task || task.isSummary) continue
    const offset = Math.max(0, Math.round(allocation.offsetMs || 0))
    const duration = Math.max(0, Math.round(allocation.durationMs || 0))
    const startMs = task.startMs + offset
    placed.push({
      allocation,
      task,
      resource: resourceById.get(allocation.resourceId),
      startMs,
      endMs: startMs + duration
    })
  }
  return placed
}

/**
 * Find pairwise overlaps on each resource. Half-open intervals [start, end) are
 * used, so a claim ending exactly when the next begins is NOT a conflict.
 * Sorting by start lets us stop scanning a resource as soon as a later claim
 * can no longer overlap the current one.
 */
export function detectConflicts(placed: PlacedAllocation[]): ResourceConflict[] {
  const byResource = new Map<string, PlacedAllocation[]>()
  for (const p of placed) {
    const list = byResource.get(p.allocation.resourceId) ?? []
    list.push(p)
    byResource.set(p.allocation.resourceId, list)
  }

  const conflicts: ResourceConflict[] = []
  for (const [resourceId, list] of byResource) {
    list.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs)
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (b.startMs >= a.endMs) break // later claims start after a ends → done
        if (a.endMs <= b.startMs || b.endMs <= a.startMs) continue
        const overlapStartMs = Math.max(a.startMs, b.startMs)
        const overlapEndMs = Math.min(a.endMs, b.endMs)
        const overlapMs = overlapEndMs - overlapStartMs
        if (overlapMs <= 0) continue
        conflicts.push({
          id: `${a.allocation.id}:${b.allocation.id}`,
          resourceId,
          resourceName: a.resource?.name ?? resourceId,
          a,
          b,
          overlapMs,
          overlapStartMs,
          overlapEndMs
        })
      }
    }
  }
  return conflicts.sort((x, y) => x.overlapStartMs - y.overlapStartMs)
}

/** Full resource projection: windows, per-resource lanes and conflicts. */
export function computeResourceSchedule(
  schedule: ScheduleResult,
  allocations: ResourceAllocation[],
  resources: Resource[]
): ResourceSchedule {
  const placed = placeAllocations(schedule, allocations, resources)
  const conflicts = detectConflicts(placed)

  const byResource: Record<string, PlacedAllocation[]> = {}
  for (const p of placed) {
    ;(byResource[p.allocation.resourceId] ??= []).push(p)
  }
  for (const list of Object.values(byResource)) {
    list.sort((x, y) => x.startMs - y.startMs)
  }

  const lanes: ResourceLane[] = resources.map(resource => ({
    resource,
    allocations: byResource[resource.id] ?? [],
    conflicts: conflicts.filter(c => c.resourceId === resource.id)
  }))

  const conflictedTaskIds = new Set<string>()
  for (const c of conflicts) {
    conflictedTaskIds.add(c.a.task.id)
    conflictedTaskIds.add(c.b.task.id)
  }

  return { placed, byResource, lanes, conflicts, conflictedTaskIds }
}

/**
 * Clamp an allocation window to a task's own duration. Kept as a helper for
 * editors: a claim is not allowed to start before its action or outlast it.
 */
export function clampAllocationWindow(
  offsetMs: number,
  durationMs: number,
  taskDurationMs: number,
  precisionMs = 1
): { offsetMs: number; durationMs: number } {
  const snap = (n: number) => Math.round(n / precisionMs) * precisionMs
  const offset = Math.max(0, Math.min(snap(offsetMs), Math.max(0, snap(taskDurationMs))))
  const duration = Math.max(0, Math.min(snap(durationMs), Math.max(0, snap(taskDurationMs) - offset)))
  return { offsetMs: offset, durationMs: duration }
}

/** Total time a resource is claimed (union of its windows, not sum). */
export function resourceBusyMs(lane: ResourceLane): number {
  const windows = lane.allocations
    .map(a => [a.startMs, a.endMs] as [number, number])
    .sort((x, y) => x[0] - y[0])
  let total = 0
  let curStart = -1
  let curEnd = -1
  for (const [s, e] of windows) {
    if (curEnd < 0 || s > curEnd) {
      if (curEnd >= 0) total += curEnd - curStart
      curStart = s
      curEnd = e
    } else if (e > curEnd) {
      curEnd = e
    }
  }
  if (curEnd >= 0) total += curEnd - curStart
  return total
}
