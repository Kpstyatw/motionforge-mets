import { ScheduleResult, ScheduledTask } from './dependencyEngine'

/**
 * Mechanism layer — pure, DOM-free, unit-testable.
 *
 * A physical mechanism can only execute ONE action at a time. This module
 * detects the *other* kind of conflict from `resourceScheduler`: here two
 * leaf actions owned by the same mechanism overlap in their execution window
 * ([startMs, endMs)), which the resource layer cannot see because those
 * actions may never claim a shared resource.
 *
 * Scope rules (deliberately conservative to avoid false positives):
 *  - Only the finest-grained leaves are compared (action/subaction rows with
 *    no children). A parent action and its sub-action describe the same motion
 *    at two granularities, so their natural overlap is NOT a conflict.
 *  - Only leaves under the SAME owning mechanism are compared. Different
 *    mechanisms are physically independent and may run in parallel.
 *  - A leaf with no mechanism ancestor falls back to the nearest module
 *    ancestor as its grouping boundary (a module is also a physical unit).
 *  - Zero-duration windows and half-open touching ([a,b) vs [b,c)) are not
 *    conflicts.
 *
 * This layer never changes timing — it only reports overlaps ("先做提示").
 */

/** A detected overlap of two leaf actions owned by the same mechanism/module. */
export interface MechanismConflict {
  id: string
  /** Id of the owning mechanism (or fallback module) node. */
  ownerId: string
  /** Human-readable owner name for tooltips. */
  ownerName: string
  a: ScheduledTask
  b: ScheduledTask
  overlapMs: number
  overlapStartMs: number
  overlapEndMs: number
}

export interface MechanismConflictResult {
  conflicts: MechanismConflict[]
  /** Task ids involved in any conflict (for warning badges in the flow view). */
  conflictedTaskIds: Set<string>
  /** Conflicts keyed by owning mechanism/module id. */
  byOwner: Record<string, MechanismConflict[]>
}

/** Nearest mechanism ancestor of a task, falling back to the nearest module. */
export function ownerBoundaryOf(schedule: ScheduleResult, taskId: string): ScheduledTask | null {
  let current = schedule.byId[taskId]?.parentId ? schedule.byId[schedule.byId[taskId].parentId!] : undefined
  let fallback: ScheduledTask | null = null
  const guard = new Set<string>([taskId])
  while (current && !guard.has(current.id)) {
    guard.add(current.id)
    if (current.kind === 'mechanism') return current
    if (current.kind === 'module' && !fallback) fallback = current
    current = current.parentId ? schedule.byId[current.parentId] : undefined
  }
  return fallback
}

/** True when `ancestorId` is strictly above `nodeId` in the task tree. */
function isAncestor(schedule: ScheduleResult, ancestorId: string, nodeId: string): boolean {
  let cursor = schedule.byId[nodeId]?.parentId
  const guard = new Set<string>([nodeId])
  while (cursor && !guard.has(cursor)) {
    if (cursor === ancestorId) return true
    guard.add(cursor)
    cursor = schedule.byId[cursor]?.parentId ?? null
  }
  return false
}

/**
 * Find pairwise overlaps of leaf actions inside each physical boundary.
 * Sorted-by-start scanning stops as soon as a later action cannot overlap.
 */
export function detectMechanismConflicts(schedule: ScheduleResult): MechanismConflictResult {
  const groups = new Map<string, ScheduledTask[]>()
  const ownerNames = new Map<string, string>()

  for (const task of schedule.tasks) {
    // Only finest-grained schedulable actions participate.
    if (task.isSummary || task.childIds.length > 0) continue
    if (task.durationMs <= 0) continue
    const boundary = ownerBoundaryOf(schedule, task.id)
    if (!boundary) continue
    if (!groups.has(boundary.id)) groups.set(boundary.id, [])
    groups.get(boundary.id)!.push(task)
    if (!ownerNames.has(boundary.id)) {
      ownerNames.set(boundary.id, boundary.module.moduleName || boundary.code || boundary.id)
    }
  }

  const conflicts: MechanismConflict[] = []
  const byOwner: Record<string, MechanismConflict[]> = {}
  const conflictedTaskIds = new Set<string>()

  for (const [ownerId, tasks] of groups) {
    const sorted = [...tasks].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs)
    const local: MechanismConflict[] = []
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]
        if (b.startMs >= a.endMs) break // sorted by start → no later overlap
        if (a.endMs <= b.startMs || b.endMs <= a.startMs) continue
        if (a.id === b.id) continue
        // Defensive: leaves under one boundary should not be ancestor/descendant.
        if (isAncestor(schedule, a.id, b.id) || isAncestor(schedule, b.id, a.id)) continue
        const overlapStartMs = Math.max(a.startMs, b.startMs)
        const overlapEndMs = Math.min(a.endMs, b.endMs)
        const overlapMs = overlapEndMs - overlapStartMs
        if (overlapMs <= 0) continue
        local.push({
          id: [a.id, b.id].sort().join('|'),
          ownerId,
          ownerName: ownerNames.get(ownerId) ?? ownerId,
          a,
          b,
          overlapMs,
          overlapStartMs,
          overlapEndMs
        })
      }
    }
    if (local.length) {
      byOwner[ownerId] = local
      conflicts.push(...local)
      for (const c of local) {
        conflictedTaskIds.add(c.a.id)
        conflictedTaskIds.add(c.b.id)
      }
    }
  }

  return {
    conflicts: conflicts.sort((x, y) => x.overlapStartMs - y.overlapStartMs),
    conflictedTaskIds,
    byOwner
  }
}
