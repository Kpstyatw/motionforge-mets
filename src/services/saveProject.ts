import { ProjectData, ProjectFileFormat } from '@/types'
import { TreeRow, ScheduleResult } from '@/lib/dependencyEngine'
import { SourceFile } from '@/stores/useProjectStore'
import { bytesToBase64 } from '@/lib/binary'
import { buildProjectCSV, downloadBlob } from '@/services/exportService'
import { IS_ONLINE } from '@/lib/platform'
import { buildProjectJson, normalizeProjectSnapshot } from '@/services/jsonProject'

/**
 * One-click save of the current project.
 *
 * All three formats are generated from the same canonical ProjectData
 * snapshot, so JSON / CSV / Excel carry the same modules, dependencies,
 * resources, allocations, cycle settings and layout settings. Desktop writes
 * straight back to the associated file when its format matches; Save As and
 * new projects use the default format from Preferences.
 */
export interface SaveProjectInput {
  project: ProjectData
  schedule: ScheduleResult
  rows: TreeRow[]
  /** Expansion data so multi-cycle Excel rows round-trip like the UI export. */
  allocations: ProjectData['allocations']
  cycleConfig: ProjectData['cycleConfig']
  sourceFile: SourceFile | null
  /** Force the Save-As dialog even when a source file is known. */
  forceSaveAs?: boolean
  /** Target format. Defaults to xlsx for backwards-compatible callers. */
  format?: ProjectFileFormat
}

export interface SaveProjectResult {
  saved: boolean
  canceled?: boolean
  /** Final file name, for the success toast. */
  target: string
  /** Absolute path actually written (desktop), to update the association. */
  path?: string
  format: ProjectFileFormat
  /** Non-fatal note, e.g. about the CSV metadata column. */
  warning?: string
  error?: string
}

const EXTENSION: Record<ProjectFileFormat, string> = {
  json: 'json',
  xlsx: 'xlsx',
  csv: 'csv'
}

const MIME: Record<ProjectFileFormat, string> = {
  json: 'application/json;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8'
}

const FILTERS: Record<ProjectFileFormat, { name: string; extensions: string[] }> = {
  json: { name: 'JSON 项目文件', extensions: ['json'] },
  xlsx: { name: 'Excel 工作簿', extensions: ['xlsx'] },
  csv: { name: 'CSV 项目文件', extensions: ['csv'] }
}

function projectFileName(projectName: string, format: ProjectFileFormat): string {
  const stem = (projectName || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'cycleview'
  return `${stem}-gantt.${EXTENSION[format]}`
}

function withExtension(filePath: string, extension: string): string {
  return new RegExp(`\\.${extension}$`, 'i').test(filePath) ? filePath : `${filePath}.${extension}`
}

async function buildSavePayload(input: SaveProjectInput, format: ProjectFileFormat, snapshot: ProjectData): Promise<{ blob: Blob; warning?: string }> {
  if (format === 'json') {
    return { blob: new Blob([buildProjectJson(snapshot)], { type: MIME.json }) }
  }
  if (format === 'csv') {
    const csv = buildProjectCSV(
      snapshot.modules,
      { format: 'csv', includeCalculatedPositions: true },
      snapshot.timeConfig,
      snapshot
    )
    return {
      blob: new Blob([csv], { type: MIME.csv }),
      warning: 'CSV 项目文件依赖 __project_json 元数据列，请勿删除该列'
    }
  }
  const { buildGanttWorkbook } = await import('@/services/excelService')
  const blob = await buildGanttWorkbook({
    // Workbook rows may show expanded cycles; JSON/CSV keep the template.
    project: {
      ...snapshot,
      allocations: input.allocations,
      cycleConfig: input.cycleConfig
    },
    schedule: input.schedule,
    rows: input.rows,
    layout: snapshot.excelLayout
  })
  return { blob }
}

export async function saveProjectFile(input: SaveProjectInput): Promise<SaveProjectResult> {
  const format = input.format ?? 'xlsx'
  const { project, sourceFile } = input
  const defaultName = projectFileName(project.name, format)
  const snapshot = normalizeProjectSnapshot(project)
  const { blob, warning } = await buildSavePayload(input, format, snapshot)

  const api = window.electronAPI
  const canWriteDisk = !IS_ONLINE && !!api
  if (!canWriteDisk) {
    downloadBlob(blob, defaultName)
    return { saved: true, target: defaultName, format, warning }
  }

  // Keep writing back to the same format. A CSV import associated with the
  // project stays CSV; choosing another default format requires Save As.
  const reusable = !input.forceSaveAs && sourceFile?.kind === format && sourceFile.path
  let targetPath: string | undefined
  if (reusable) {
    targetPath = sourceFile!.path
  } else {
    const dialog = await api.saveFile({
      title: defaultName,
      defaultPath: sourceFile?.kind === format ? sourceFile.name : defaultName,
      filters: [FILTERS[format]]
    })
    if (dialog.canceled || !dialog.filePath) return { saved: false, canceled: true, target: '', format }
    targetPath = withExtension(dialog.filePath, EXTENSION[format])
  }

  if (format === 'xlsx') {
    // .xlsx is a zip archive: ship raw bytes as base64, never through the
    // UTF-8 text channel (that is exactly what used to corrupt workbooks).
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const written = await api.writeFileBinary(targetPath!, bytesToBase64(bytes))
    if (!written.success) {
      return { saved: false, target: targetPath!, format, error: written.error }
    }
  } else {
    const written = await api.writeFile(targetPath!, await blob.text())
    if (!written.success) {
      return { saved: false, target: targetPath!, format, error: written.error }
    }
  }

  const displayName = targetPath!.split(/[\\/]/).pop() || defaultName
  return { saved: true, target: displayName, path: targetPath, format, warning }
}

/** Backwards-compatible name used by older callers/tests. */
export function saveProjectExcel(input: SaveProjectInput): Promise<SaveProjectResult> {
  return saveProjectFile({ ...input, format: 'xlsx' })
}
