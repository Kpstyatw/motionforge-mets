import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { importCSVFile } from '@/services/csvImport'
import { toast } from '@/components/ui/use-toast'
import { IS_ONLINE, ONLINE_ROW_LIMIT } from '@/lib/platform'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { base64ToBytes } from '@/lib/binary'
import { parseProjectJson } from '@/services/jsonProject'
import { ProjectFileFormat } from '@/types'

/**
 * Two file entries for the toolbar:
 *   open    -> .json only, a complete project snapshot (modules + resources +
 *              dependencies + cycle and layout settings)
 *   import  -> .csv / .xlsx only, tabular data (CSV rows optionally carry the
 *              same full snapshot in a metadata column)
 *
 * Both create a project when none exists, so a fresh session can start with
 * either action. The file dialog filters match the entry point so users do
 * not accidentally open a JSON project through "Import" or vice versa.
 */
export function useCSVImport() {
  const { t } = useTranslation()
  const [isImporting, setIsImporting] = useState(false)
  const { createNewProject, loadProject, project, setSourceFile } = useProjectStore()

  type SourceInfo = { path?: string; name: string; kind: ProjectFileFormat }
  type PickKind = 'project' | 'data'

  const fileKind = (name: string): ProjectFileFormat =>
    /\.(xlsx|xlsm)$/i.test(name) ? 'xlsx' : /\.json$/i.test(name) ? 'json' : 'csv'

  /** Pick one file with filters matching the entry point (project = JSON only). */
  const pickFile = async (kind: PickKind): Promise<{ file: File; source: SourceInfo } | null> => {
    const accept = kind === 'project' ? '.json' : '.csv,.xlsx,.xlsm'
    if (!window.electronAPI) {
      return new Promise(resolve => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = accept
        input.onchange = (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          resolve(file ? { file, source: { name: file.name, kind: fileKind(file.name) } } : null)
        }
        input.oncancel = () => resolve(null)
        input.click()
      })
    }
    try {
      const result = await window.electronAPI.openFile(kind)
      if (result.canceled || result.filePaths.length === 0) return null
      const filePath = result.filePaths[0]
      const name = filePath.split(/[\\/]/).pop() || (kind === 'project' ? 'project.json' : 'data.csv')
      const sourceKind = fileKind(name)
      // Text files (CSV/JSON) use the UTF-8 channel; spreadsheets must keep
      // their bytes intact or ExcelJS sees a corrupted zip archive.
      const fileResult = sourceKind === 'xlsx'
        ? await window.electronAPI.readFileBinary(filePath)
        : await window.electronAPI.readFile(filePath)
      if (!fileResult.success || !fileResult.data) {
        toast({ variant: 'destructive', title: t('error.fileNotFound'), description: fileResult.error })
        return null
      }
      const payload = sourceKind === 'xlsx' ? base64ToBytes(fileResult.data) : fileResult.data
      const type = sourceKind === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : sourceKind === 'json' ? 'application/json' : 'text/csv'
      return {
        file: new File([payload], name, { type }),
        source: { path: filePath, name, kind: sourceKind }
      }
    } catch (error) {
      console.error('Error opening file dialog:', error)
      toast({
        variant: 'destructive', title: t('error.importFailed'),
        description: error instanceof Error ? error.message : t('error.unknown')
      })
      return null
    }
  }

  /** "Open" — complete project snapshot, .json only. */
  const handleOpen = async () => {
    const picked = await pickFile('project')
    if (!picked) return
    if (picked.source.kind !== 'json') {
      toast({
        variant: 'destructive', title: t('json.importFailed', { defaultValue: 'JSON 导入失败' }),
        description: t('error.unsupportedProjectFile', { defaultValue: '“打开”只支持 .json 项目文件；CSV / Excel 请使用“导入”。' })
      })
      return
    }
    await processJsonFile(picked.file, picked.source)
  }

  /** "Import" — tabular data, .csv / .xlsx only. */
  const handleImport = async () => {
    const picked = await pickFile('data')
    if (!picked) return
    if (picked.source.kind === 'json') {
      toast({
        variant: 'destructive', title: t('error.invalidFormat'),
        description: t('error.unsupportedImportFile', { defaultValue: '“导入”只支持 CSV / Excel；JSON 项目文件请使用“打开”。' })
      })
      return
    }
    await processFile(picked.file, picked.source)
  }

  const processFile = async (file: File, source?: SourceInfo) => {
    const kind = fileKind(file.name)
    if (kind === 'xlsx') await processExcelFile(file, source)
    else if (kind === 'json') await processJsonFile(file, source)
    else if (/\.csv$/i.test(file.name)) await processCSVFile(file, source)
    else toast({
      variant: 'destructive', title: t('error.invalidFormat'),
      description: t('error.unsupportedFile', { defaultValue: '请选择 .csv、.xlsx 或 .json 文件' })
    })
  }

  const processCSVFile = async (file: File, source?: SourceInfo) => {
    setIsImporting(true)
    try {
      const result = await importCSVFile(file)
      if (result.success && result.data && IS_ONLINE && result.data.length > ONLINE_ROW_LIMIT) {
        toast({
          variant: 'destructive', title: t('error.importFailed'),
          description: t('online.rowLimit', { limit: ONLINE_ROW_LIMIT, count: result.data.length })
        })
      } else if (result.success && result.data) {
        if (!project) createNewProject()
        const meta = result.projectMeta
        loadProject({
          ...(project ?? {}),
          name: meta?.name ?? project?.name ?? 'Imported Project',
          modules: result.data,
          resources: meta?.resources?.length ? meta.resources : (project?.resources ?? []),
          allocations: meta?.allocations?.length ? meta.allocations : (project?.allocations ?? []),
          timeConfig: normalizeTimeConfig(result.timeConfig ?? project?.timeConfig),
          cycleConfig: meta?.cycleConfig ?? project?.cycleConfig,
          excelLayout: meta?.excelLayout ?? project?.excelLayout,
          ganttConfig: meta?.ganttConfig ?? project?.ganttConfig,
          canvasConfig: meta?.canvasConfig ?? project?.canvasConfig,
          createdAt: meta?.createdAt ?? project?.createdAt,
          updatedAt: meta?.updatedAt ?? project?.updatedAt,
          version: meta?.version ?? project?.version
        })
        setSourceFile(source ?? { name: file.name, kind: 'csv' })
        toast({
          title: t('toolbar.importCSV'),
          description: t('toolbar.importSuccess', { count: result.data.length })
        })
      } else {
        let errorMessage = result.error || t('error.importFailed')
        if (result.rowErrors && result.rowErrors.length > 0) {
          const errors = result.rowErrors.slice(0, 3).map(e => `Row ${e.row}: ${e.message}`).join('\n')
          errorMessage += '\n\n' + errors
          if (result.rowErrors.length > 3) errorMessage += `\n... and ${result.rowErrors.length - 3} more errors`
        }
        toast({ variant: 'destructive', title: t('error.importFailed'), description: errorMessage })
      }
    } catch (error) {
      toast({
        variant: 'destructive', title: t('error.importFailed'),
        description: error instanceof Error ? error.message : t('error.unknown')
      })
    } finally {
      setIsImporting(false)
    }
  }

  const processExcelFile = async (file: File, source?: SourceInfo) => {
    setIsImporting(true)
    try {
      // ExcelJS is heavy — load only when a workbook is actually imported.
      const { importGanttWorkbook } = await import('@/services/excelService')
      const result = await importGanttWorkbook(file)
      if (!result.success || !result.modules) {
        toast({ variant: 'destructive', title: t('excel.importFailed', { defaultValue: 'Excel 导入失败' }), description: result.error })
        return
      }
      if (IS_ONLINE && result.modules.length > ONLINE_ROW_LIMIT) {
        toast({
          variant: 'destructive', title: t('error.importFailed'),
          description: t('online.rowLimit', { limit: ONLINE_ROW_LIMIT, count: result.modules.length })
        })
        return
      }
      loadProject({
        ...(project ?? {}),
        name: result.projectName || project?.name || 'Imported Project',
        modules: result.modules,
        // Older workbooks have no resource sheets — keep the existing catalogue.
        resources: result.resources?.length ? result.resources : (project?.resources ?? []),
        allocations: result.allocations?.length ? result.allocations : (project?.allocations ?? []),
        timeConfig: result.timeConfig,
        cycleConfig: result.cycleConfig,
        excelLayout: result.excelLayout,
        ganttConfig: result.ganttConfig ?? project?.ganttConfig,
        canvasConfig: result.canvasConfig ?? project?.canvasConfig,
        createdAt: result.createdAt ?? project?.createdAt,
        updatedAt: result.updatedAt ?? project?.updatedAt,
        version: result.version ?? project?.version
      })
      setSourceFile(source ?? { name: file.name, kind: 'xlsx' })
      toast({
        title: t('excel.importOk', { defaultValue: 'Excel 已导入' }),
        description: t('toolbar.importSuccess', { count: result.modules.length }) +
          (result.warnings?.length ? ` · ${result.warnings[0]}` : '')
      })
    } catch (error) {
      toast({
        variant: 'destructive', title: t('excel.importFailed', { defaultValue: 'Excel 导入失败' }),
        description: error instanceof Error ? error.message : t('error.unknown')
      })
    } finally {
      setIsImporting(false)
    }
  }

  const processJsonFile = async (file: File, source?: SourceInfo) => {
    setIsImporting(true)
    try {
      const result = parseProjectJson(await file.text())
      if (!result.success || !result.project) {
        toast({
          variant: 'destructive', title: t('json.importFailed', { defaultValue: 'JSON 导入失败' }),
          description: result.error
        })
        return
      }
      if (IS_ONLINE && result.project.modules.length > ONLINE_ROW_LIMIT) {
        toast({
          variant: 'destructive', title: t('error.importFailed'),
          description: t('online.rowLimit', { limit: ONLINE_ROW_LIMIT, count: result.project.modules.length })
        })
        return
      }
      loadProject(result.project)
      setSourceFile(source ?? { name: file.name, kind: 'json' })
      toast({
        title: t('json.importOk', { defaultValue: 'JSON 项目已导入' }),
        description: t('toolbar.importSuccess', { count: result.project.modules.length })
      })
    } catch (error) {
      toast({
        variant: 'destructive', title: t('json.importFailed', { defaultValue: 'JSON 导入失败' }),
        description: error instanceof Error ? error.message : t('error.unknown')
      })
    } finally {
      setIsImporting(false)
    }
  }

  /** Import CSV text that did not come from a file: a share link or bundled sample. */
  const importCSVText = async (csv: string, name: string) => {
    await processCSVFile(new File([csv], name, { type: 'text/csv' }))
  }

  return {
    handleOpen,
    handleImport,
    /** Backwards-compatible alias used by older callers. */
    handleImportCSV: handleImport,
    importCSVText,
    isImporting
  }
}
