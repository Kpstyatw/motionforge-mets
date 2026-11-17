import { ModuleData, TimeConfig } from '@/types'
import { normalizeTimeConfig } from './timeScale'
import { computeSchedule } from './dependencyEngine'

/**
 * Timing model — the single source of truth for *when* each action runs.
 *
 * In the Gantt edition this module is a thin read-only facade over
 * `dependencyEngine.computeSchedule`. The store resolves the schedule once per
 * mutation and writes `startMs` / `durationMs` / `endMs` back onto every row,
 * so the timeline, canvas overlay, MP4 exporter, PDF report, Gantt view and
 * Excel sheet all read the same integers. No cell-count arithmetic here: that
 * was the old model and it could not represent a millisecond.
 */

export interface ModuleGroup {
  name: string
  modules: ModuleData[]
}

/** Group modules by name, preserving first-seen order. */
export function groupModulesByName(modules: ModuleData[]): ModuleGroup[] {
  const groups: Record<string, ModuleData[]> = {}
  modules.forEach(module => {
    if (!groups[module.moduleName]) groups[module.moduleName] = []
    groups[module.moduleName].push(module)
  })
  return Object.entries(groups).map(([name, groupModules]) => ({ name, modules: groupModules }))
}

/** Canonical start (ms) of one action. */
export function startMsOf(module: ModuleData): number {
  if (module.startMs !== undefined && Number.isFinite(module.startMs)) return module.startMs
  // Legacy fallback for rows that never went through the store.
  return (module.calculatedStartX ?? module.startX) * (module.duration || 1)
}

/** Canonical duration (ms) of one action. */
export function durationMsOf(module: ModuleData): number {
  if (module.durationMs !== undefined && Number.isFinite(module.durationMs)) return module.durationMs
  return module.moveCount * (module.duration || 1)
}

export function endMsOf(module: ModuleData): number {
  return startMsOf(module) + durationMsOf(module)
}

/**
 * Start time (ms) of every action within one module group. Retained for the
 * canvas renderer, the PDF report and the stage progress bars.
 */
export function computeActionStartTimes(groupModules: ModuleData[]): number[] {
  return groupModules.map(startMsOf)
}

/** Wall-clock length of the whole cycle, in milliseconds. */
export function computeTotalDurationMs(modules: ModuleData[]): number {
  return modules.reduce((max, m) => Math.max(max, endMsOf(m)), 0)
}

/** Resolved schedule, for callers that need dependency information too. */
export function resolveSchedule(modules: ModuleData[], config?: Partial<TimeConfig>) {
  return computeSchedule(modules, config)
}

/** Bounding box, in grid columns and row indices, of the cells being painted right now. */
export interface ActiveRegion {
  minCol: number
  maxCol: number
  minRow: number
  maxRow: number
}

/**
 * Which grid columns are in progress at `currentFrame` ms. Columns are
 * `floor(ms / scaleMs)`, so the follow camera keeps working unchanged while
 * the underlying timeline is millisecond-accurate.
 */
export function computeActiveRegion(
  modules: ModuleData[],
  currentFrame: number,
  scaleMs = 100
): ActiveRegion | null {
  const step = Math.max(1, scaleMs)
  const rowOf = new Map<ModuleData, number>()
  modules.forEach((module, index) => rowOf.set(module, index))

  let region: ActiveRegion | null = null
  modules.forEach((module, row) => {
    const start = startMsOf(module)
    const duration = durationMsOf(module)
    const end = start + duration
    if (duration <= 0 || currentFrame < start || currentFrame >= end) return
    const col = Math.floor((start + Math.min(currentFrame - start, duration)) / step)
    region = region
      ? {
          minCol: Math.min(region.minCol, col),
          maxCol: Math.max(region.maxCol, col),
          minRow: Math.min(region.minRow, row),
          maxRow: Math.max(region.maxRow, row)
        }
      : { minCol: col, maxCol: col, minRow: row, maxRow: row }
  })
  return region
}

/** Time in ms at the centre of a grid column (used by the follow camera). */
export function columnToMs(col: number, config?: Partial<TimeConfig>): number {
  return col * normalizeTimeConfig(config).scaleMs
}
