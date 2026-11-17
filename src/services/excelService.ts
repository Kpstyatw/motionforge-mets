import ExcelJS from 'exceljs'
import {
  CycleConfig, ExcelLayoutConfig, ModuleData, ProjectData, Resource, ResourceAllocation,
  TaskKind, TimeConfig
} from '@/types'
import { ScheduleResult, TreeRow, parsePredecessors } from '@/lib/dependencyEngine'
import {
  buildExcelRows, COLUMN_KEYS, COLUMN_LABELS, ColumnKey,
  KIND_LABELS, MATRIX_MAX_COLUMNS, matrixStep
} from '@/lib/excelModel'
import { DEFAULT_EXCEL_LAYOUT, DEFAULT_TIME_CONFIG, formatTime, normalizeTimeConfig } from '@/lib/timeScale'
import {
  collapseCycleProjection, cycleIndexOf, normalizeCycleConfig, templateIdOf
} from '@/lib/cycleEngine'
import { MODULE_COLORS } from '@/stores/useProjectStore'
import { v4 as uuidv4 } from 'uuid'

// Re-exported so callers/tests can keep importing the Excel API from one place.
export { buildExcelRows, excelFileName, matrixStep } from '@/lib/excelModel'
export type { ExcelTableRow } from '@/lib/excelModel'

/**
 * Gantt ⇄ Excel conversion.
 *
 * The workbook and the chart are generated from *the same* `ScheduleResult`.
 * Sheet 1 holds the exact integer-millisecond timing; sheet 2 is the chart
 * rendered as a time-bucket matrix (columns = time, rows = actions); sheet 3
 * carries the settings, hierarchy and dependency edges so the file can be
 * imported again without losing a millisecond.
 *
 * All row heights / column widths come from `ExcelLayoutConfig` and are
 * editable in the UI before export; they are written into sheet 3 too, so an
 * imported workbook restores the same cell sizes.
 */

const SHEET_TABLE = '动作时序'
const SHEET_MATRIX = '甘特矩阵'
const SHEET_META = '设置与依赖'
const SHEET_RESOURCES = '资源'
const SHEET_ALLOCATIONS = '资源占用'

export interface ExcelExportInput {
  project: ProjectData
  schedule: ScheduleResult
  /** Visible rows, i.e. `flattenTree(schedule, collapsedIds)`. */
  rows: TreeRow[]
  layout?: ExcelLayoutConfig
  /** Include rows hidden by collapse. Default false: table matches the chart. */
  includeHiddenRows?: boolean
  now?: Date
}

export interface ExcelImportResult {
  success: boolean
  modules?: ModuleData[]
  resources?: Resource[]
  allocations?: ResourceAllocation[]
  timeConfig?: TimeConfig
  cycleConfig?: CycleConfig
  excelLayout?: ExcelLayoutConfig
  projectName?: string
  error?: string
  warnings?: string[]
}

function argb(hex: string | undefined, fallback = 'FF3B82F6'): string {
  const clean = (hex ?? '').replace('#', '')
  return /^[0-9a-f]{6}$/i.test(clean) ? `FF${clean.toUpperCase()}` : fallback
}

function lighten(hex: string | undefined): string {
  const clean = (hex ?? '3b82f6').replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(clean)) return 'FFDCE6F1'
  const r = Math.min(255, Math.round(parseInt(clean.slice(0, 2), 16) * 0.45 + 255 * 0.55))
  const g = Math.min(255, Math.round(parseInt(clean.slice(2, 4), 16) * 0.45 + 255 * 0.55))
  const b = Math.min(255, Math.round(parseInt(clean.slice(4, 6), 16) * 0.45 + 255 * 0.55))
  return 'FF' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('text' in value) return String((value as { text: unknown }).text ?? '')
    if ('result' in value) return String((value as { result: unknown }).result ?? '')
    if ('richText' in value) return (value as { richText: Array<{ text: string }> }).richText.map(r => r.text).join('')
    if ('sharedFormula' in value) return ''
  }
  return ''
}

function cellNumber(value: ExcelJS.CellValue, fallback = 0): number {
  const n = Number.parseFloat(cellText(value))
  return Number.isFinite(n) ? n : fallback
}

function styleHeader(ws: ExcelJS.Worksheet, row: number, columns: number, layout: ExcelLayoutConfig) {
  ws.getRow(row).height = layout.headerHeight
  for (let c = 1; c <= columns; c++) {
    const cell = ws.getCell(row, c)
    cell.font = { bold: true, size: layout.fontSize, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5FE8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D9DF' } } }
  }
}

export async function buildGanttWorkbook(input: ExcelExportInput): Promise<Blob> {
  const { project, schedule } = input
  const layout: ExcelLayoutConfig = {
    ...DEFAULT_EXCEL_LAYOUT,
    ...(input.layout ?? project.excelLayout ?? {}),
    columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths, ...(input.layout ?? project.excelLayout)?.columnWidths }
  }
  const config = normalizeTimeConfig(project.timeConfig)
  const rows = input.includeHiddenRows
    ? schedule.tasks.map(t => ({ task: t, depth: t.depth, hasChildren: t.childIds.length > 0, collapsed: false }))
    : input.rows
  const tableRows = buildExcelRows(schedule, rows)

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'DYNMECH CycleView — Gantt Edition'
  workbook.created = input.now ?? new Date()

  // ---- Sheet 1: action timing table -------------------------------------
  const ws = workbook.addWorksheet(SHEET_TABLE, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = COLUMN_KEYS.map(key => ({
    header: COLUMN_LABELS[key],
    key,
    width: layout.columnWidths[key] ?? 14
  }))
  styleHeader(ws, 1, COLUMN_KEYS.length, layout)
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMN_KEYS.length } }

  tableRows.forEach(r => {
    const row = ws.addRow({
      ...r,
      kind: KIND_LABELS[r.kind],
      startMode: r.startMode === 'manual' ? '锁定' : '自动'
    })
    row.height = layout.rowHeight
    const isSummary = r.kind === 'module' || r.kind === 'mechanism'
    row.font = {
      size: layout.fontSize,
      bold: isSummary,
      color: { argb: isSummary ? 'FF1F5FE8' : 'FF12161B' }
    }
    const numericCols = new Set(['startMs', 'anchorMs', 'durationMs', 'endMs']
      .map(k => COLUMN_KEYS.indexOf(k as ColumnKey) + 1))
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.alignment = { vertical: 'middle', horizontal: numericCols.has(col) ? 'right' : 'left', indent: col === 6 ? r.level - 1 : 0 }
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } }
      if (numericCols.has(col)) cell.numFmt = '#,##0'
    })
    if (isSummary) {
      ws.getCell(row.number, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lighten(r.color) } }
    }
    // A subtle colour chip in the last-but-one column mirrors the chart legend.
    ws.getCell(row.number, COLUMN_KEYS.indexOf('color') + 1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: argb(r.color) }
    }
  })

  // ---- Sheet 2: the chart as a time-bucket matrix -----------------------
  const matrix = workbook.addWorksheet(SHEET_MATRIX, { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] })
  const stepMs = matrixStep(schedule.totalMs, config, layout)
  const bucketCount = Math.min(MATRIX_MAX_COLUMNS, Math.max(1, Math.ceil((schedule.totalMs + stepMs) / stepMs)))
  const headerValues: string[] = ['编号', '动作 / 子动作']
  for (let i = 0; i < bucketCount; i++) {
    headerValues.push(formatTime(i * stepMs, config))
  }
  matrix.columns = headerValues.map((header, i) => ({
    header,
    key: i === 0 ? 'code' : i === 1 ? 'action' : `t${i}`,
    width: i < 2 ? (i === 0 ? 12 : 26) : layout.matrixCellWidth
  }))
  styleHeader(matrix, 1, headerValues.length, layout)
  matrix.getRow(1).height = layout.headerHeight

  tableRows.forEach(r => {
    const row = matrix.addRow({ code: r.code, action: r.action })
    row.height = layout.matrixRowHeight
    row.font = { size: layout.fontSize, bold: r.kind === 'module' || r.kind === 'mechanism' }
    const fill = r.kind === 'module' || r.kind === 'mechanism' ? lighten(r.color) : argb(r.color)
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = i * stepMs
      const bucketEnd = bucketStart + stepMs
      const cell = row.getCell(i + 3)
      if (r.endMs > bucketStart && r.startMs < bucketEnd) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
        // Partial coverage is marked with a lighter tint, so the table still
        // shows that an action only used part of a bucket.
        if (r.startMs > bucketStart || r.endMs < bucketEnd) {
          cell.font = { size: layout.fontSize, color: { argb: 'FFFFFFFF' } }
          cell.value = '~'
        }
      }
      cell.border = { right: { style: 'hair', color: { argb: 'FFF0F1F3' } } }
    }
  })

  // ---- Sheet 3: settings + hierarchy + dependencies ---------------------
  const meta = workbook.addWorksheet(SHEET_META, { views: [{ state: 'frozen', ySplit: 1 }] })
  meta.columns = [
    { header: '区段', key: 'section', width: 16 },
    { header: '键 / 后置编号', key: 'key', width: 24 },
    { header: '值 / 前置编号', key: 'value', width: 30 },
    { header: '类型 / 延迟(ms)', key: 'extra', width: 22 },
    { header: '备注', key: 'note', width: 30 }
  ]
  styleHeader(meta, 1, 5, layout)
  const addMeta = (section: string, key: string, value: string | number, extra: string | number = '', note = '') => {
    const row = meta.addRow({ section, key, value, extra, note })
    row.height = layout.rowHeight
    row.font = { size: layout.fontSize }
  }
  const cycleCfg = normalizeCycleConfig(project.cycleConfig)
  const settings: Array<[string, string | number]> = [
    ['projectName', project.name],
    ['schemaVersion', '2'],
    ['scaleMs', config.scaleMs],
    ['precisionMs', config.precisionMs],
    ['displayUnit', config.displayUnit],
    ['cycleEnabled', cycleCfg.enabled ? 1 : 0],
    ['cycleMs', cycleCfg.cycleMs],
    ['cycleRepeats', cycleCfg.repeats],
    ['rowHeight', layout.rowHeight],
    ['headerHeight', layout.headerHeight],
    ['matrixCellWidth', layout.matrixCellWidth],
    ['matrixRowHeight', layout.matrixRowHeight],
    ['matrixStepMs', stepMs],
    ['fontSize', layout.fontSize],
    ['columnWidths', JSON.stringify(layout.columnWidths)],
    ['totalMs', schedule.totalMs],
    ['exportedAt', (input.now ?? new Date()).toISOString()]
  ]
  settings.forEach(([key, value]) => addMeta('设置', key, value))
  addMeta('说明', '甘特矩阵列宽(ms)', stepMs, '', '第 2 页每列代表的时间跨度；精确毫秒见第 1 页')
  addMeta('说明', '最小精度(ms)', config.precisionMs, '', '所有时刻均为该精度的整数倍')

  tableRows.forEach(r => {
    addMeta('层级', r.code, r.parentCode, KIND_LABELS[r.kind], r.path)
  })
  schedule.tasks.forEach(task => {
    ;(task.module.predecessors ?? []).forEach(dep => {
      addMeta('依赖', task.code, schedule.byId[dep.fromId]?.code ?? dep.fromId, `${dep.type} / ${dep.lagMs}`, dep.id)
    })
  })

  // ---- Sheet 4: global resource catalogue ------------------------------
  const resWs = workbook.addWorksheet(SHEET_RESOURCES, { views: [{ state: 'frozen', ySplit: 1 }] })
  resWs.columns = [
    { header: '资源ID', key: 'id', width: 24 },
    { header: '名称', key: 'name', width: 20 },
    { header: '类型', key: 'type', width: 16 },
    { header: '颜色', key: 'color', width: 14 },
    { header: '备注', key: 'notes', width: 30 }
  ]
  styleHeader(resWs, 1, 5, layout)
  project.resources.forEach(r => {
    const row = resWs.addRow({ id: r.id, name: r.name, type: r.type ?? '', color: r.color ?? '', notes: r.notes ?? '' })
    row.height = layout.rowHeight
    row.font = { size: layout.fontSize }
    if (r.color) resWs.getCell(row.number, 4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(r.color) } }
  })

  // ---- Sheet 5: exact-window claims (many-to-many) ---------------------
  const allocWs = workbook.addWorksheet(SHEET_ALLOCATIONS, { views: [{ state: 'frozen', ySplit: 1 }] })
  allocWs.columns = [
    { header: '占用ID', key: 'id', width: 24 },
    { header: '动作编号', key: 'taskCode', width: 14 },
    { header: '资源ID', key: 'resourceId', width: 24 },
    { header: '资源名称', key: 'resourceName', width: 18 },
    { header: '偏移(ms)', key: 'offsetMs', width: 12 },
    { header: '占用时长(ms)', key: 'durationMs', width: 16 },
    { header: '起(ms)', key: 'startMs', width: 12 },
    { header: '止(ms)', key: 'endMs', width: 12 },
    { header: '备注', key: 'notes', width: 24 }
  ]
  styleHeader(allocWs, 1, 9, layout)
  const resourceById = new Map(project.resources.map(r => [r.id, r]))
  project.allocations.forEach(a => {
    const task = schedule.byId[a.taskId]
    const row = allocWs.addRow({
      id: a.id,
      taskCode: task?.code ?? a.taskId,
      resourceId: a.resourceId,
      resourceName: resourceById.get(a.resourceId)?.name ?? a.resourceId,
      offsetMs: a.offsetMs,
      durationMs: a.durationMs,
      startMs: (task?.startMs ?? 0) + a.offsetMs,
      endMs: (task?.startMs ?? 0) + a.offsetMs + a.durationMs,
      notes: a.notes ?? ''
    })
    row.height = layout.rowHeight
    row.font = { size: layout.fontSize }
    ;[5, 6, 7, 8].forEach(c => { allocWs.getCell(row.number, c).numFmt = '#,##0' })
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
}

/** Read a workbook produced above (or a hand-edited one) back into the model. */
export async function importGanttWorkbook(file: File): Promise<ExcelImportResult> {
  const warnings: string[] = []
  try {
    const buffer = await file.arrayBuffer()
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)
    const ws = workbook.getWorksheet(SHEET_TABLE) ?? workbook.worksheets[0]
    if (!ws || ws.rowCount < 2) return { success: false, error: 'Excel 中没有可读取的动作时序数据' }

    // `Row.values` is sparse (index 0 is a hole). Array.from fills holes with
    // undefined, so findIndex never calls `.includes` on a missing header.
    const headers = Array.from(ws.getRow(1).values as ExcelJS.CellValue[])
      .map(v => cellText(v).trim())
    const findCol = (...names: string[]) => {
      const index = headers.findIndex(h => names.some(n => h === n || h.includes(n)))
      return index >= 0 ? index : -1
    }
    const col = {
      code: findCol('编号', 'code'),
      level: findCol('层级'),
      kind: findCol('类型', 'kind'),
      module: findCol('模块'),
      mechanism: findCol('机构'),
      action: findCol('动作/子动作', '动作'),
      stage: findCol('阶段'),
      startMs: findCol('开始 (ms)', '开始'),
      anchorMs: findCol('锚定起始', 'anchorMs'),
      durationMs: findCol('持续 (ms)', '持续'),
      endMs: findCol('结束 (ms)', '结束'),
      startMode: findCol('起始模式'),
      predecessors: findCol('前置任务'),
      parentCode: findCol('上级编号'),
      color: findCol('颜色'),
      id: findCol('ID')
    }
    if (col.code < 0 || col.action < 0) {
      return { success: false, error: '缺少「编号」或「动作/子动作」列' }
    }
    const get = (row: ExcelJS.Row, key: keyof typeof col): ExcelJS.CellValue => {
      const index = col[key]
      return index >= 0 ? row.getCell(index).value : ''
    }
    const text = (row: ExcelJS.Row, key: keyof typeof col) => cellText(get(row, key)).trim()
    const number = (row: ExcelJS.Row, key: keyof typeof col, fallback = 0) => cellNumber(get(row, key), fallback)

    interface Draft {
      code: string
      kind: TaskKind
      parentCode: string
      predecessorText: string
      node: ModuleData
    }
    const drafts: Draft[] = []
    const codeToId = new Map<string, string>()

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const rawCode = text(row, 'code')
      if (!rawCode) continue
      // A multi-cycle workbook holds one row per instance. Only @C1 rows are
      // authored data; later cycles are regenerated from CycleConfig on import.
      if (cycleIndexOf(rawCode) > 1 || cycleIndexOf(text(row, 'id')) > 1) continue
      const code = templateIdOf(rawCode)
      const rawKind = text(row, 'kind')
      const kind: TaskKind = rawKind.includes('模块') ? 'module'
        : rawKind.includes('机构') ? 'mechanism'
        : rawKind.includes('子动作') || rawKind.toLowerCase() === 'subaction' ? 'subaction'
        : 'action'
      const isSummary = kind === 'module' || kind === 'mechanism'
      const id = templateIdOf(text(row, 'id')) || uuidv4()
      codeToId.set(code, id)
      const startMs = Math.max(0, Math.round(number(row, 'startMs')))
      let durationMs = Math.max(0, Math.round(number(row, 'durationMs')))
      if (durationMs === 0 && col.endMs >= 0) {
        durationMs = Math.max(0, Math.round(number(row, 'endMs')) - startMs)
      }
      const moduleName = kind === 'module'
        ? (text(row, 'module') || text(row, 'action'))
        : kind === 'mechanism'
          ? (text(row, 'mechanism') || text(row, 'action'))
          : (text(row, 'mechanism') || text(row, 'module') || '机构 1')
      const actionDescription = isSummary ? (text(row, 'module') || text(row, 'mechanism') || text(row, 'action')) : text(row, 'action')
      const node: ModuleData = {
        id,
        code,
        kind,
        parentId: null,
        moduleName,
        actionDescription,
        stage: text(row, 'stage') || undefined,
        color: text(row, 'color') || MODULE_COLORS[drafts.length % MODULE_COLORS.length],
        startMs,
        anchorMs: Math.max(0, Math.round(number(row, 'anchorMs', startMs))),
        durationMs: isSummary ? 0 : durationMs,
        endMs: startMs + (isSummary ? 0 : durationMs),
        startMode: text(row, 'startMode').includes('锁定') ? 'manual' : 'auto',
        predecessors: [],
        startX: 0,
        calculatedStartX: 0,
        moveCount: isSummary ? 0 : durationMs,
        duration: 100,
        isSequentialAction: false
      }
      drafts.push({
        code,
        kind,
        parentCode: templateIdOf(text(row, 'parentCode')),
        predecessorText: text(row, 'predecessors'),
        node
      })
    }
    if (!drafts.length) return { success: false, error: 'Excel 中没有有效的数据行' }

    const resolve = (code: string) => {
      const stem = templateIdOf(code)
      return codeToId.get(code) ?? codeToId.get(code.toUpperCase())
        ?? codeToId.get(stem) ?? codeToId.get(stem.toUpperCase())
    }
    drafts.forEach(d => {
      if (d.parentCode) {
        const parentId = resolve(d.parentCode)
        if (parentId && parentId !== d.node.id) d.node.parentId = parentId
        else warnings.push(`上级编号 ${d.parentCode} 未找到，已作为顶层节点`)
      }
      d.node.predecessors = parsePredecessors(d.predecessorText, resolve)
        .filter(dep => dep.fromId !== d.node.id)
    })

    // Settings from sheet 3 (fall back to defaults).
    let timeConfig = normalizeTimeConfig(DEFAULT_TIME_CONFIG)
    let excelLayout: ExcelLayoutConfig = { ...DEFAULT_EXCEL_LAYOUT, columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths } }
    let cycleConfig = normalizeCycleConfig(undefined)
    let projectName: string | undefined
    const meta = workbook.getWorksheet(SHEET_META)
    if (meta) {
      const settings = new Map<string, string>()
      const extra = new Map<string, { depFrom: string; raw: string }[]>()
      for (let r = 2; r <= meta.rowCount; r++) {
        const row = meta.getRow(r)
        const section = cellText(row.getCell(1).value).trim()
        const key = cellText(row.getCell(2).value).trim()
        const value = cellText(row.getCell(3).value).trim()
        if (section === '设置') settings.set(key, value)
        if (section === '依赖' && key && value) {
          const stem = templateIdOf(key)
          const list = extra.get(stem) ?? []
          list.push({ depFrom: templateIdOf(value), raw: cellText(row.getCell(4).value).trim() })
          extra.set(stem, list)
        }
      }
      projectName = settings.get('projectName')
      timeConfig = normalizeTimeConfig({
        scaleMs: Number(settings.get('scaleMs') ?? DEFAULT_TIME_CONFIG.scaleMs),
        precisionMs: Number(settings.get('precisionMs') ?? DEFAULT_TIME_CONFIG.precisionMs),
        displayUnit: (settings.get('displayUnit') as TimeConfig['displayUnit']) || 'ms'
      })
      cycleConfig = normalizeCycleConfig({
        enabled: Number(settings.get('cycleEnabled') ?? 0) === 1,
        cycleMs: Number(settings.get('cycleMs') ?? 30_000),
        repeats: Number(settings.get('cycleRepeats') ?? 1)
      })
      excelLayout = {
        rowHeight: Number(settings.get('rowHeight') ?? excelLayout.rowHeight),
        headerHeight: Number(settings.get('headerHeight') ?? excelLayout.headerHeight),
        matrixCellWidth: Number(settings.get('matrixCellWidth') ?? excelLayout.matrixCellWidth),
        matrixRowHeight: Number(settings.get('matrixRowHeight') ?? excelLayout.matrixRowHeight),
        matrixStepMs: Number(settings.get('matrixStepMs') ?? 0),
        fontSize: Number(settings.get('fontSize') ?? excelLayout.fontSize),
        columnWidths: (() => {
          try { return { ...excelLayout.columnWidths, ...JSON.parse(settings.get('columnWidths') ?? '{}') } }
          catch { return excelLayout.columnWidths }
        })()
      }
      // Sheet 3 dependency rows are authoritative if present.
      if (extra.size > 0) {
        drafts.forEach(d => {
          const list = extra.get(d.code)
          if (!list) return
          d.node.predecessors = list.flatMap(item => {
            const id = resolve(item.depFrom)
            if (!id || id === d.node.id) return []
            const [typeRaw, lagRaw] = item.raw.split('/').map(s => s?.trim())
            return [{
              id: uuidv4(),
              fromId: id,
              type: (['FS', 'SS', 'FF', 'SF'].includes(typeRaw) ? typeRaw : 'FS') as 'FS' | 'SS' | 'FF' | 'SF',
              lagMs: Number.parseInt(lagRaw ?? '0', 10) || 0
            }]
          })
        })
      }
    }

    // Legacy mirror fields so the grid/PDF/MP4 exporters stay in sync.
    drafts.forEach(d => {
      d.node.startX = (d.node.startMs ?? 0) / Math.max(1, timeConfig.scaleMs)
      d.node.calculatedStartX = d.node.startX
      d.node.moveCount = (d.node.durationMs ?? 0) / Math.max(1, timeConfig.scaleMs)
      d.node.duration = timeConfig.scaleMs
    })

    // ---- Resources & allocations from sheets 4/5 -----------------------
    const resources: Resource[] = []
    const resWs = workbook.getWorksheet(SHEET_RESOURCES)
    if (resWs) {
      for (let r = 2; r <= resWs.rowCount; r++) {
        const row = resWs.getRow(r)
        const id = cellText(row.getCell(1).value).trim()
        const name = cellText(row.getCell(2).value).trim()
        if (!name && !id) continue
        resources.push({
          id: id || uuidv4(),
          name: name || id,
          type: cellText(row.getCell(3).value).trim() || undefined,
          color: cellText(row.getCell(4).value).trim() || undefined,
          notes: cellText(row.getCell(5).value).trim() || undefined
        })
      }
    }
    const allocations: ResourceAllocation[] = []
    const allocWs = workbook.getWorksheet(SHEET_ALLOCATIONS)
    if (allocWs) {
      const resourceByKey = new Map<string, string>()
      resources.forEach(rs => { resourceByKey.set(rs.id, rs.id); resourceByKey.set(rs.name, rs.id) })
      for (let r = 2; r <= allocWs.rowCount; r++) {
        const row = allocWs.getRow(r)
        const rawTaskCode = cellText(row.getCell(2).value).trim()
        if (cycleIndexOf(rawTaskCode) > 1) continue
        const taskCode = templateIdOf(rawTaskCode)
        const resourceKey = cellText(row.getCell(3).value).trim() || cellText(row.getCell(4).value).trim()
        const taskId = resolve(taskCode)
        const resourceId = resourceByKey.get(resourceKey)
        const offsetMs = Math.max(0, Math.round(cellNumber(row.getCell(5).value)))
        const durationMs = Math.max(0, Math.round(cellNumber(row.getCell(6).value)))
        if (!taskId || !resourceId || durationMs <= 0) {
          if (taskCode || resourceKey) warnings.push(`占用行 ${r} 的动作或资源未找到，已跳过`)
          continue
        }
        allocations.push({
          id: templateIdOf(cellText(row.getCell(1).value).trim()) || uuidv4(),
          taskId,
          resourceId,
          offsetMs,
          durationMs,
          notes: cellText(row.getCell(9).value).trim() || undefined
        })
      }
    }

    const folded = collapseCycleProjection(drafts.map(d => d.node), allocations)
    if (folded.dropped > 0) {
      warnings.push(`已折叠 ${folded.dropped} 行周期实例为模板，按周期配置重新展开`)
    }

    return {
      success: true,
      modules: folded.modules,
      resources,
      allocations: folded.allocations,
      timeConfig,
      cycleConfig,
      excelLayout,
      projectName,
      warnings
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
