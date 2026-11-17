/** Round-trip verification of the generated example workbook. */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { importGanttWorkbook } from '@/services/excelService'
import { computeSchedule } from '@/lib/dependencyEngine'
import { computeResourceSchedule } from '@/lib/resourceScheduler'

const path = resolve(process.cwd(), 'examples/化学发光免疫分析仪-动作时序甘特.xlsx')
const file = new File([readFileSync(path)], 'example.xlsx')
const result = await importGanttWorkbook(file)

if (!result.success) {
  console.error('IMPORT FAILED:', result.error)
  process.exit(1)
}

const schedule = computeSchedule(result.modules!, result.timeConfig!)
const rs = computeResourceSchedule(schedule, result.allocations!, result.resources!)

console.log('projectName:', result.projectName)
console.log('modules:', result.modules!.length, 'resources:', result.resources!.length,
  'allocations:', result.allocations!.length)
console.log('timeConfig:', result.timeConfig)
console.log('totalMs:', schedule.totalMs, 'warnings:', schedule.warnings.length)
console.log('lanes:', rs.lanes.length, 'placed:', rs.placed.length, 'conflicts:', rs.conflicts.length)
console.log('--- conflicts ---')
for (const c of rs.conflicts) {
  console.log(`  ${c.resourceName}: ${c.a.task.code}(${c.a.startMs}-${c.a.endMs}) × ` +
    `${c.b.task.code}(${c.b.startMs}-${c.b.endMs}) overlap ${c.overlapMs}ms @ ${c.overlapStartMs}-${c.overlapEndMs}`)
}
console.log('--- key timing (expect 1ms exact) ---')
for (const code of ['S02', 'S09', 'S12', 'S16', 'S25', 'S26', 'S27']) {
  const t = schedule.tasks.find(x => x.code === code)!
  console.log(`  ${code} ${t.module.actionDescription}: ${t.startMs} → ${t.endMs} (${t.durationMs}ms)`)
}
console.log('VERIFY OK')
