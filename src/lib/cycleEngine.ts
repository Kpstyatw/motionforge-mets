import { CycleConfig, ModuleData, ResourceAllocation } from '@/types'

/**
 * Cycle projection engine — pure, DOM-free, unit-testable.
 *
 * The project always stores ONE authoring template. A fixed-period machine
 * (e.g. a 30 s CLIA cycle) is represented by `CycleConfig`; `expandCycles`
 * projects the template into N read-only instances with `@C1`, `@C2`, … ids.
 * Every instance keeps its own copy of the hierarchy, dependency edges and
 * resource claims, so the existing scheduler and conflict detector work
 * unchanged — including conflicts BETWEEN different cycles.
 *
 * Editing never targets an instance: `templateIdOf()` maps it back to the
 * template row, so one edit updates all projected cycles at once.
 */

export const CYCLE_SUFFIX = /@C(\d+)$/i
export const DEFAULT_CYCLE_CONFIG: CycleConfig = {
  enabled: false,
  cycleMs: 30_000,
  repeats: 3
}
export const MAX_CYCLE_REPEATS = 50

export function normalizeCycleConfig(input?: Partial<CycleConfig> | null): CycleConfig {
  const raw = { ...DEFAULT_CYCLE_CONFIG, ...(input ?? {}) }
  const cycleMs = Math.max(1, Math.round(Number(raw.cycleMs) || DEFAULT_CYCLE_CONFIG.cycleMs))
  const repeats = Math.min(
    MAX_CYCLE_REPEATS,
    Math.max(1, Math.round(Number(raw.repeats) || 1))
  )
  return { enabled: Boolean(raw.enabled), cycleMs, repeats }
}

/** True when the projection should show more than one cycle. */
export function isMultiCycle(input?: Partial<CycleConfig> | null): boolean {
  const cfg = normalizeCycleConfig(input)
  return cfg.enabled && cfg.repeats > 1
}

export function instanceId(templateId: string, cycle: number): string {
  return `${templateId}@C${cycle}`
}

export function instanceCode(code: string, cycle: number): string {
  return `${code || 'T'}@C${cycle}`
}

/** Strip a trailing `@Cn` from an instance id / code / allocation id. */
export function templateIdOf(value: string): string {
  return String(value ?? '').replace(CYCLE_SUFFIX, '')
}

/** 1 for template rows and `@C1`; n for an `@Cn` instance. */
export function cycleIndexOf(value: string): number {
  const match = String(value ?? '').match(CYCLE_SUFFIX)
  return match ? Number(match[1]) : 1
}

export interface CycleExpansion {
  /** Resolved config actually used for this projection. */
  config: CycleConfig
  /** Whether more than one cycle is visible. */
  expanded: boolean
  /** Modules to schedule: template itself, or the generated instances. */
  modules: ModuleData[]
  /** Allocations to place: template itself, or the generated instances. */
  allocations: ResourceAllocation[]
  instanceToTemplate: Record<string, string>
  templateToInstances: Record<string, string[]>
  /** 0, cycleMs, 2*cycleMs … repeats*cycleMs — for ruler separators. */
  boundaries: number[]
  /** Template tasks that run past one cycle boundary. */
  warnings: string[]
}

/** Identity projection used in single-cycle mode. */
function singleCycle(
  config: CycleConfig,
  modules: ModuleData[],
  allocations: ResourceAllocation[],
  warnings: string[]
): CycleExpansion {
  return {
    config,
    expanded: false,
    modules,
    allocations,
    instanceToTemplate: Object.fromEntries(modules.map(m => [m.id, m.id])),
    templateToInstances: Object.fromEntries(modules.map(m => [m.id, [m.id]])),
    boundaries: [0, config.cycleMs],
    warnings
  }
}

/**
 * Project the authoring template into `config.repeats` cycles.
 *
 * All ms values on the template are already resolved by the store. Each
 * instance simply shifts by (cycle-1)*cycleMs; dependencies and resource
 * offsets are copied, not recomputed, so a cycle change never drifts.
 */
export function expandCycles(
  modules: ModuleData[],
  allocations: ResourceAllocation[],
  input: CycleConfig | Partial<CycleConfig> | undefined,
  precisionMs = 1
): CycleExpansion {
  const config = normalizeCycleConfig(input)
  const quantum = Math.max(1, Math.round(precisionMs))
  const cycleMs = Math.max(quantum, Math.round(config.cycleMs / quantum) * quantum)

  const warnings: string[] = []
  const templateIds = new Set(modules.map(m => m.id))
  modules.forEach(m => {
    if (m.kind === 'module' || m.kind === 'mechanism') return
    const end = m.endMs ?? (m.startMs ?? 0) + (m.durationMs ?? 0)
    if (end > cycleMs) {
      warnings.push(`任务 ${m.code ?? m.id} 结束于 ${end}ms，超出周期 ${cycleMs}ms ${end - cycleMs}ms`)
    }
  })

  if (!config.enabled || config.repeats <= 1) {
    return singleCycle({ ...config, cycleMs }, modules, allocations, warnings)
  }

  const expandedModules: ModuleData[] = []
  const expandedAllocations: ResourceAllocation[] = []
  const instanceToTemplate: Record<string, string> = {}
  const templateToInstances: Record<string, string[]> = {}
  const boundaries: number[] = []

  for (let cycle = 1; cycle <= config.repeats; cycle++) {
    const shift = (cycle - 1) * cycleMs
    boundaries.push(shift)

    for (const m of modules) {
      const id = instanceId(m.id, cycle)
      const parentId = m.parentId && templateIds.has(m.parentId)
        ? instanceId(m.parentId, cycle)
        : m.parentId ?? null
      const predecessors = (m.predecessors ?? []).map(dep => ({
        ...dep,
        id: `${dep.id}@C${cycle}`,
        fromId: templateIds.has(dep.fromId) ? instanceId(dep.fromId, cycle) : dep.fromId
      }))
      const startMs = Math.max(0, (m.startMs ?? 0) + shift)
      const anchorMs = Math.max(0, (m.anchorMs ?? m.startMs ?? 0) + shift)
      const durationMs = Math.max(0, m.durationMs ?? 0)
      expandedModules.push({
        ...m,
        id,
        code: instanceCode(m.code ?? m.id, cycle),
        parentId,
        predecessors,
        startMs,
        anchorMs,
        endMs: startMs + durationMs,
        startX: m.startX + shift / Math.max(1, m.duration || 1),
        calculatedStartX: (m.calculatedStartX ?? m.startX) + shift / Math.max(1, m.duration || 1),
        cycleIndex: cycle,
        cycleTemplateId: m.id
      })
      instanceToTemplate[id] = m.id
      ;(templateToInstances[m.id] ??= []).push(id)
    }

    for (const a of allocations) {
      if (!templateIds.has(a.taskId)) continue
      expandedAllocations.push({
        ...a,
        id: `${a.id}@C${cycle}`,
        taskId: instanceId(a.taskId, cycle),
        notes: a.notes
      })
    }
  }
  boundaries.push(config.repeats * cycleMs)

  return {
    config: { ...config, cycleMs },
    expanded: true,
    modules: expandedModules,
    allocations: expandedAllocations,
    instanceToTemplate,
    templateToInstances,
    boundaries,
    warnings
  }
}

/**
 * Fold a projected row set back to its authoring template. Used on Excel
 * import: a workbook may contain @C1/@C2… rows, but the project stores only
 * one template and re-projects it from CycleConfig.
 */
export function collapseCycleProjection(
  modules: ModuleData[],
  allocations: ResourceAllocation[]
): { modules: ModuleData[]; allocations: ResourceAllocation[]; kept: number; dropped: number } {
  const templateRows = modules.filter(m => cycleIndexOf(m.id) <= 1 && cycleIndexOf(m.code ?? '') <= 1)
  const dropped = modules.length - templateRows.length
  const stripped = templateRows.map(m => ({
    ...m,
    id: templateIdOf(m.id),
    code: templateIdOf(m.code ?? m.id),
    parentId: m.parentId ? templateIdOf(m.parentId) : null,
    predecessors: (m.predecessors ?? []).map(d => ({
      ...d,
      id: templateIdOf(d.id),
      fromId: templateIdOf(d.fromId)
    })),
    cycleIndex: undefined,
    cycleTemplateId: undefined
  }))
  const keptIds = new Set(stripped.map(m => m.id))
  const templateAllocations = allocations
    .filter(a => cycleIndexOf(a.id) <= 1 && cycleIndexOf(a.taskId) <= 1)
    .map(a => ({ ...a, id: templateIdOf(a.id), taskId: templateIdOf(a.taskId) }))
    .filter(a => keptIds.has(a.taskId))
  return {
    modules: stripped,
    allocations: templateAllocations,
    kept: stripped.length,
    dropped
  }
}
