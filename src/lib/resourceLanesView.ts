import { ResourceLane } from './resourceScheduler'
import { ResourceOwner, resourceChain } from './resourceTree'

/**
 * Shared hierarchy projection of the resource swim-lanes:
 *
 *   模块 → 机构 → 资源 → 资源的子级（旋转盘孔位等）
 *
 * The on-screen view, the PDF chart and the Excel sheet all render THIS list,
 * so an exported hierarchy cannot drift from what the app shows. Ownership is
 * inherited from the nearest bound ancestor on the resource chain, which is
 * how a rotary slot stays under the plate bound to a mechanism. Group rows
 * never carry claim bars; only resource rows do.
 */
export type ResourceViewRow =
  | { kind: 'module' | 'mechanism'; key: string; name: string; depth: number; count: number; lane?: undefined; indent?: undefined }
  | { kind: 'resource'; key: string; name: string; depth: number; count?: undefined; lane: ResourceLane; indent: number }

export interface ResourceViewLabels {
  ungroupedModule?: string
  ungroupedMechanism?: string
}

interface OwnedItem { lane: ResourceLane; indent: number }
interface MechanismGroup { name: string; items: OwnedItem[] }
interface ModuleGroup {
  key: string
  name: string
  direct: OwnedItem[]
  mechanisms: Map<string, MechanismGroup>
}

export function buildResourceViewRows(
  lanes: ResourceLane[],
  owners: Map<string, ResourceOwner> | undefined,
  labels: ResourceViewLabels = {}
): ResourceViewRow[] {
  const ownerIndex = owners ?? new Map<string, ResourceOwner>()
  const moduleFallback = labels.ungroupedModule || '未归属模块'
  const mechanismFallback = labels.ungroupedMechanism || '未分组资源'
  const resources = lanes.map(l => l.resource)
  const groups = new Map<string, ModuleGroup>()
  const loose: OwnedItem[] = []

  for (const lane of lanes) {
    const chain = resourceChain(lane.resource.id, resources)
    let owner: ResourceOwner | undefined
    let dist = 0
    for (let d = 0; d < chain.length; d++) {
      const bound = ownerIndex.get(chain[d])
      if (bound) { owner = bound; dist = d; break }
    }
    const item: OwnedItem = { lane, indent: dist }
    if (!owner) { loose.push(item); continue }

    const moduleKey = owner.moduleId || `__m__${owner.moduleName}`
    let group = groups.get(moduleKey)
    if (!group) {
      group = { key: moduleKey, name: owner.moduleName, direct: [], mechanisms: new Map() }
      groups.set(moduleKey, group)
    }
    if (!owner.mechanismId) { group.direct.push(item); continue }
    let mechanism = group.mechanisms.get(owner.mechanismId)
    if (!mechanism) {
      mechanism = { name: owner.mechanismName, items: [] }
      group.mechanisms.set(owner.mechanismId, mechanism)
    }
    mechanism.items.push(item)
  }

  const resourceRow = (item: OwnedItem): ResourceViewRow => ({
    kind: 'resource',
    key: `res:${item.lane.resource.id}`,
    name: item.lane.resource.name,
    // 0 = module, 1 = mechanism, 2 = resource under it, deeper = child slot.
    depth: 2 + item.indent,
    lane: item.lane,
    indent: item.indent
  })

  const rows: ResourceViewRow[] = []
  for (const group of groups.values()) {
    const claimCount = [...group.mechanisms.values()]
      .reduce((n, m) => n + m.items.length, group.direct.length)
    rows.push({
      kind: 'module',
      key: `mod:${group.key}`,
      name: group.name || moduleFallback,
      depth: 0,
      count: claimCount
    })
    group.direct.forEach(item => rows.push(resourceRow(item)))
    for (const [mechanismKey, mechanism] of group.mechanisms) {
      rows.push({
        kind: 'mechanism',
        key: `mech:${mechanismKey}`,
        name: mechanism.name,
        depth: 1,
        count: mechanism.items.length
      })
      mechanism.items.forEach(item => rows.push(resourceRow(item)))
    }
  }

  if (loose.length) {
    rows.push({
      kind: 'module', key: 'mod:__loose__', name: moduleFallback, depth: 0, count: loose.length
    })
    rows.push({
      kind: 'mechanism', key: 'mech:__loose__', name: mechanismFallback, depth: 1, count: loose.length
    })
    loose.forEach(item => rows.push(resourceRow(item)))
  }
  return rows
}
