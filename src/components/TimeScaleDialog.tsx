import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import {
  PRECISION_CHOICES, SCALE_CHOICES, normalizeTimeConfig
} from '@/lib/timeScale'
import { TimeConfig } from '@/types'

/** Time scale / precision / display unit configuration. */
interface TimeScaleDialogProps {
  isOpen: boolean
  onClose: () => void
}

export const TimeScaleDialog: React.FC<TimeScaleDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const { project, setTimeConfig, setGanttConfig } = useProjectStore()
  const [scaleMs, setScaleMs] = useState('100')
  const [precisionMs, setPrecisionMs] = useState('1')
  const [displayUnit, setDisplayUnit] = useState<TimeConfig['displayUnit']>('ms')
  const [rowHeight, setRowHeight] = useState('34')
  const [cellWidth, setCellWidth] = useState('35')
  const [showDependencies, setShowDependencies] = useState(true)
  const [showSummaries, setShowSummaries] = useState(true)

  // Snapshot config only when the dialog opens. Depending on project config
  // here would overwrite in-progress edits whenever the store changes (e.g.
  // toolbar zoom), which is why "apply" looked like it did nothing.
  useEffect(() => {
    if (!isOpen || !project) return
    const cfg = normalizeTimeConfig(project.timeConfig)
    setScaleMs(String(cfg.scaleMs))
    setPrecisionMs(String(cfg.precisionMs))
    setDisplayUnit(cfg.displayUnit)
    setRowHeight(String(project.ganttConfig?.rowHeight ?? 34))
    setCellWidth(String(Math.round((project.ganttConfig?.pxPerMs ?? 0.35) * cfg.scaleMs * 100) / 100))
    setShowDependencies(project.ganttConfig?.showDependencies ?? true)
    setShowSummaries(project.ganttConfig?.showSummaries ?? true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  if (!isOpen || !project) return null

  const apply = () => {
    const scale = Math.max(1, Math.round(Number(scaleMs) || 100))
    const precision = Math.max(1, Math.min(scale, Math.round(Number(precisionMs) || 1)))
    setTimeConfig({ scaleMs: scale, precisionMs: precision, displayUnit })
    setGanttConfig({
      rowHeight: Math.max(18, Math.min(80, Math.round(Number(rowHeight) || 34))),
      // pixels per scale division → px/ms
      pxPerMs: Math.min(8, Math.max(0.004, (Number(cellWidth) || 35) / scale)),
      showDependencies,
      showSummaries
    })
    onClose()
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'
  const labelClass = 'block text-xs text-muted-foreground mb-1'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[460px] max-w-[95vw] border">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-base font-semibold">{t('timeScale.title', { defaultValue: '时间刻度与精度' })}</h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>{t('timeScale.scale', { defaultValue: '时间刻度 (ms/格)' })}</label>
              <input className={inputClass} list="scale-choices" value={scaleMs} onChange={e => setScaleMs(e.target.value)} />
              <datalist id="scale-choices">
                {SCALE_CHOICES.map(v => <option key={v} value={v} />)}
              </datalist>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t('timeScale.scaleHint', { defaultValue: '刻度可设为 1 ms；所有计算按整数毫秒进行。' })}
              </p>
            </div>
            <div>
              <label className={labelClass}>{t('timeScale.precision', { defaultValue: '时间精度 (ms)' })}</label>
              <input className={inputClass} list="precision-choices" value={precisionMs} onChange={e => setPrecisionMs(e.target.value)} />
              <datalist id="precision-choices">
                {PRECISION_CHOICES.map(v => <option key={v} value={v} />)}
              </datalist>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t('timeScale.precisionHint', { defaultValue: '最小 1 ms；所有时刻吸附到该精度的整数倍。' })}
              </p>
            </div>
          </div>
          <div>
            <label className={labelClass}>{t('timeScale.unit', { defaultValue: '刻度显示单位' })}</label>
            <select className={inputClass} value={displayUnit}
              onChange={e => setDisplayUnit(e.target.value as TimeConfig['displayUnit'])}>
              <option value="ms">ms（毫秒）</option>
              <option value="s">s（秒）</option>
              <option value="min">min（分:秒）</option>
            </select>
          </div>
          <div className="border-t pt-3 space-y-3">
            <div className="text-xs font-semibold">{t('timeScale.gantt', { defaultValue: '甘特视图' })}</div>
            <div>
              <label className={labelClass}>{t('timeScale.rowHeight', { defaultValue: '行高 (px)' })}</label>
              <input className={inputClass} type="number" min={18} max={80} value={rowHeight}
                onChange={e => setRowHeight(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>{t('timeScale.cellWidth', { defaultValue: '时间格宽 (px/格)' })}</label>
              <input className={inputClass} type="number" min={4} max={400} step={1} value={cellWidth}
                onChange={e => setCellWidth(e.target.value)} />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t('timeScale.cellWidthHint', { defaultValue: '每格时间刻度占多少像素；调大即横向放大时间轴，与工具栏缩放等效。' })}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={showDependencies} onChange={e => setShowDependencies(e.target.checked)} />
              {t('timeScale.showDeps', { defaultValue: '显示依赖连线' })}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={showSummaries} onChange={e => setShowSummaries(e.target.checked)} />
              {t('timeScale.showSummaries', { defaultValue: '显示父级汇总括号' })}
            </label>
          </div>
          <div className="text-xs bg-muted/40 border rounded p-2 text-muted-foreground">
            {t('timeScale.note', { defaultValue: '修改刻度/精度后，依赖引擎会按新精度重新量化并级联重算所有后置动作；甘特图、节拍网格、PDF、MP4 与 Excel 同步取新值。' })}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t">
          <button onClick={onClose} className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.cancel', { defaultValue: '取消' })}
          </button>
          <button onClick={apply} className="px-4 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90">
            {t('dialog.apply', { defaultValue: '应用' })}
          </button>
        </div>
      </div>
    </div>
  )
}
