import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { DEFAULT_CYCLE_CONFIG, normalizeCycleConfig } from '@/lib/cycleEngine'
import { formatTime, normalizeTimeConfig } from '@/lib/timeScale'
import { Repeat2 } from 'lucide-react'

interface CycleDialogProps {
  isOpen: boolean
  onClose: () => void
}

const PRESETS = [5_000, 10_000, 20_000, 30_000, 60_000, 120_000]

/** Configure the fixed machine cycle used for the multi-cycle projection. */
export const CycleDialog: React.FC<CycleDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const { project, setCycleConfig } = useProjectStore()
  const [form, setForm] = useState(normalizeCycleConfig(DEFAULT_CYCLE_CONFIG))

  useEffect(() => {
    if (isOpen) setForm(normalizeCycleConfig(project?.cycleConfig))
  }, [isOpen, project?.cycleConfig])

  const config = normalizeTimeConfig(project?.timeConfig)
  const template = useMemo(
    () => computeSchedule(project?.modules ?? [], config),
    [project?.modules, config.scaleMs, config.precisionMs, config.displayUnit]
  )
  const overrun = template.tasks.filter(t => !t.isSummary && t.endMs > form.cycleMs)
  const totalMs = form.repeats * form.cycleMs
  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'

  if (!isOpen) return null

  const apply = () => {
    setCycleConfig(normalizeCycleConfig(form))
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[520px] max-w-[95vw] border">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Repeat2 className="h-4 w-4" />
            {t('cycle.title', { defaultValue: '固定周期设置' })}
          </h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.enabled}
              onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            {t('cycle.enable', { defaultValue: '启用多周期展开' })}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('cycle.hint', { defaultValue: '底层只保存一份动作模板；展开后每个周期是只读实例，编辑任一实例都会同步回模板。' })}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {t('cycle.length', { defaultValue: '周期时长 (ms)' })}
              </label>
              <input className={inputClass} type="number" min={config.precisionMs}
                step={config.precisionMs} value={form.cycleMs}
                onChange={e => setForm({ ...form, cycleMs: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {t('cycle.repeats', { defaultValue: '展开周期数' })}
              </label>
              <input className={inputClass} type="number" min={1} max={50} value={form.repeats}
                onChange={e => setForm({
                  ...form, repeats: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1)))
                })} />
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {PRESETS.map(ms => (
              <button key={ms} onClick={() => setForm({ ...form, cycleMs: ms })}
                className={`px-2 py-0.5 text-xs border rounded ${form.cycleMs === ms ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>
                {formatTime(ms, config)}
              </button>
            ))}
          </div>

          <div className="text-xs border rounded p-3 bg-muted/40 space-y-1">
            <div>{t('cycle.singleTotal', { defaultValue: '单周期实际节拍' })}：
              <b className="tabular-nums"> {formatTime(template.totalMs, config)}</b>
            </div>
            <div>{t('cycle.projectedTotal', { defaultValue: '展开后总时间轴' })}：
              <b className="tabular-nums"> {formatTime(totalMs, config)}</b>
              <span className="text-muted-foreground"> ({form.repeats} × {formatTime(form.cycleMs, config)})</span>
            </div>
            <div className={overrun.length ? 'text-amber-500' : 'text-emerald-500'}>
              {overrun.length
                ? `${overrun.length} ${t('cycle.overrun', { defaultValue: '个动作超出周期边界，跨周期资源冲突会在资源视图标红' })}`
                : t('cycle.within', { defaultValue: '所有动作均在周期内完成' })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t">
          <button onClick={onClose} className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.close', { defaultValue: '关闭' })}
          </button>
          <button onClick={apply} className="px-4 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90">
            {t('dialog.apply', { defaultValue: '应用' })}
          </button>
        </div>
      </div>
    </div>
  )
}
