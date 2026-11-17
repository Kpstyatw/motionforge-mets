import { useMemo } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { computeResourceSchedule } from '@/lib/resourceScheduler'
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

  const resourceSchedule = useMemo(
    () => computeResourceSchedule(schedule, expandedAllocations, resources ?? []),
    [schedule, expandedAllocations, resources]
  )

  const totalMs = Math.max(schedule.totalMs, 1)

  return {
    project,
    config,
    expansion,
    schedule,
    resourceSchedule,
    totalMs,
    expanded: expansion.expanded,
    cycleConfig: expansion.config
  }
}
