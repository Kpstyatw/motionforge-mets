import { TaskKind, ExcelLayoutConfig, TimeConfig } from '@/types'
import { ScheduleResult, TreeRow, hierarchyPath, serializePredecessors } from './dependencyEngine'
import { MODULE_COLORS } from '@/stores/useProjectStore'

/**
 * Pure half of the Excel conversion: the table model and layout maths. Kept
 * separate from `services/excelService.ts` (which pulls in ExcelJS) so the UI
 * can render and verify data without loading a megabyte of spreadsheet code.
 */

/**
 * Excel caps columns at 16384. One matrix column is now exactly one Gantt
 * time division (config.scaleMs), so the cap is a hard safety limit only.
 */
export const MATRIX_MAX_COLUMNS = 16000

export const COLUMN_KEYS = [
  'code', 'level', 'kind', 'module', 'mechanism', 'action', 'stage', 'resourceId',
  'startMs', 'anchorMs', 'offsetFromParentMs', 'durationMs', 'endMs', 'startMode', 'predecessors',
  'parentCode', 'path', 'color', 'id'
] as const

export type ColumnKey = typeof COLUMN_KEYS[number]

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  code: '编号',
  level: '层级',
  kind: '类型',
  module: '模块',
  mechanism: '机构',
  action: '动作/子动作',
  stage: '阶段',
  resourceId: '映射资源ID',
  startMs: '开始 (ms)',
  anchorMs: '锚定起始 (ms)',
  offsetFromParentMs: '相对父偏移 (ms)',
  durationMs: '持续 (ms)',
  endMs: '结束 (ms)',
  startMode: '起始模式',
  predecessors: '前置任务',
  parentCode: '上级编号',
  path: '层级路径',
  color: '颜色',
  id: 'ID'
}

export const KIND_LABELS: Record<TaskKind, string> = {
  module: '模块', mechanism: '机构', action: '动作', subaction: '子动作'
}

/** One row of sheet 1 — exactly the values shown on the Gantt chart. */
export interface ExcelTableRow {
  code: string
  level: number
  kind: TaskKind
  module: string
  mechanism: string
  action: string
  stage: string
  resourceId: string
  startMs: number
  anchorMs: number
  offsetFromParentMs: number
  durationMs: number
  endMs: number
  startMode: string
  predecessors: string
  parentCode: string
  path: string
  color: string
  id: string
}

export function buildExcelRows(schedule: ScheduleResult, rows: TreeRow[]): ExcelTableRow[] {
  return rows.map(({ task }) => {
    const path = hierarchyPath(schedule, task.id)
    const kind = task.kind
    return {
      code: task.code,
      level: task.depth + 1,
      kind,
      module: kind === 'module' ? task.module.moduleName : (path[0] ?? ''),
      mechanism: kind === 'mechanism' ? task.module.moduleName : (path[1] ?? ''),
      action: task.isSummary ? task.module.moduleName : task.module.actionDescription,
      stage: task.module.stage ?? '',
      resourceId: task.module.resourceId ?? '',
      startMs: task.startMs,
      anchorMs: task.module.anchorMs ?? task.startMs,
      offsetFromParentMs: task.module.offsetFromParentMs ?? 0,
      durationMs: task.durationMs,
      endMs: task.endMs,
      startMode: task.startMode,
      predecessors: serializePredecessors(task.module.predecessors, schedule.byId),
      parentCode: task.parentId ? (schedule.byId[task.parentId]?.code ?? '') : '',
      path: path.join(' / '),
      color: task.module.color ?? MODULE_COLORS[0],
      id: task.id
    }
  })
}

/**
 * Time span of one Excel matrix cell. By default it is exactly one Gantt time
 * division (`scaleMs`) so the sheet matches the UI ruler cell-for-cell; an
 * explicit `matrixStepMs` remains available as a legacy override.
 */
export function matrixStep(_totalMs: number, config: TimeConfig, layout: ExcelLayoutConfig): number {
  const scale = Math.max(1, Math.round(config.scaleMs))
  if (layout.matrixStepMs > 0) return Math.max(scale, Math.round(layout.matrixStepMs))
  return scale
}

export function excelFileName(projectName: string): string {
  const stem = (projectName || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'cycleview'
  return `${stem}-gantt.xlsx`
}
