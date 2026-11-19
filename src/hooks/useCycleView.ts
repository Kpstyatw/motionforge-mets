import { useMemo } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { computeResourceSchedule } from '@/lib/resourceScheduler'
import { deriveMechanismAllocations } from '@/lib/resourceTree'
import { expandCycles } from '@/lib/cycleEngine'
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

  // Mechanism-bound resources generate auto claims from their descendant
  // actions. Derived in the view layer only — project.allocations stays the
  // single authored truth, so nothing is duplicated or persisted twice.
  const resourceSchedule = useMemo(() => {
    const autoClaims = deriveMechanismAllocations(schedule)
    return computeResourceSchedule(schedule, [...expandedAllocations, ...autoClaims], resources ?? [])
  }, [schedule, expandedAllocations, resources])

  const totalMs = Math.max(schedule.totalMs, 1)

  return {
    project,
    config,
    expansion,
    schedule,
    templateSchedule,
    resourceSchedule,
    totalMs,
    expanded: expansion.expanded,
    cycleConfig: expansion.config
  }
}
