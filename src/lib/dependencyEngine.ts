import { Dependency, DependencyType, ModuleData, StartMode, TaskKind, TimeConfig } from '@/types'
import { normalizeTimeConfig, quantize } from './timeScale'
import { v4 as uuidv4 } from 'uuid'

/**
 * Hierarchy + dependency scheduling engine — pure, DOM-free, unit-testable.
 *
 * Hierarchy: 模块(module) → 机构(mechanism) → 动作(action) → 子动作(subaction)
 * → 子动作 → ... Sub-actions nest to any depth. `module` and `mechanism` rows
 * are summaries: their start/end roll up from all descendant tasks and they
 * are not schedulable. `action` / `subaction` rows are real tasks with their
 * own canonical timing and predecessor edges.
 *
 * One function (`computeSchedule`) decides every start time in the project. It
 * is a full recomputation rather than a delta propagation: with FS/SS/FF/SF
 * edges and multiple predecessors a full topological pass is both simpler and
 * strictly correct, and it is O(V+E).
 *
 * The store calls it after every mutation; nothing else may write `startMs` /
 * `endMs` or the legacy mirror fields.
 */

export interface ScheduledTask {
  id: string
  code: string
  module: ModuleData
  kind: TaskKind
  /** module/mechanism rows (roll-up only, no own timing). */
  isSummary: boolean
  isLeaf: boolean
  startMs: number
  durationMs: number
  endMs: number
  /** Roll-up bounds over all descendant leaf tasks (for summary brackets). */
  rollupStartMs: number
  rollupEndMs: number
  startMode: StartMode
  /** Earliest start allowed by all predecessors, or null when it has none. */
  constraintMs: number | null
  /** A pinned start had to be pushed later to honour its predecessors. */
  clamped: boolean
  depth: number
  parentId: string | null
  childIds: string[]
  predecessorIds: string[]
}

export interface ScheduleResult {
  /** All tasks in the project's on-screen (tree) order. */
  tasks: ScheduledTask[]
  byId: Record<string, ScheduledTask>
  byCode: Record<string, ScheduledTask>
  /** Topological order of schedulable leaf tasks. */
  order: string[]
  cycles: string[][]
  /** fromId -> ids of tasks that depend on it (for cascade highlighting). */
  successors: Record<string, string[]>
  missingPredecessors: Array<{ taskId: string; fromId: string }>
  totalMs: number
  warnings: string[]
  rootIds: string[]
}

export const DEFAULT_DEPENDENCY_TYPE: DependencyType = 'FS'

export const isSummaryKind = (kind: TaskKind | undefined): boolean =>
  kind === 'module' || kind === 'mechanism'

// ---------------------------------------------------------------------------
// Migration / normalisation
// ---------------------------------------------------------------------------

/**
 * The upstream rule, used once to migrate legacy CSV data into absolute ms.
 * First action in a module group starts at 0; later ones either follow the
 * previous action or wait until their start column is reached.
 */
export function legacyStartTimes(modules: ModuleData[]): number[] {
  const indexOf = new Map(modules.map((m, i) => [m, i]))
  const result = new Array<number>(modules.length).fill(0)
  const groups: Record<string, ModuleData[]> = {}
  modules.forEach(m => { ;(groups[m.moduleName] ??= []).push(m) })
  Object.values(groups).forEach(group => {
    let prevStart = 0
    group.forEach((m, i) => {
      if (i > 0) {
        const prev = group[i - 1]
        prevStart = m.isSequentialAction
          ? prevStart + prev.moveCount * prev.duration
          : prevStart +
            Math.max(0, (m.calculatedStartX ?? m.startX) - (prev.calculatedStartX ?? prev.startX)) *
              prev.duration
      }
      result[indexOf.get(m) ?? 0] = prevStart
    })
  })
  return result
}

/**
 * Reassign human-readable codes from the actual tree shape.
 *
 * A flat `T01 / T02 / ...` sequence cannot tell a reader which module owns a
 * mechanism or which action owns a nested sub-action. The hierarchical form
 * uses one two-digit sibling index per depth, e.g.
 *   `01` (模块) → `01.01` (机构) → `01.01.01` (动作) → `01.01.01.01` (子动作)
 * The parent code is always the prefix, so both Excel and the UI expose the
 * containment relationship without needing a separate tree view. Internal
 * dependencies point at stable ids, so renumbering never breaks edges.
 */
export function renumberHierarchyCodes(modules: ModuleData[]): ModuleData[] {
  const ids = new Set(modules.map(m => m.id))
  const children = new Map<string, string[]>()
  const roots: string[] = []

  modules.forEach(m => {
    if (m.parentId && ids.has(m.parentId) && m.parentId !== m.id) {
      const list = children.get(m.parentId) ?? []
      list.push(m.id)
      children.set(m.parentId, list)
    } else {
      roots.push(m.id)
    }
  })

  const assigned = new Map<string, string>()
  const visited = new Set<string>()
  const assign = (id: string, segments: number[]) => {
    if (visited.has(id)) return
    visited.add(id)
    assigned.set(id, segments.map(n => String(n).padStart(2, '0')).join('.'))
    ;(children.get(id) ?? []).forEach((childId, index) => {
      assign(childId, [...segments, index + 1])
    })
  }

  roots.forEach((id, index) => assign(id, [index + 1]))
  // Defensive: parent cycles or dangling references must still get a code.
  modules.forEach(m => {
    if (!visited.has(m.id)) assign(m.id, [visited.size + 1])
  })

  return modules.map(m => ({ ...m, code: assigned.get(m.id) ?? m.code ?? m.id }))
}

export interface NormalizeOptions {
  /** Generate T01, T02... codes where missing. */
  assignCodes?: boolean
}

/** Fill canonical ms fields on rows that came from an upstream CSV / project. */
export function normalizeModules(
  modules: ModuleData[],
  configInput: TimeConfig | Partial<TimeConfig> | undefined,
  options: NormalizeOptions = {}
): ModuleData[] {
  const config = normalizeTimeConfig(configInput)
  const legacy = legacyStartTimes(modules)
  let codeCounter = 0
  const usedCodes = new Set(modules.map(m => m.code).filter((c): c is string => Boolean(c)))

  return modules.map((m, index) => {
    let code = m.code
    if (!code && options.assignCodes !== false) {
      do {
        codeCounter += 1
        code = `T${String(codeCounter).padStart(2, '0')}`
      } while (usedCodes.has(code))
      usedCodes.add(code)
    }
    const durationMs = quantize(
      m.durationMs ?? m.moveCount * (m.duration || config.scaleMs),
      config.precisionMs,
      'ceil'
    )
    const startMs = quantize(m.startMs ?? legacy[index] ?? 0, config.precisionMs, 'round')
    const predecessors = (m.predecessors ?? []).filter(d => d && d.fromId && d.fromId !== m.id)
    return {
      ...m,
      code,
      kind: m.kind ?? 'action',
      startMs: Math.max(0, startMs),
      anchorMs: Math.max(0, quantize(m.anchorMs ?? startMs, config.precisionMs, 'round')),
      durationMs: Math.max(0, durationMs),
      endMs: Math.max(0, startMs) + Math.max(0, durationMs),
      startMode: m.startMode ?? 'auto',
      parentId: m.parentId ?? null,
      predecessors: predecessors.map(d => ({
        ...d,
        id: d.id || uuidv4(),
        type: d.type || DEFAULT_DEPENDENCY_TYPE,
        lagMs: Math.round(d.lagMs || 0)
      }))
    } as ModuleData
  })
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

export function findCycles(modules: ModuleData[]): string[][] {
  const ids = new Set(modules.map(m => m.id))
  const edges = new Map<string, string[]>()
  modules.forEach(m => {
    edges.set(m.id, (m.predecessors ?? [])
      .filter(d => ids.has(d.fromId) && d.fromId !== m.id)
      .map(d => d.fromId))
  })
  const state = new Map<string, 0 | 1 | 2>()
  const cycles: string[][] = []
  const stack: string[] = []
  const visit = (id: string) => {
    state.set(id, 1)
    stack.push(id)
    for (const from of edges.get(id) ?? []) {
      if (state.get(from) === 1) cycles.push(stack.slice(stack.indexOf(from)))
      else if (!state.has(from)) visit(from)
    }
    stack.pop()
    state.set(id, 2)
  }
  modules.forEach(m => { if (!state.has(m.id)) visit(m.id) })
  return cycles
}

/** Would adding `taskId -> fromId` close a loop? Used before mutating. */
export function wouldCreateCycle(modules: ModuleData[], taskId: string, fromId: string): boolean {
  if (taskId === fromId) return true
  const byId = new Map(modules.map(m => [m.id, m]))
  if (!byId.has(taskId) || !byId.has(fromId)) return false
  const seen = new Set<string>()
  const walk = (id: string): boolean => {
    if (id === taskId) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (byId.get(id)?.predecessors ?? []).some(d => walk(d.fromId))
  }
  return walk(fromId)
}

export function collectDescendantIds(modules: ModuleData[], rootId: string): string[] {
  const children = new Map<string, string[]>()
  modules.forEach(m => {
    if (!m.parentId) return
    if (!children.has(m.parentId)) children.set(m.parentId, [])
    children.get(m.parentId)!.push(m.id)
  })
  const out: string[] = []
  const stack = [...(children.get(rootId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    stack.push(...(children.get(id) ?? []))
  }
  return out
}

function depthOf(m: ModuleData, byId: Map<string, ModuleData>): number {
  let depth = 0
  let parent = m.parentId ? byId.get(m.parentId) : undefined
  const guard = new Set<string>([m.id])
  while (parent && !guard.has(parent.id)) {
    guard.add(parent.id)
    depth += 1
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return depth
}

/** Human-readable hierarchy path, e.g. ["进样模块", "Feeder_1", "上料"]. */
export function hierarchyPath(schedule: ScheduleResult, id: string): string[] {
  const parts: string[] = []
  let current: ScheduledTask | undefined = schedule.byId[id]
  const guard = new Set<string>()
  while (current && !guard.has(current.id)) {
    guard.add(current.id)
    parts.unshift(current.kind === 'module' || current.kind === 'mechanism'
      ? current.module.moduleName
      : current.module.actionDescription)
    current = current.parentId ? schedule.byId[current.parentId] : undefined
  }
  return parts
}

export interface TreeRow {
  task: ScheduledTask
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

/** Depth-first flatten of the hierarchy, honouring collapsed nodes. */
export function flattenTree(schedule: ScheduleResult, collapsedIds: Set<string> = new Set()): TreeRow[] {
  const out: TreeRow[] = []
  // `visited` is separate from `out`: collapsed descendants are hidden but
  // still visited, otherwise the orphan pass would append them again.
  const visited = new Set<string>()
  const markSubtree = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    ;(schedule.byId[id]?.childIds ?? []).forEach(markSubtree)
  }
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const task = schedule.byId[id]
    if (!task) return
    const hasChildren = task.childIds.length > 0
    const collapsed = collapsedIds.has(id)
    out.push({ task, depth: task.depth, hasChildren, collapsed })
    if (collapsed) task.childIds.forEach(markSubtree)
    else task.childIds.forEach(visit)
  }
  schedule.rootIds.forEach(visit)
  // Orphans (a parentId pointing at a missing row) still need to be visible.
  schedule.tasks.forEach(t => { if (!visited.has(t.id)) visit(t.id) })
  return out
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Earliest successor start implied by one dependency edge. */
export function constraintFor(
  type: DependencyType,
  predStart: number,
  predEnd: number,
  succDuration: number,
  lagMs: number
): number {
  switch (type) {
    case 'SS': return predStart + lagMs
    case 'FF': return predEnd + lagMs - succDuration
    case 'SF': return predStart + lagMs - succDuration
    case 'FS':
    default: return predEnd + lagMs
  }
}

export function computeSchedule(
  modules: ModuleData[],
  configInput: TimeConfig | Partial<TimeConfig> | undefined
): ScheduleResult {
  const config = normalizeTimeConfig(configInput)
  const rows = normalizeModules(modules, config)
  const byRow = new Map(rows.map(m => [m.id, m]))
  const ids = new Set(rows.map(m => m.id))
  const warnings: string[] = []
  const missingPredecessors: Array<{ taskId: string; fromId: string }> = []

  const summaryIds = new Set(rows.filter(m => isSummaryKind(m.kind)).map(m => m.id))
  const leafIds = new Set(rows.filter(m => !summaryIds.has(m.id)).map(m => m.id))

  // Only leaf-to-leaf edges participate in scheduling.
  const indegree = new Map<string, number>()
  const successors: Record<string, string[]> = {}
  rows.forEach(m => {
    if (summaryIds.has(m.id)) {
      if ((m.predecessors?.length ?? 0) > 0) {
        warnings.push(`汇总行 ${m.code ?? m.id} 不支持前置任务，已忽略`)
      }
      indegree.set(m.id, 0)
      return
    }
    const valid = (m.predecessors ?? []).filter(d => {
      if (!ids.has(d.fromId)) {
        missingPredecessors.push({ taskId: m.id, fromId: d.fromId })
        return false
      }
      if (summaryIds.has(d.fromId)) {
        warnings.push(`任务 ${m.code ?? m.id} 的前置 ${byRow.get(d.fromId)?.code ?? d.fromId} 是汇总行，已忽略`)
        return false
      }
      return d.fromId !== m.id
    })
    indegree.set(m.id, valid.length)
    valid.forEach(d => { ;(successors[d.fromId] ??= []).push(m.id) })
  })
  missingPredecessors.forEach(p => warnings.push(`未知前置任务 ${p.fromId}（任务 ${p.taskId}）`))

  // Kahn topological sort over leaf tasks.
  const queue = rows.filter(m => leafIds.has(m.id) && (indegree.get(m.id) ?? 0) === 0).map(m => m.id)
  const order: string[] = []
  const pending = new Map(indegree)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of successors[id] ?? []) {
      const left = (pending.get(next) ?? 0) - 1
      pending.set(next, left)
      if (left === 0) queue.push(next)
    }
  }
  const cycles = findCycles(rows.filter(m => leafIds.has(m.id)))
  const cyclicIds = new Set(cycles.flat())
  rows.forEach(m => { if (leafIds.has(m.id) && !order.includes(m.id)) order.push(m.id) })

  // Hierarchy maps.
  const childMap = new Map<string, string[]>()
  const rootIds: string[] = []
  rows.forEach(m => {
    if (m.parentId && ids.has(m.parentId)) {
      if (!childMap.has(m.parentId)) childMap.set(m.parentId, [])
      childMap.get(m.parentId)!.push(m.id)
    } else {
      rootIds.push(m.id)
    }
  })

  // Pass 1 — schedule every real task in dependency order.
  const leafResult = new Map<string, { startMs: number; durationMs: number; constraintMs: number | null; clamped: boolean; predecessorIds: string[] }>()
  order.forEach(id => {
    const m = byRow.get(id)!
    const durationMs = Math.max(0, quantize(m.durationMs ?? 0, config.precisionMs, 'ceil'))
    const deps = (m.predecessors ?? []).filter(
      (d): d is Dependency => leafIds.has(d.fromId) && d.fromId !== id && leafResult.has(d.fromId)
    )
    let constraintMs: number | null = null
    deps.forEach(d => {
      const pred = leafResult.get(d.fromId)!
      const value = constraintFor(d.type, pred.startMs, pred.startMs + pred.durationMs, durationMs, d.lagMs || 0)
      constraintMs = constraintMs === null ? value : Math.max(constraintMs, value)
    })
    if (constraintMs !== null) constraintMs = Math.max(0, quantize(constraintMs, config.precisionMs, 'ceil'))

    const startMode = m.startMode ?? 'auto'
    const anchor = Math.max(0, quantize(m.anchorMs ?? m.startMs ?? 0, config.precisionMs, 'round'))
    let startMs: number
    let clamped = false
    if (cyclicIds.has(id)) {
      startMs = anchor
      warnings.push(`依赖关系存在循环，任务 ${m.code ?? m.id} 保持原起始时间`)
    } else if (constraintMs === null) {
      startMs = anchor
    } else if (startMode === 'manual') {
      startMs = Math.max(anchor, constraintMs)
      clamped = startMs !== anchor
    } else {
      startMs = constraintMs
    }
    leafResult.set(id, {
      startMs,
      durationMs,
      constraintMs,
      clamped,
      predecessorIds: deps.map(d => d.fromId)
    })
  })

  // Pass 1.5 — hierarchical offset propagation (parent → child).
  // A sub-action carrying `offsetFromParentMs` does not use its own absolute
  // anchor: its start is the nearest action-like ancestor's resolved start plus
  // that offset. Because we resolve ancestors first, nested sub-actions chain
  // naturally. Moving the parent (manual edit OR dependency cascade) therefore
  // drags the whole sub-tree along. A predecessor constraint remains a hard
  // lower bound, so an offset can never place a sub-action before its required
  // predecessors.
  const rowById = new Map(rows.map(m => [m.id, m]))

  const ancestorActionStart = (id: string): number | null => {
    let cursor = rowById.get(id)?.parentId
    const seen = new Set<string>([id])
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const node = rowById.get(cursor)
      if (!node) return null
      if (node.kind === 'action' || node.kind === 'subaction') {
        const ancestor = leafResult.get(node.id)
        return ancestor ? ancestor.startMs : null
      }
      cursor = node.parentId
    }
    return null
  }

  const offsetRows = rows
    .filter(m => leafIds.has(m.id) && m.offsetFromParentMs !== undefined)
    .sort((a, b) => depthOf(a, rowById) - depthOf(b, rowById))
  offsetRows.forEach(m => {
    const result = leafResult.get(m.id)
    const parentStart = ancestorActionStart(m.id)
    if (!result || parentStart === null) return
    const base = parentStart + Math.round(m.offsetFromParentMs ?? 0)
    const startMs = result.constraintMs === null ? base : Math.max(base, result.constraintMs)
    const resolved = Math.max(0, startMs)
    result.clamped = result.clamped || (result.constraintMs !== null && result.constraintMs > base)
    result.startMs = resolved
  })

  // Pass 1.6 — action window containment (child → parent).
  // An action/sub-action that owns child sub-actions grows its duration just
  // enough to contain the whole sub-tree's final bounds. This runs AFTER offset
  // propagation and AFTER dependency constraints, so a parent that is `auto`
  // and has predecessors can no longer be pulled back and leave a child
  // sticking out. Fixed periods / roll-up rows are unaffected.
  const subtreeEnd = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    const own = leafResult.get(id)
    let end = own ? own.startMs + own.durationMs : 0
    ;(childMap.get(id) ?? []).forEach(child => { end = Math.max(end, subtreeEnd(child, seen)) })
    return end
  }
  const containingRows = rows
    .filter(m => leafIds.has(m.id) && (childMap.get(m.id)?.length ?? 0) > 0)
    .sort((a, b) => depthOf(b, rowById) - depthOf(a, rowById)) // deepest first: nested containment composes
  containingRows.forEach(m => {
    const result = leafResult.get(m.id)
    if (!result) return
    let maxEnd = result.startMs + result.durationMs
    ;(childMap.get(m.id) ?? []).forEach(child => { maxEnd = Math.max(maxEnd, subtreeEnd(child)) })
    const grown = Math.max(0, quantize(maxEnd - result.startMs, config.precisionMs, 'ceil'))
    if (grown > result.durationMs) result.durationMs = grown
  })

  // Pass 2 — roll descendant task bounds up through the hierarchy.
  const rollup = new Map<string, { startMs: number; endMs: number }>()
  const rollupOf = (id: string, guard = new Set<string>()): { startMs: number; endMs: number } => {
    if (rollup.has(id)) return rollup.get(id)!
    if (guard.has(id)) return { startMs: 0, endMs: 0 }
    guard.add(id)
    const own = leafResult.get(id)
    let start = own ? own.startMs : Number.POSITIVE_INFINITY
    let end = own ? own.startMs + own.durationMs : 0
    ;(childMap.get(id) ?? []).forEach(child => {
      const r = rollupOf(child, guard)
      if (r.endMs <= r.startMs) return
      start = Math.min(start, r.startMs)
      end = Math.max(end, r.endMs)
    })
    if (!Number.isFinite(start)) { start = 0; end = 0 }
    const result = { startMs: start, endMs: end }
    rollup.set(id, result)
    return result
  }
  rows.forEach(m => rollupOf(m.id))

  const scheduled: Record<string, ScheduledTask> = {}
  rows.forEach(m => {
    const isSummary = summaryIds.has(m.id)
    const r = rollup.get(m.id)!
    const leaf = leafResult.get(m.id)
    const startMs = isSummary ? r.startMs : (leaf?.startMs ?? r.startMs)
    const endMs = isSummary ? r.endMs : (leaf ? leaf.startMs + leaf.durationMs : r.endMs)
    const durationMs = Math.max(0, endMs - startMs)
    scheduled[m.id] = {
      id: m.id,
      code: m.code ?? m.id,
      module: m,
      kind: m.kind ?? 'action',
      isSummary,
      isLeaf: !isSummary,
      startMs,
      durationMs,
      endMs,
      rollupStartMs: r.startMs,
      rollupEndMs: r.endMs,
      startMode: m.startMode ?? 'auto',
      constraintMs: leaf?.constraintMs ?? null,
      clamped: leaf?.clamped ?? false,
      depth: depthOf(m, byRow),
      parentId: m.parentId ?? null,
      childIds: childMap.get(m.id) ?? [],
      predecessorIds: leaf?.predecessorIds ?? []
    }
  })

  const tasks = rows.map(m => scheduled[m.id])
  const byCode: Record<string, ScheduledTask> = {}
  tasks.forEach(t => { byCode[t.code] = t })

  return {
    tasks,
    byId: scheduled,
    byCode,
    order,
    cycles,
    successors,
    missingPredecessors,
    totalMs: tasks.reduce((max, t) => Math.max(max, t.endMs), 0),
    warnings,
    rootIds
  }
}

/**
 * Write the resolved schedule back onto the rows. The legacy grid, MP4, PDF and
 * CSV export read these mirrors, so they cannot disagree with the Gantt view
 * or the Excel sheet.
 */
export function syncLegacyFields(
  modules: ModuleData[],
  schedule: ScheduleResult,
  config: TimeConfig
): ModuleData[] {
  return modules.map(m => {
    const task = schedule.byId[m.id]
    if (!task) return m
    const scale = Math.max(1, config.scaleMs)
    return {
      ...m,
      kind: task.kind,
      startMs: task.startMs,
      anchorMs: task.module.anchorMs ?? task.startMs,
      durationMs: task.durationMs,
      endMs: task.endMs,
      startMode: task.startMode,
      calculatedStartX: task.startMs / scale,
      startX: m.startX,
      moveCount: task.durationMs / scale,
      duration: scale,
      isSequentialAction: (m.predecessors?.length ?? 0) > 0 && task.startMode === 'auto'
    }
  })
}

/** Human + machine readable dependency token: `T01:FS:+120` (ms). */
export function serializePredecessors(
  deps: Dependency[] | undefined,
  byId: Record<string, ScheduledTask>
): string {
  return (deps ?? [])
    .map(d => {
      const code = byId[d.fromId]?.code ?? d.fromId
      const lag = d.lagMs >= 0 ? `+${d.lagMs}` : `${d.lagMs}`
      return `${code}:${d.type}:${lag}`
    })
    .join('; ')
}

/** Parse the Excel/text token back into edges. `resolve` maps code -> id. */
export function parsePredecessors(
  text: string,
  resolve: (code: string) => string | undefined
): Dependency[] {
  if (!text || !text.trim()) return []
  return text.split(/[;,\n]/).map(part => part.trim()).filter(Boolean).flatMap(part => {
    const [code, rawType, rawLag] = part.split(':').map(s => s?.trim())
    if (!code) return []
    const id = resolve(code) ?? resolve(code.toUpperCase())
    if (!id) return []
    const type = (['FS', 'SS', 'FF', 'SF'].includes((rawType || '').toUpperCase())
      ? (rawType || 'FS').toUpperCase()
      : 'FS') as DependencyType
    const lagMs = Number.parseInt(rawLag ?? '0', 10)
    return [{ id: uuidv4(), fromId: id, type, lagMs: Number.isFinite(lagMs) ? lagMs : 0 }]
  })
}

/** All ids reachable downstream from `rootId`, for chain highlighting. */
export function collectSuccessorIds(schedule: ScheduleResult, rootId: string): Set<string> {
  const out = new Set<string>()
  const stack = [...(schedule.successors[rootId] ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(schedule.successors[id] ?? []))
  }
  return out
}

/** All ids upstream of `rootId`. */
export function collectPredecessorIds(schedule: ScheduleResult, rootId: string): Set<string> {
  const out = new Set<string>()
  const stack = [...(schedule.byId[rootId]?.predecessorIds ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(schedule.byId[id]?.predecessorIds ?? []))
  }
  return out
}
