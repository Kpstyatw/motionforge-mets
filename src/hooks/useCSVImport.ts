import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { importCSVFile } from '@/services/csvImport'
import { toast } from '@/components/ui/use-toast'
import { IS_ONLINE, ONLINE_ROW_LIMIT } from '@/lib/platform'
import { base64ToBytes } from '@/lib/binary'

/**
 * Single file-import entry for the toolbar. Routes by extension:
 *   .csv        -> CSV importer (original 5 columns + Gantt extensions)
 *   .xlsx/.xlsm -> Gantt workbook importer (5 sheets, incl. resources)
 *
 * Both formats create a project when none exists, so the very first action in
 * a fresh session can be "import" — no CSV-before-Excel prerequisite.
 */
export function useCSVImport() {
  const { t } = useTranslation()
  const [isImporting, setIsImporting] = useState(false)
  const { updateModules, createNewProject, loadProject, project, setTimeConfig } = useProjectStore()

  /** Pick a file: native Electron dialog or a web <input>, both accepting CSV + Excel. */
  const handleImport = async () => {
    if (!window.electronAPI) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.csv,.xlsx,.xlsm'
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (file) await processFile(file)
      }
      input.click()
    } else {
      try {
        const result = await window.electronAPI.openFile()
        if (!result.canceled && result.filePaths.length > 0) {
          const filePath = result.filePaths[0]
          const name = filePath.split(/[\\/]/).pop() || 'data.csv'
          const isExcel = /\.(xlsx|xlsm)$/i.test(name)
          // Text files use the legacy UTF-8 channel; spreadsheets must keep
          // their bytes intact or ExcelJS sees a corrupted zip archive.
          const fileResult = isExcel
            ? await window.electronAPI.readFileBinary(filePath)
            : await window.electronAPI.readFile(filePath)
          if (fileResult.success && fileResult.data) {
            const payload = isExcel
              ? base64ToBytes(fileResult.data)
              : fileResult.data
            const type = isExcel
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'text/csv'
            await processFile(new File([payload], name, { type }))
          } else {
            toast({ variant: 'destructive', title: t('error.fileNotFound'), description: fileResult.error })
          }
        }
      } catch (error) {
        console.error('Error opening file dialog:', error)
        toast({
          variant: 'destructive', title: t('error.importFailed'),
          description: error instanceof Error ? error.message : t('error.unknown')
        })
      }
    }
  }

  const processFile = async (file: File) => {
    const name = file.name.toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) await processExcelFile(file)
    else if (name.endsWith('.csv')) await processCSVFile(file)
    else toast({
      variant: 'destructive', title: t('error.invalidFormat'),
      description: t('error.unsupportedFile', { defaultValue: '请选择 .csv 或 .xlsx 文件' })
    })
  }

  const processCSVFile = async (file: File) => {
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
        // Apply the file's scale/precision before scheduling so canonical ms
        // values snap to the right quantum.
        if (result.timeConfig) setTimeConfig(result.timeConfig)
        updateModules(result.data)
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

  const processExcelFile = async (file: File) => {
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
        excelLayout: result.excelLayout
      })
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

  /** Import CSV text that did not come from a file: a share link or bundled sample. */
  const importCSVText = async (csv: string, name: string) => {
    await processCSVFile(new File([csv], name, { type: 'text/csv' }))
  }

  return {
    handleImport,
    /** Backwards-compatible alias used by the keyboard shortcut. */
    handleImportCSV: handleImport,
    importCSVText,
    isImporting
  }
}
