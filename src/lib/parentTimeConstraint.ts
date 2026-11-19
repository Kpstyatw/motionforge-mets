import { ModuleData } from '@/types'
import { collectDescendantIds } from './dependencyEngine'
import { isPhysicalNode } from './nameValidation'
import { quantize } from './timeScale'

export interface ParentTimeChange {
  id: string
  name: string
  oldStartMs: number
  oldEndMs: number
  newStartMs: number
  newEndMs: number
}

export interface AutoExpandResult {
  modules: ModuleData[]
  changes: ParentTimeChange[]
}

/**
 * After a timing edit on an action/sub-action, walk up the flow chain and grow
 * every action/sub-action ancestor just enough to contain the whole subtree
 * below it. Physical nodes (module/mechanism) are auto-rolled by the scheduler
 * and are intentionally skipped — the constraint only applies to the action →
 * sub-action chain.
 *
 * `modules` must already carry the edited node's NEW startMs/durationMs so the
 * subtree bounds reflect the edit. The returned module list is safe to hand to
 * `commit`, which will re-run the scheduler with the expanded ancestor times.
 */
export function autoExpandParentTimes(
  modules: ModuleData[],
  editedId: string,
  precisionMs: number
): AutoExpandResult {
  const byId = new Map(modules.map(m => [m.id, m]))
  const edited = byId.get(editedId)
  const changes: ParentTimeChange[] = []
  if (!edited) return { modules, changes }

  // Working copy so each ancestor's expansion is visible to the level above it.
  const working = new Map<string, ModuleData>(modules.map(m => [m.id, { ...m }]))

  let cursorId: string | null = editedId
  const guard = new Set<string>()
  while (cursorId && !guard.has(cursorId)) {
    guard.add(cursorId)
    const node = working.get(cursorId)
    if (!node) break
    // Module/mechanism roll up automatically; stop the manual chain here.
    if (isPhysicalNode(node)) break

    const subtreeIds = [node.id, ...collectDescendantIds(modules, node.id)]
    let minStart = Number.POSITIVE_INFINITY
    let maxEnd = Number.NEGATIVE_INFINITY
    subtreeIds.forEach(id => {
      const child = working.get(id)
      if (!child) return
      const s = child.startMs ?? 0
      const e = s + (child.durationMs ?? 0)
      if (s < minStart) minStart = s
      if (e > maxEnd) maxEnd = e
    })
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) break

    const oldStart = node.startMs ?? 0
    const oldEnd = oldStart + (node.durationMs ?? 0)
    // Floor the start and ceil the end so the parent never trims a descendant.
    const newStart = quantize(Math.min(oldStart, minStart), precisionMs, 'floor')
    const newEnd = quantize(Math.max(oldEnd, maxEnd), precisionMs, 'ceil')

    if (newStart !== oldStart || newEnd !== oldEnd) {
      const updated: ModuleData = {
        ...node,
        startMs: newStart,
        anchorMs: newStart,
        durationMs: Math.max(0, quantize(newEnd - newStart, precisionMs, 'ceil')),
        endMs: newEnd
      }
      working.set(node.id, updated)
      changes.push({
        id: node.id,
        name: node.actionDescription || node.moduleName || node.code || node.id,
        oldStartMs: oldStart,
        oldEndMs: oldEnd,
        newStartMs: newStart,
        newEndMs: newEnd
      })
    }
    cursorId = node.parentId ?? null
  }

  let changed = false
  const next = modules.map(m => {
    const w = working.get(m.id)!
    if (w.startMs !== m.startMs || w.durationMs !== m.durationMs || w.anchorMs !== m.anchorMs) changed = true
    return w
  })
  return { modules: changed ? next : modules, changes }
}
