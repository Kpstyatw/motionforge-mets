import { ModuleData, TaskKind } from '@/types'
import { collectDescendantIds } from './dependencyEngine'
import { isPhysicalNode } from './nameValidation'

/**
 * Hierarchy editing rules for 模块 → 机构 → 动作 → 子动作.
 * A module is a root; deeper kinds must hang below the matching parent kind.
 * A sub-action may also be nested under another sub-action (any depth).
 */
export function canBeParentOf(childKind: TaskKind | undefined, parentKind: TaskKind | undefined): boolean {
  if (!parentKind) return childKind === 'module'
  switch (childKind) {
    case 'module': return false
    case 'mechanism': return parentKind === 'module'
    case 'action': return parentKind === 'mechanism'
    case 'subaction': return parentKind === 'mechanism' || parentKind === 'action' || parentKind === 'subaction'
    default: return false
  }
}

/**
 * A leaf's 所属机构 / 阶段 labels are denormalised projections of the tree.
 * After a move, refresh the moved subtree so Excel/PDF labels agree with the
 * new hierarchy. Summary nodes keep their own physical names.
 */
export function refreshSubtreeLabels(modules: ModuleData[], rootId: string): ModuleData[] {
  const byId = new Map(modules.map(m => [m.id, m]))
  const moved = new Set([rootId, ...collectDescendantIds(modules, rootId)])
  return modules.map(m => {
    if (!moved.has(m.id) || isPhysicalNode(m)) return m
    let cursor = m.parentId ? byId.get(m.parentId) : undefined
    let mechanism: ModuleData | undefined
    let module: ModuleData | undefined
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id)
      if (cursor.kind === 'mechanism' && !mechanism) mechanism = cursor
      if (cursor.kind === 'module' && !module) module = cursor
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    return {
      ...m,
      moduleName: mechanism?.moduleName ?? m.moduleName,
      stage: module?.moduleName ?? m.stage,
      color: mechanism?.color ?? m.color
    }
  })
}
