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
 * Build resourceId → owning module/mechanism.
 *
 * Ownership is stored on the RESOURCE side (`Resource.ownerNodeId`) so one
 * node can own several resources — a mechanism may expose a gripper and a
 * needle at once. Legacy projects put the binding on the node instead
 * (`ModuleData.resourceId`); those are still honoured as a fallback.
 *
 * A mechanism owner nests the resource under its parent module → mechanism;
 * a module owner puts it directly under that module. Since ownerNodeId is a
 * single value per resource, each resource lands on exactly one lane.
 */
export function buildResourceOwnerIndex(
  modules: ModuleData[],
  resources: Resource[] = []
): Map<string, ResourceOwner> {
  const byId = new Map(modules.map(m => [m.id, m]))
  const owners = new Map<string, ResourceOwner>()

  const ownerForNode = (node: ModuleData): ResourceOwner | null => {
    const name = node.moduleName || node.actionDescription || node.code || node.id
    if (node.kind === 'mechanism') {
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      return {
        moduleId: parent?.id ?? '',
        moduleName: parent?.moduleName || parent?.actionDescription || '',
        mechanismId: node.id,
        mechanismName: name
      }
    }
    if (node.kind === 'module') {
      return { moduleId: node.id, moduleName: name, mechanismId: '', mechanismName: '' }
    }
    return null
  }

  // New model: each resource points at its owning node. Many resources may
  // share the same ownerNodeId, which is exactly the one-to-many case.
  for (const r of resources) {
    if (!r.ownerNodeId) continue
    const node = byId.get(r.ownerNodeId)
    if (!node) continue
    const owner = ownerForNode(node)
    if (owner) owners.set(r.id, owner)
  }

  // Legacy model: node.resourceId = R. First node in tree order wins so an
  // old resource still appears on one lane only.
  for (const m of modules) {
    if (!m.resourceId || owners.has(m.resourceId)) continue
    const owner = ownerForNode(m)
    if (owner) owners.set(m.resourceId, owner)
  }
  return owners
}
