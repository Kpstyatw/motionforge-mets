import { Resource, ResourceAllocation } from '@/types'
import { ScheduleResult, ScheduledTask } from './dependencyEngine'
import { claimsShareDomain, resourceDepth, resourceIndex, resolveClaimResourceId } from './resourceTree'
import { cycleIndexOf } from './cycleEngine'

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
  /**
   * The resource the claim actually lands on after phase resolution. For most
   * claims this equals allocation.resourceId; for `activeSlot` claims it is the
   * selected child slot of a rotary parent. Conflict grouping uses this id.
   */
  effectiveResourceId?: string
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
  /** Tree depth (0 = root) for indented swim-lane rendering. */
  depth?: number
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
  const resourceById = resourceIndex(resources)
  const placed: PlacedAllocation[] = []
  for (const allocation of allocations) {
    const task = schedule.byId[allocation.taskId]
    if (!task || task.isSummary) continue
    const offset = Math.max(0, Math.round(allocation.offsetMs || 0))
    const duration = Math.max(0, Math.round(allocation.durationMs || 0))
    const startMs = task.startMs + offset
    // A claim on the owning task's cycle resolves `activeSlot` to the child
    // slot currently aligned with the station. Multi-cycle tasks carry @Cn.
    const cycle = task.module.cycleIndex ?? cycleIndexOf(task.id)
    const effectiveResourceId = resolveClaimResourceId(allocation, cycle, resourceById)
    placed.push({
      allocation,
      task,
      resource: resourceById.get(effectiveResourceId),
      effectiveResourceId,
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
export function detectConflicts(
  placed: PlacedAllocation[],
  resources: Resource[] = []
): ResourceConflict[] {
  const resourceById = resourceIndex(resources)
  const conflicts: ResourceConflict[] = []
  const seen = new Set<string>()

  // Sorted globally: a claim can only overlap a later one whose start is
  // before it ends. We compare across resources because an ancestor claim
  // conflicts with a descendant claim even though they live on different ids.
  const eff = (p: PlacedAllocation) => p.effectiveResourceId ?? p.allocation.resourceId
  const sorted = [...placed].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      if (b.startMs >= a.endMs) break // sorted by start → no later overlap
      if (a.endMs <= b.startMs || b.endMs <= a.startMs) continue
      // One action cannot conflict with itself — this also prevents an
      // explicit claim and a derived mechanism claim on the same task from
      // flagging a false positive.
      if (a.task.id === b.task.id) continue
      if (!claimsShareDomain(eff(a), eff(b), resourceById)) continue
      const pairId = [a.allocation.id, b.allocation.id].sort().join('|')
      if (seen.has(pairId)) continue
      seen.add(pairId)
      const overlapStartMs = Math.max(a.startMs, b.startMs)
      const overlapEndMs = Math.min(a.endMs, b.endMs)
      const overlapMs = overlapEndMs - overlapStartMs
      if (overlapMs <= 0) continue
      conflicts.push({
        id: pairId,
        resourceId: eff(b),
        resourceName: b.resource?.name ?? eff(b),
        a,
        b,
        overlapMs,
        overlapStartMs,
        overlapEndMs
      })
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
  const conflicts = detectConflicts(placed, resources)

  const byResource: Record<string, PlacedAllocation[]> = {}
  for (const p of placed) {
    const key = p.effectiveResourceId ?? p.allocation.resourceId
    ;(byResource[key] ??= []).push(p)
  }
  for (const list of Object.values(byResource)) {
    list.sort((x, y) => x.startMs - y.startMs)
  }

  // Parent-first order so child slots render directly under their disc.
  const byId = resourceIndex(resources)
  const ordered: Resource[] = []
  const seen = new Set<string>()
  const visit = (parentId: string | undefined) => {
    resources.filter(r => (r.parentId ?? undefined) === parentId).forEach(r => {
      if (seen.has(r.id)) return
      seen.add(r.id)
      ordered.push(r)
      visit(r.id)
    })
  }
  visit(undefined)
  resources.forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); ordered.push(r) } })

  const lanes: ResourceLane[] = ordered.map(resource => ({
    resource,
    depth: resourceDepth(resource.id, byId),
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
