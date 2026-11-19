import { useMemo } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { computeResourceSchedule } from '@/lib/resourceScheduler'
import { buildResourceOwnerIndex } from '@/lib/resourceTree'
import { expandCycles } from '@/lib/cycleEngine'
import { detectMechanismConflicts } from '@/lib/mechanismConflict'
import { normalizeTimeConfig } from '@/lib/timeScale'

/**
 * One derived view for every consumer that draws time.
 *
 * The store owns the authoring template; this hook projects it (single or
 * multi-cycle), schedules the projection and places resource claims on it.
 * Gantt bars, resource lanes and Excel rows therefore cannot disagree.
 */
export function useCycleView() {
  const project = useProjectStore(s => s.project)
  const modules = project?.modules
  const allocations = project?.allocations
  const resources = project?.resources
  const rawTime = project?.timeConfig
  const rawCycle = project?.cycleConfig

  const scaleMs = rawTime?.scaleMs
  const precisionMs = rawTime?.precisionMs
  const displayUnit = rawTime?.displayUnit

  const config = useMemo(
    () => normalizeTimeConfig({ scaleMs, precisionMs, displayUnit }),
    [scaleMs, precisionMs, displayUnit]
  )

  const expansion = useMemo(
    () => expandCycles(modules ?? [], allocations ?? [], rawCycle, config.precisionMs),
    [modules, allocations, rawCycle, config.precisionMs]
  )

  const expandedModules = expansion.modules
  const expandedAllocations = expansion.allocations
  const schedule = useMemo(
    () => computeSchedule(expandedModules, config),
    [expandedModules, config.scaleMs, config.precisionMs, config.displayUnit]
  )

  // Multi-cycle view keeps ONE row per template task and draws every cycle as
  // a separate bar on that row along the time axis. Row order/hierarchy must
  // therefore come from a schedule of the unprojected template, while bar
  // geometry still comes from the expanded schedule above.
  const templateSchedule = useMemo(
    () => (expansion.expanded ? computeSchedule(modules ?? [], config) : schedule),
    [expansion.expanded, modules, config, schedule]
  )

  // Flow-side ownership for the resource-centred view: reverse each mechanism
  // binding into a module → mechanism → resource tree. Built from the template
  // (not the projection) so ids and names are cycle-independent.
  const resourceOwners = useMemo(
    () => buildResourceOwnerIndex(modules ?? []),
    [modules]
  )

  // Occupation comes ONLY from claims explicitly authored on actions in the
  // flow Gantt. Mapping a resource to a module/mechanism is a hierarchy/grouping
  // hint (resourceOwners, used by ResourceLanes) — it must NOT turn every action
  // under that node into a busy window: an action uses a resource only when its
  // own claim says so, and only for the declared offset/duration.
  const resourceSchedule = useMemo(
    () => computeResourceSchedule(schedule, expandedAllocations, resources ?? []),
    [schedule, expandedAllocations, resources]
  )

  // Independent conflict dimension: one physical mechanism can only run one
  // action at a time. Detect overlapping leaf actions under the same mechanism
  // (or module fallback). Read-only projection, never changes timing.
  const mechanismConflicts = useMemo(
    () => detectMechanismConflicts(schedule),
    [schedule]
  )

  const totalMs = Math.max(schedule.totalMs, 1)

  return {
    project,
    config,
    expansion,
    schedule,
    templateSchedule,
    resourceSchedule,
    mechanismConflicts,
    resourceOwners,
    totalMs,
    expanded: expansion.expanded,
    cycleConfig: expansion.config
  }
}
