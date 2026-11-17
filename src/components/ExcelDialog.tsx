import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { useCycleView } from '@/hooks/useCycleView'
import { flattenTree } from '@/lib/dependencyEngine'
import { DEFAULT_EXCEL_LAYOUT } from '@/lib/timeScale'
import { buildExcelRows, excelFileName, matrixStep } from '@/lib/excelModel'
// ExcelJS is heavy: load the workbook reader/writer only when the user acts,
// so the first paint (and the online bundle) stays small.
import { downloadBlob } from '@/services/exportService'
import { toast } from '@/components/ui/use-toast'
import { ExcelLayoutConfig } from '@/types'
import { FileSpreadsheet, Upload, Download, CheckCircle2, AlertTriangle } from 'lucide-react'

/** Gantt ⇄ Excel: cell geometry editor, export, import and consistency check. */
interface ExcelDialogProps {
  isOpen: boolean
  onClose: () => void
}

const COLUMN_LABELS: Array<[keyof ExcelLayoutConfig['columnWidths'] | string, string]> = [
  ['code', '编号'], ['level', '层级'], ['kind', '类型'], ['module', '模块'],
  ['mechanism', '机构'], ['action', '动作/子动作'], ['stage', '阶段'],
  ['startMs', '开始(ms)'], ['anchorMs', '锚定起始(ms)'], ['durationMs', '持续(ms)'], ['endMs', '结束(ms)'],
  ['startMode', '起始模式'], ['predecessors', '前置任务'], ['parentCode', '上级编号'],
  ['path', '层级路径'], ['color', '颜色'], ['id', 'ID']
]

export const ExcelDialog: React.FC<ExcelDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const { project, setExcelLayout, loadProject } = useProjectStore()
  const { collapsedTaskIds } = useUIStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [layout, setLayout] = useState<ExcelLayoutConfig | null>(null)
  const [includeHidden, setIncludeHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [hasIssue, setHasIssue] = useState(false)

  useEffect(() => {
    if (isOpen) {
      // Initialise from the current project when there is one, otherwise from
      // defaults — the dialog must open on a fresh, project-less session so a
      // workbook can be the user's very first import.
      const base = project?.excelLayout ?? DEFAULT_EXCEL_LAYOUT
      setLayout({ ...base, columnWidths: { ...base.columnWidths } })
      setReport(null)
    }
  }, [isOpen, project?.excelLayout])

  const { config, expansion, schedule } = useCycleView()
  const rows = useMemo(
    () => flattenTree(schedule, new Set(collapsedTaskIds)),
    [schedule, collapsedTaskIds]
  )

  if (!isOpen || !layout) return null

  const setNumber = (key: keyof ExcelLayoutConfig, value: string) => {
    setLayout(prev => prev ? { ...prev, [key]: Number(value) || 0 } : prev)
  }
  const setWidth = (key: string, value: string) => {
    setLayout(prev => prev
      ? { ...prev, columnWidths: { ...prev.columnWidths, [key]: Number(value) || 8 } }
      : prev)
  }

  const persist = () => setExcelLayout(layout)

  /** Chart/table consistency: every row's arithmetic and every dependency constraint. */
  const verify = (): { issues: string[]; count: number } => {
    const issues: string[] = []
    const table = buildExcelRows(schedule, rows)
    table.forEach(r => {
      if (r.startMs + r.durationMs !== r.endMs) {
        issues.push(`${r.code}: 开始+持续 ≠ 结束 (${r.startMs}+${r.durationMs}≠${r.endMs})`)
      }
      const task = schedule.byId[r.id]
      if (task && !task.isSummary && task.constraintMs !== null && task.startMs < task.constraintMs) {
        issues.push(`${r.code}: 起始 ${task.startMs}ms 早于依赖允许的 ${task.constraintMs}ms`)
      }
    })
    return { issues, count: table.length }
  }

  const handleExport = async () => {
    if (!project) return
    setBusy(true)
    try {
      persist()
      const { buildGanttWorkbook } = await import('@/services/excelService')
      const blob = await buildGanttWorkbook({
        project: {
          ...project,
          excelLayout: layout,
          // The workbook mirrors the visible chart, including cycle instances.
          allocations: expansion.allocations,
          cycleConfig: expansion.config
        },
        schedule,
        rows,
        layout,
        includeHiddenRows: includeHidden
      })
      downloadBlob(blob, excelFileName(project.name))
      const check = verify()
      setHasIssue(check.issues.length > 0)
      setReport(
        check.issues.length === 0
          ? t('excel.verified', { count: check.count, defaultValue: `已校验 ${check.count} 行；图表与表格数据一致，无冲突。` })
          : `${check.issues.length} ${t('excel.issues', { defaultValue: '处不一致' })}: ${check.issues.slice(0, 3).join('；')}`
      )
    } catch (error) {
      toast({ variant: 'destructive', title: t('excel.exportFailed', { defaultValue: 'Excel 导出失败' }), description: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (file: File) => {
    setBusy(true)
    try {
      const { importGanttWorkbook } = await import('@/services/excelService')
      const result = await importGanttWorkbook(file)
      if (!result.success || !result.modules) {
        toast({ variant: 'destructive', title: t('excel.importFailed', { defaultValue: 'Excel 导入失败' }), description: result.error })
        setHasIssue(true)
        setReport(result.error ?? '')
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
      setLayout({ ...result.excelLayout!, columnWidths: { ...result.excelLayout!.columnWidths } })
      const nextWarnings = result.warnings ?? []
      setHasIssue(nextWarnings.length > 0)
      setReport(
        t('excel.imported', { count: result.modules.length, defaultValue: `已导入 ${result.modules.length} 行并按依赖重新排程；甘特图与表格已同步。` }) +
        (nextWarnings.length ? ` ${nextWarnings.slice(0, 2).join('；')}` : '')
      )
      toast({ title: t('excel.importOk', { defaultValue: 'Excel 已导入' }) })
    } catch (error) {
      toast({ variant: 'destructive', title: t('excel.importFailed', { defaultValue: 'Excel 导入失败' }), description: String(error) })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const step = matrixStep(schedule.totalMs, config, layout)
  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'
  const labelClass = 'block text-xs text-muted-foreground mb-1'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[620px] max-w-[95vw] max-h-[90vh] overflow-y-auto border">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-background z-10">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />{t('excel.title', { defaultValue: '甘特图 ⇄ Excel 转换' })}
          </h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/40 border rounded p-2">
            {t('excel.intro', { defaultValue: '第 1 页「动作时序」为精确毫秒表；第 2 页「甘特矩阵」把图表按时间列展开；第 3 页保存设置、层级与依赖，可再导回。' })}
            {' '}{t('excel.matrixStep', { defaultValue: '当前矩阵列跨度' })} <b>{step} ms</b>。
          </div>

          {/* cell sizes */}
          <section className="border rounded-lg p-3">
            <h3 className="text-sm font-semibold mb-3">{t('excel.cellSize', { defaultValue: '单元格尺寸（可自定义）' })}</h3>
            <div className="grid grid-cols-3 gap-3">
              <div><label className={labelClass}>{t('excel.rowHeight', { defaultValue: '行高 (pt)' })}</label>
                <input className={inputClass} type="number" min={10} max={120} value={layout.rowHeight}
                  onChange={e => setNumber('rowHeight', e.target.value)} /></div>
              <div><label className={labelClass}>{t('excel.headerHeight', { defaultValue: '表头高 (pt)' })}</label>
                <input className={inputClass} type="number" min={10} max={120} value={layout.headerHeight}
                  onChange={e => setNumber('headerHeight', e.target.value)} /></div>
              <div><label className={labelClass}>{t('excel.fontSize', { defaultValue: '字号 (pt)' })}</label>
                <input className={inputClass} type="number" min={6} max={24} value={layout.fontSize}
                  onChange={e => setNumber('fontSize', e.target.value)} /></div>
              <div><label className={labelClass}>{t('excel.matrixCellWidth', { defaultValue: '矩阵列宽 (字符)' })}</label>
                <input className={inputClass} type="number" min={1} max={20} step={0.5} value={layout.matrixCellWidth}
                  onChange={e => setNumber('matrixCellWidth', e.target.value)} /></div>
              <div><label className={labelClass}>{t('excel.matrixRowHeight', { defaultValue: '矩阵行高 (pt)' })}</label>
                <input className={inputClass} type="number" min={8} max={80} value={layout.matrixRowHeight}
                  onChange={e => setNumber('matrixRowHeight', e.target.value)} /></div>
              <div><label className={labelClass}>{t('excel.matrixStep', { defaultValue: '矩阵列跨度 (ms, 0=自动)' })}</label>
                <input className={inputClass} type="number" min={0} value={layout.matrixStepMs}
                  onChange={e => setNumber('matrixStepMs', e.target.value)} /></div>
            </div>
            <div className="mt-3">
              <div className={labelClass}>{t('excel.columnWidths', { defaultValue: '各列宽度（字符）' })}</div>
              <div className="grid grid-cols-4 gap-2">
                {COLUMN_LABELS.map(([key, name]) => (
                  <label key={key} className="text-[11px]">
                    <span className="block text-muted-foreground truncate">{name}</span>
                    <input className="w-full px-1 py-0.5 text-xs border rounded bg-background"
                      type="number" min={4} max={80}
                      value={layout.columnWidths[key] ?? 14}
                      onChange={e => setWidth(key, e.target.value)} />
                  </label>
                ))}
              </div>
            </div>
          </section>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeHidden} onChange={e => setIncludeHidden(e.target.checked)} />
            {t('excel.includeHidden', { defaultValue: '导出被隐藏（已折叠）的子动作行' })}
          </label>

          {report && (
            <div className={`text-xs border rounded p-2 flex items-start gap-2 ${hasIssue ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400'}`}>
              {hasIssue ? <AlertTriangle className="h-3.5 w-3.5 mt-0.5" /> : <CheckCircle2 className="h-3.5 w-3.5 mt-0.5" />}
              <span>{report}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleExport} disabled={busy || !project}
              className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1">
              <Download className="h-3.5 w-3.5" />{t('excel.export', { defaultValue: '导出 Excel' })}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              className="px-3 py-1.5 text-sm border rounded hover:bg-accent disabled:opacity-50 flex items-center gap-1">
              <Upload className="h-3.5 w-3.5" />{t('excel.import', { defaultValue: '导入 Excel（回写甘特图）' })}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleImport(f) }} />
            <button onClick={() => { const check = verify(); setHasIssue(check.issues.length > 0); setReport(
              check.issues.length ? `${check.issues.length} ${t('excel.issues', { defaultValue: '处不一致' })}: ${check.issues.slice(0, 3).join('；')}`
                : t('excel.verified', { count: check.count, defaultValue: `已校验 ${check.count} 行；图表与表格数据一致，无冲突。` })
            ) }}
              className="px-3 py-1.5 text-sm border rounded hover:bg-accent">
              {t('excel.verify', { defaultValue: '校验一致性' })}
            </button>
          </div>
        </div>

        <div className="flex justify-end px-5 py-3 border-t">
          <button onClick={() => { persist(); onClose() }} className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.close', { defaultValue: '关闭' })}
          </button>
        </div>
      </div>
    </div>
  )
}
