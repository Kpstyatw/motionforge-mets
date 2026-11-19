import { ModuleData, Resource, ResourceAllocation, RotaryMotion } from '@/types'

/**
 * Resource-tree + rotary-phase engine — pure, DOM-free, unit-testable.
 *
 * This layer resolves *where a claim really lands*:
 *   - ownership bindings (module/mechanism → resource) are a hierarchy hint
 *     only; they never create occupation — claims come from authored actions,
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

/**
 * Flow-side ownership of a resource, reversed from flow-node bindings.
 * A node (mechanism or module) with `resourceId = R` means "this node claims
 * R"; for the resource-centred view we invert that into "R belongs under this
 * module → mechanism". A module-bound resource has no mechanism, so it shows
 * directly under that module. Unbound resources stay ungrouped.
 */
export interface ResourceOwner {
  moduleId: string
  moduleName: string
  mechanismId: string
  mechanismName: string
}

/**
 * Build resourceId → owning module/mechanism from the flow tree.
 *
 * Both mechanism and module nodes may bind a resource. A mechanism binding
 * nests the resource under its parent module → mechanism; a module binding
 * puts it directly under that module (mechanism fields empty). Multiple nodes
 * may bind the same resource; the first in tree order wins so a resource
 * appears on exactly one lane (no duplicate rows).
 */
export function buildResourceOwnerIndex(modules: ModuleData[]): Map<string, ResourceOwner> {
  const byId = new Map(modules.map(m => [m.id, m]))
  const owners = new Map<string, ResourceOwner>()
  for (const m of modules) {
    if (!m.resourceId || owners.has(m.resourceId)) continue
    const name = m.moduleName || m.actionDescription || m.code || m.id
    if (m.kind === 'mechanism') {
      const parent = m.parentId ? byId.get(m.parentId) : undefined
      owners.set(m.resourceId, {
        moduleId: parent?.id ?? '',
        moduleName: parent?.moduleName || parent?.actionDescription || '',
        mechanismId: m.id,
        mechanismName: name
      })
    } else if (m.kind === 'module') {
      owners.set(m.resourceId, {
        moduleId: m.id,
        moduleName: name,
        mechanismId: '',
        mechanismName: ''
      })
    }
  }
  return owners
}
