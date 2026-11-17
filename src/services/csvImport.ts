import Papa from 'papaparse'
import { ModuleData, TaskKind, TimeConfig } from '@/types'
import { v4 as uuidv4 } from 'uuid'
import { MODULE_COLORS } from '@/stores/useProjectStore'
import { DEFAULT_TIME_CONFIG, quantize } from '@/lib/timeScale'
import { parsePredecessors } from '@/lib/dependencyEngine'

/**
 * CSV import, extended for the Gantt edition.
 *
 * Upstream five columns (`module,action,startPosition,moveCount,duration`) are
 * still accepted verbatim — they are automatically expanded into the four-level
 * hierarchy 模块(stage) → 机构(module) → 动作(action) → 子动作(subaction → ...).
 *
 * New optional columns carry the full canonical model:
 *   code, kind, parentCode, startMs, durationMs, startMode, predecessors,
 *   scaleMs, precisionMs
 * `kind` present => rows already describe a hierarchy (Excel/CSV round-trip),
 * so no summary rows are synthesised. Without it => legacy auto-hierarchy.
 * `predecessors` uses `CODE:TYPE:+lagMs` tokens, e.g. `T01:FS:+120; T02:SS:0`.
 */

export interface CSVRow {
  module: string
  action: string
  startPosition: string | number
  moveCount: string | number
  duration: string | number
  intervalTime?: string | number
  stage?: string
  id?: string
  code?: string
  kind?: string
  parentCode?: string
  startMs?: string | number
  anchorMs?: string | number
  durationMs?: string | number
  startMode?: string
  predecessors?: string
  color?: string
  scaleMs?: string | number
  precisionMs?: string | number
}

export interface CSVImportResult {
  success: boolean
  data?: ModuleData[]
  timeConfig?: Partial<TimeConfig>
  error?: string
  rowErrors?: Array<{ row: number; message: string }>
}

const num = (value: unknown, fallback = 0): number => {
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

const VALID_KINDS: TaskKind[] = ['module', 'mechanism', 'action', 'subaction']

export async function importCSVFile(file: File): Promise<CSVImportResult> {
  return new Promise(resolve => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: results => {
        const { data, errors } = results
        if (errors.length > 0) {
          resolve({
            success: false,
            error: 'CSV parsing errors occurred',
            rowErrors: errors.map(e => ({ row: e.row || 0, message: e.message }))
          })
          return
        }
        resolve(validateAndTransformData(data as CSVRow[]))
      },
      error: error => resolve({ success: false, error: `Failed to parse CSV: ${error.message}` })
    })
  })
}

function makeNode(partial: Partial<ModuleData> & { id: string; code: string; kind: TaskKind }): ModuleData {
  return {
    moduleName: '',
    actionDescription: '',
    startX: 0,
    calculatedStartX: 0,
    moveCount: 0,
    duration: 100,
    startMs: 0,
    durationMs: 0,
    endMs: 0,
    startMode: 'auto',
    parentId: null,
    predecessors: [],
    ...partial
  }
}

function validateAndTransformData(rows: CSVRow[]): CSVImportResult {
  const rowErrors: Array<{ row: number; message: string }> = []
  if (rows.length === 0) return { success: false, error: 'CSV file is empty' }

  const firstRow = rows[0] as unknown as Record<string, unknown>
  const requiredColumns = ['module', 'action', 'startPosition', 'moveCount']
  const missingColumns = requiredColumns.filter(col => !(col in firstRow))
  if (!('duration' in firstRow) && !('intervalTime' in firstRow) && !('durationMs' in firstRow)) {
    missingColumns.push('duration')
  }
  if (missingColumns.length > 0) {
    return {
      success: false,
      error: `Missing required columns: ${missingColumns.join(', ')}. Expected format: module,action,startPosition,moveCount,duration`
    }
  }

  const scaleMs = Math.max(1, Math.round(num(firstRow.scaleMs, DEFAULT_TIME_CONFIG.scaleMs)))
  const precisionMs = Math.max(1, Math.min(scaleMs, Math.round(num(firstRow.precisionMs, DEFAULT_TIME_CONFIG.precisionMs))))
  const timeConfig: Partial<TimeConfig> = { scaleMs, precisionMs, displayUnit: 'ms' }
  const hasExplicitHierarchy = 'kind' in firstRow

  const moduleColorMap: Record<string, string> = {}
  const uniqueModuleNames = [...new Set(rows.map(r => String(r.module ?? '').trim() || ''))]
  uniqueModuleNames.forEach((name, index) => {
    if (name) moduleColorMap[name] = MODULE_COLORS[index % MODULE_COLORS.length]
  })

  const modules: ModuleData[] = []
  let codeCounter = 0
  const nextCode = () => `T${String(++codeCounter).padStart(2, '0')}`
  const codeToId = new Map<string, string>()

  // Reserve codes/ids from the file first so parentCode and predecessor
  // references can be resolved regardless of row order. Legacy files get a
  // generated code per output row instead.
  const rowCodeByIndex: string[] = []
  const rowIdByIndex: string[] = []
  if (hasExplicitHierarchy) {
    rows.forEach((row, index) => {
      const code = String(row.code ?? '').trim() || nextCode()
      const id = String(row.id ?? '').trim() || uuidv4()
      rowCodeByIndex[index] = code
      rowIdByIndex[index] = id
      codeToId.set(code, id)
    })
  }

  const parseRow = (row: CSVRow, index: number, forcedKind?: TaskKind, forcedParent?: string | null): ModuleData | null => {
    const rowNumber = index + 2
    const moduleName = String(row.module ?? '').trim()
    const action = String(row.action ?? '').trim()
    if (!moduleName && !forcedKind) { rowErrors.push({ row: rowNumber, message: 'Module name is required' }); return null }
    if (!action && !forcedKind) { rowErrors.push({ row: rowNumber, message: 'Action description is required' }); return null }

    const startX = num(row.startPosition, 0)
    const moveCount = num(row.moveCount, 0)
    const cellMs = num(row.duration ?? row.intervalTime, scaleMs)
    if (startX < 0 || moveCount < 0 || cellMs <= 0) {
      rowErrors.push({ row: rowNumber, message: 'startPosition/moveCount must be >= 0 and duration > 0' })
      return null
    }
    const rawKind = String(row.kind ?? '').trim() as TaskKind
    const kind: TaskKind = forcedKind ?? (VALID_KINDS.includes(rawKind) ? rawKind : 'action')
    const isSummary = kind === 'module' || kind === 'mechanism'
    const durationMs = isSummary ? 0 : (
      row.durationMs !== undefined && row.durationMs !== ''
        ? Math.max(0, quantize(num(row.durationMs, moveCount * cellMs), precisionMs, 'ceil'))
        : Math.max(0, quantize(moveCount * cellMs, precisionMs, 'ceil'))
    )
    const startMs = isSummary ? 0 : (
      row.startMs !== undefined && row.startMs !== ''
        ? Math.max(0, quantize(num(row.startMs, startX * cellMs), precisionMs, 'round'))
        : Math.max(0, quantize(startX * cellMs, precisionMs, 'round'))
    )
    const code = rowCodeByIndex[index] ?? (!forcedKind ? nextCode() : `T${String(index + 1).padStart(2, '0')}`)
    return makeNode({
      id: rowIdByIndex[index] ?? codeToId.get(code) ?? uuidv4(),
      code,
      kind,
      parentId: forcedParent ?? null,
      moduleName,
      actionDescription: action,
      startX: Math.floor(startX),
      calculatedStartX: startMs / scaleMs,
      moveCount,
      duration: cellMs,
      stage: String(row.stage ?? '').trim() || undefined,
      color: String(row.color ?? '').trim() || moduleColorMap[moduleName],
      startMs,
      anchorMs: row.anchorMs !== undefined && row.anchorMs !== ''
        ? Math.max(0, quantize(num(row.anchorMs, startMs), precisionMs, 'round'))
        : startMs,
      durationMs,
      endMs: startMs + durationMs,
      startMode: row.startMode === 'manual' ? 'manual' : 'auto',
      predecessors: []
    })
  }

  if (hasExplicitHierarchy) {
    rows.forEach((row, index) => {
      const node = parseRow(row, index)
      if (node) modules.push(node)
    })
  } else {
    // Legacy CSV -> synthesise 模块(stage) → 机构(module) → 动作(action).
    const moduleNodes = new Map<string, string>()
    const mechanismNodes = new Map<string, string>()
    rows.forEach((row, index) => {
      const stage = String(row.stage ?? '').trim() || '整机循环'
      rowCodeByIndex[index] = nextCode()
      const mechanism = String(row.module ?? '').trim()
      if (!moduleNodes.has(stage)) {
        const node = makeNode({
          id: uuidv4(), code: nextCode(), kind: 'module',
          moduleName: stage, actionDescription: stage,
          color: MODULE_COLORS[moduleNodes.size % MODULE_COLORS.length]
        })
        moduleNodes.set(stage, node.id)
        modules.push(node)
      }
      const mechKey = `${stage}::${mechanism}`
      if (!mechanismNodes.has(mechKey)) {
        const node = makeNode({
          id: uuidv4(), code: nextCode(), kind: 'mechanism',
          parentId: moduleNodes.get(stage) ?? null,
          moduleName: mechanism, actionDescription: mechanism,
          color: moduleColorMap[mechanism]
        })
        mechanismNodes.set(mechKey, node.id)
        modules.push(node)
      }
      const actionNode = parseRow(row, index, 'action', mechanismNodes.get(mechKey) ?? null)
      if (actionNode) {
        actionNode.code = rowCodeByIndex[index]
        actionNode.id = uuidv4()
        codeToId.set(actionNode.code, actionNode.id)
        modules.push(actionNode)
      }
    })
  }

  if (rowErrors.length > 0) return { success: false, error: 'Validation errors found in CSV data', rowErrors }
  if (modules.length === 0) return { success: false, error: 'No valid data found in CSV file' }

  // Resolve hierarchy + dependency edges.
  const byCode = new Map(modules.map(m => [m.code!, m.id]))
  const resolve = (code: string) => byCode.get(code) ?? codeToId.get(code)
  rows.forEach((row, index) => {
    // Lookup by reserved code: legacy files have summary rows inserted, so
    // input row indices do not line up with output rows.
    const code = rowCodeByIndex[index] ?? String(row.code ?? '').trim()
    const target = modules.find(m => m.code === code)
    if (!target) return
    if (hasExplicitHierarchy) {
      const parentCode = String(row.parentCode ?? '').trim()
      if (parentCode) {
        const parentId = resolve(parentCode)
        if (parentId && parentId !== target.id) target.parentId = parentId
      }
    }
    if (row.predecessors) {
      target.predecessors = parsePredecessors(String(row.predecessors), resolve)
        .filter(d => d.fromId !== target.id)
    }
  })

  return { success: true, data: modules, timeConfig }
}

export function defaultTimeConfigFromCsv(result: CSVImportResult): Partial<TimeConfig> {
  return result.timeConfig ?? DEFAULT_TIME_CONFIG
}
