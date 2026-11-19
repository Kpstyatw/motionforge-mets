import { Resource, ResourceAllocation, RotaryMotion } from '@/types'
import { ScheduleResult, ScheduledTask } from './dependencyEngine'

/**
 * Resource-tree + rotary-phase engine — pure, DOM-free, unit-testable.
 *
 * This layer resolves *where a claim really lands*:
 *   - mechanism bindings turn into auto claims on descendant actions,
 *   - activeSlot claims resolve to the child slot selected by rotation phase,
 *   - ancestor relationships decide which claims can conflict.
 *
 * Everything here is derived from authored project data. Nothing is written
 * back to the store: the template stays the single source of truth.
 */

/** Modulo that stays non-negative for negative steps / offsets. */
function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

/**
 * Slot index aligned to the station in a given cycle (1-based).
 *   selected = (startSlot + (cycle - 1) * stepPerCycle) mod slots
 * `stepPerCycle = 0` keeps every cycle on the same slot.
 */
export function selectedSlotIndex(motion: RotaryMotion, cycle: number): number {
  const slots = Math.max(1, Math.round(motion.slots) || 1)
  const start = positiveMod(Math.round(motion.startSlot ?? 0), slots)
  const step = Math.round(motion.stepPerCycle ?? 0)
  const c = Math.max(1, Math.round(cycle) || 1)
  return positiveMod(start + (c - 1) * step, slots)
}

/** Resource map with stable iteration order preserved by the caller. */
export function resourceIndex(resources: Resource[]): Map<string, Resource> {
  return new Map(resources.map(r => [r.id, r]))
}

/** Ancestor chain of a resource, starting with itself, ending at the root. */
export function resourceChain(resourceId: string, resources: Resource[] | Map<string, Resource>): string[] {
  const byId = resources instanceof Map ? resources : resourceIndex(resources)
  const chain: string[] = []
  const guard = new Set<string>()
  let current: Resource | undefined = byId.get(resourceId)
  while (current && !guard.has(current.id)) {
    guard.add(current.id)
    chain.push(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return chain
}

/** True when `ancestorId` is `descendantId` or one of its ancestors. */
export function isResourceAncestor(
  ancestorId: string,
  descendantId: string,
  resources: Resource[] | Map<string, Resource>
): boolean {
  return resourceChain(descendantId, resources).includes(ancestorId)
}

/**
 * Resolve a claim's effective resource id. Only `activeSlot` claims on a
 * rotary parent are redirected to a child slot; all other claims are unchanged.
 */
export function resolveClaimResourceId(
  allocation: ResourceAllocation,
  cycle: number,
  resources: Resource[] | Map<string, Resource>
): string {
  if (allocation.slotMode !== 'activeSlot') return allocation.resourceId
  const byId = resources instanceof Map ? resources : resourceIndex(resources)
  const parent = byId.get(allocation.resourceId)
  if (!parent?.motion || parent.motion.type !== 'rotary') return allocation.resourceId
  const target = selectedSlotIndex(parent.motion, cycle) + (parent.motion.stationOffset ?? 0)
  const slot = [...byId.values()].find(
    r => r.parentId === parent.id && r.slotIndex !== undefined
      && positiveMod(r.slotIndex, parent.motion!.slots) === positiveMod(target, parent.motion!.slots)
  )
  return slot?.id ?? allocation.resourceId
}

/** Leaf tasks underneath a task id (or the task itself when it has no children). */
function descendantLeaves(schedule: ScheduleResult, id: string): ScheduledTask[] {
  const task = schedule.byId[id]
  if (!task) return []
  if (!task.childIds.length) return [task]
  const out: ScheduledTask[] = []
  const seen = new Set<string>()
  const walk = (tid: string) => {
    if (seen.has(tid)) return
    seen.add(tid)
    const node = schedule.byId[tid]
    if (!node) return
    if (!node.childIds.length) { out.push(node); return }
    node.childIds.forEach(walk)
  }
  task.childIds.forEach(walk)
  return out
}

/**
 * Synthesise one claim per descendant action of every mechanism node that is
 * bound to a resource. The claim window equals the action's own execution
 * window, so dependency cascades move it with no extra bookkeeping.
 *
 * These claims carry `source: 'mechanism'` and are added in the view layer
 * only — `project.allocations` is never modified.
 */
export function deriveMechanismAllocations(schedule: ScheduleResult): ResourceAllocation[] {
  const out: ResourceAllocation[] = []
  for (const task of schedule.tasks) {
    if (task.kind !== 'mechanism') continue
    const resourceId = task.module.resourceId
    if (!resourceId) continue
    for (const leaf of descendantLeaves(schedule, task.id)) {
      out.push({
        id: `auto:${task.id}:${leaf.id}:${resourceId}`,
        taskId: leaf.id,
        resourceId,
        offsetMs: 0,
        durationMs: Math.max(0, leaf.durationMs),
        slotMode: 'fixed',
        source: 'mechanism',
        notes: `自动占用 · ${task.module.moduleName || task.module.actionDescription}`
      })
    }
  }
  return out
}

/** Two claims share a conflict domain when either resource is an ancestor of the other. */
export function claimsShareDomain(
  aResourceId: string,
  bResourceId: string,
  resources: Resource[] | Map<string, Resource>
): boolean {
  if (aResourceId === bResourceId) return true
  const byId = resources instanceof Map ? resources : resourceIndex(resources)
  return resourceChain(aResourceId, byId).includes(bResourceId)
    || resourceChain(bResourceId, byId).includes(aResourceId)
}

/** Depth of a resource in its tree (0 = root), with a cycle guard. */
export function resourceDepth(resourceId: string, resources: Resource[] | Map<string, Resource>): number {
  return Math.max(0, resourceChain(resourceId, resources).length - 1)
}
