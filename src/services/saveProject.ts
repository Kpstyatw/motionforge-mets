import { ProjectData } from '@/types'
import { TreeRow, ScheduleResult } from '@/lib/dependencyEngine'
import { SourceFile } from '@/stores/useProjectStore'
import { bytesToBase64 } from '@/lib/binary'
import { downloadBlob } from '@/services/exportService'
import { excelFileName } from '@/lib/excelModel'
import { IS_ONLINE } from '@/lib/platform'

/**
 * One-click save of the current project back to an Excel workbook.
 *
 * Desktop: writes the generated .xlsx straight back to the file the project
 * was imported from (Ctrl+S), or asks for a target via a native Save dialog
 * when there is no association yet / Save-As is requested. Web: falls back to
 * a browser download, since a web page cannot overwrite local files.
 */
export interface SaveProjectInput {
  project: ProjectData
  schedule: ScheduleResult
  rows: TreeRow[]
  /** Expansion data so multi-cycle views round-trip like the Excel export. */
  allocations: ProjectData['allocations']
  cycleConfig: ProjectData['cycleConfig']
  sourceFile: SourceFile | null
  /** Force the Save-As dialog even when a source file is known. */
  forceSaveAs?: boolean
}

export interface SaveProjectResult {
  saved: boolean
  canceled?: boolean
  /** Final file name, for the success toast. */
  target: string
  /** Absolute path actually written (desktop), to update the association. */
  path?: string
  error?: string
}

export async function saveProjectExcel(input: SaveProjectInput): Promise<SaveProjectResult> {
  const { project, schedule, rows, sourceFile } = input
  const defaultName = excelFileName(project.name)

  // Build the workbook bytes once; both desktop paths and web download share it.
  const { buildGanttWorkbook } = await import('@/services/excelService')
  const blob = await buildGanttWorkbook({
    project: {
      ...project,
      allocations: input.allocations,
      cycleConfig: input.cycleConfig
    },
    schedule,
    rows,
    layout: project.excelLayout
  })

  const api = window.electronAPI
  const canWriteDisk = !IS_ONLINE && !!api

  if (!canWriteDisk) {
    downloadBlob(blob, defaultName)
    return { saved: true, target: defaultName }
  }

  // Desktop: reuse the source path unless Save-As was requested or the source
  // was a CSV (a .csv cannot hold a workbook, so always pick a new .xlsx).
  let targetPath: string | undefined
  const reusable = !input.forceSaveAs && sourceFile?.kind === 'xlsx' && sourceFile.path
  if (reusable) {
    targetPath = sourceFile!.path
  } else {
    const dialog = await api.saveFile({
      title: defaultName,
      defaultPath: sourceFile?.kind === 'xlsx' ? sourceFile.name : defaultName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (dialog.canceled || !dialog.filePath) return { saved: false, canceled: true, target: '' }
    targetPath = dialog.filePath
  }

  // .xlsx is a zip archive: ship raw bytes as base64, never through the UTF-8
  // text channel (that is exactly what used to corrupt imported workbooks).
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const written = await api.writeFileBinary(targetPath!, bytesToBase64(bytes))
  if (!written.success) {
    return { saved: false, target: targetPath!, error: written.error }
  }

  const displayName = targetPath!.split(/[\\/]/).pop() || defaultName
  return { saved: true, target: displayName, path: targetPath }
}
