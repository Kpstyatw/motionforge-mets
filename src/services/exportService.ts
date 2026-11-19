import Papa from 'papaparse'
import { ModuleData, ProjectData, TimeConfig } from '@/types'
import { computeSchedule, serializePredecessors } from '@/lib/dependencyEngine'
import { DEFAULT_TIME_CONFIG } from '@/lib/timeScale'
import { normalizeProjectSnapshot, PROJECT_META_COLUMN } from '@/services/jsonProject'

export interface ExportOptions {
  format: 'csv' | 'pdf'
  includeCalculatedPositions?: boolean
}

/**
 * CSV export. The Gantt edition writes the canonical millisecond columns in
 * addition to the upstream five, so a file exported here round-trips with
 * exact timing, hierarchy and dependency edges.
 */
export function buildProjectCSV(
  modules: ModuleData[],
  options: ExportOptions = { format: 'csv' },
  timeConfig: TimeConfig = DEFAULT_TIME_CONFIG,
  project?: ProjectData
): string {
    const schedule = computeSchedule(modules, timeConfig)
    const codeOf = new Map(modules.map(m => [m.id, m.code ?? m.id]))
    const csvData: Array<Record<string, unknown>> = modules.map(module => {
      const resolved = schedule.byId[module.id]
      const startMs = resolved?.startMs ?? module.startMs ?? 0
      const durationMs = resolved?.durationMs ?? module.durationMs ?? 0
      const startPosition = options.includeCalculatedPositions && module.calculatedStartX !== undefined
        ? Number((startMs / Math.max(1, timeConfig.scaleMs)).toFixed(4))
        : module.startX
      return {
        id: module.id,
        code: module.code ?? module.id,
        kind: module.kind ?? 'action',
        module: module.moduleName,
        action: module.actionDescription,
        startPosition,
        moveCount: options.includeCalculatedPositions
          ? Number((durationMs / Math.max(1, timeConfig.scaleMs)).toFixed(4))
          : module.moveCount,
        duration: options.includeCalculatedPositions ? timeConfig.scaleMs : module.duration,
        stage: module.stage ?? '',
        startMs,
        anchorMs: module.anchorMs ?? module.startMs ?? 0,
        durationMs,
        startMode: module.startMode ?? 'auto',
        parentCode: module.parentId ? (codeOf.get(module.parentId) ?? '') : '',
        predecessors: serializePredecessors(module.predecessors, schedule.byId),
        scaleMs: timeConfig.scaleMs,
        precisionMs: timeConfig.precisionMs,
        ...(options.includeCalculatedPositions && module.isSequentialAction && {
          originalStartPosition: module.startX,
          isSequential: true
        })
      }
    })

    if (project && csvData.length > 0) {
      // Compact JSON: one physical CSV row per task, even with the metadata.
      csvData[0][PROJECT_META_COLUMN] = JSON.stringify(normalizeProjectSnapshot(project))
    }
    return Papa.unparse(csvData, { header: true, delimiter: ',', quotes: true })
}

/**
 * CSV export kept for the Export dialog. Save/Save As uses buildProjectCSV with
 * a project snapshot so metadata columns survive the round-trip too.
 */
export function exportToCSV(
  modules: ModuleData[],
  options: ExportOptions = { format: 'csv' },
  timeConfig: TimeConfig = DEFAULT_TIME_CONFIG
): void {
  try {
    const csv = buildProjectCSV(modules, options, timeConfig)
    downloadFile(csv, 'cycleview-gantt-export.csv', 'text/csv')
  } catch (error) {
    console.error('CSV export failed:', error)
    throw new Error('CSV export failed')
  }
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  downloadFileFromUrl(url, filename)
  URL.revokeObjectURL(url)
}

function downloadFileFromUrl(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

// PDF export lives in services/pdfExport.ts — a full report rendered through
// Chromium's print pipeline, not a canvas snapshot.

/** Save an already-encoded binary blob (MP4, XLSX...). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    downloadFileFromUrl(url, filename)
  } finally {
    // Revoke on the next tick: the click above starts the save asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}
