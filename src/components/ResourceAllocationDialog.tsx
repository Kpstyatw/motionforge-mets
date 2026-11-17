import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { clampAllocationWindow } from '@/lib/resourceScheduler'
import { AlertTriangle } from 'lucide-react'

/**
 * Edit the exact-window resource claims of one action. Claims are stored
 * relative to the action start (offsetMs + durationMs), so they follow the
 * action when the dependency engine cascades it to a new time.
 */
interface Props {
  taskId: string | null
  onClose: () => void
}

export const ResourceAllocationDialog: React.FC<Props> = ({ taskId, onClose }) => {
  const { t } = useTranslation()
  const {
    project, addResource, addAllocation, updateAllocation, removeAllocation
  } = useProjectStore()
  const [newResourceId, setNewResourceId] = useState('')
  const [offset, setOffset] = useState('0')
  const [duration, setDuration] = useState('0')
  const [error, setError] = useState<string | null>(null)

  if (!taskId || !project) return null
  const task = project.modules.find(m => m.id === taskId)
  if (!task) return null

  const cfg = normalizeTimeConfig(project.timeConfig)
  const taskDurationMs = task.durationMs ?? task.moveCount * task.duration ?? 0
  const claims = project.allocations.filter(a => a.taskId === taskId)
  const resources = project.resources
  const resourceName = (id: string) => resources.find(r => r.id === id)?.name ?? id

  const submit = () => {
    const resourceId = newResourceId || resources[0]?.id
    if (!resourceId) {
      setError(t('resource.needResource', { defaultValue: '请先添加一个资源' }))
      return
    }
    const parsedOffset = Number(offset)
    const parsedDuration = Number(duration)
    if (!Number.isFinite(parsedOffset) || !Number.isFinite(parsedDuration)) {
      setError(t('resource.invalidNumber', { defaultValue: '偏移与时长必须是数字' }))
      return
    }
    const clamped = clampAllocationWindow(parsedOffset, parsedDuration, taskDurationMs, cfg.precisionMs)
    if (clamped.durationMs <= 0) {
      setError(t('resource.zeroDuration', { defaultValue: '占用时长必须大于 0（且在动作时长内）' }))
      return
    }
    addAllocation({ taskId, resourceId, ...clamped })
    setError(null)
    setOffset('0')
    setDuration('0')
  }

  const quickAddResource = () => {
    const name = window.prompt(t('resource.newName', { defaultValue: '新资源名称（如 管库抓手）' }))
    if (name?.trim()) {
      const id = addResource({ name: name.trim() })
      setNewResourceId(id)
    }
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'
  const labelClass = 'block text-xs text-muted-foreground mb-1'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[560px] max-w-[95vw] max-h-[88vh] overflow-y-auto border">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-background z-10">
          <h2 className="text-base font-semibold">{t('resource.allocTitle', { defaultValue: '资源占用' })} — {task.actionDescription}</h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/40 border rounded p-2">
            {t('resource.allocHint', { defaultValue: '占用窗口相对本动作开始时间。动作被依赖顺延时，占用窗口自动跟随。同一资源窗口重叠会在资源视图标红（仅提示）。' })}
            <div className="mt-1 tabular-nums">{t('resource.taskDuration', { defaultValue: '动作时长' })}: {taskDurationMs} ms</div>
          </div>

          {claims.length > 0 && (
            <section className="border rounded-lg divide-y">
              {claims.map(a => (
                <div key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium flex-1 truncate">{resourceName(a.resourceId)}</span>
                  <label className="text-xs text-muted-foreground">{t('resource.offset', { defaultValue: '偏移' })}</label>
                  <input className="w-20 px-1 py-0.5 text-xs border rounded bg-background text-right tabular-nums"
                    type="number" min={0} defaultValue={a.offsetMs}
                    onBlur={e => updateAllocation(a.id, {
                      offsetMs: clampAllocationWindow(Number(e.target.value), a.durationMs, taskDurationMs, cfg.precisionMs).offsetMs
                    })} />
                  <label className="text-xs text-muted-foreground">{t('resource.duration', { defaultValue: '时长' })}</label>
                  <input className="w-20 px-1 py-0.5 text-xs border rounded bg-background text-right tabular-nums"
                    type="number" min={0} defaultValue={a.durationMs}
                    onBlur={e => updateAllocation(a.id, clampAllocationWindow(a.offsetMs, Number(e.target.value), taskDurationMs, cfg.precisionMs))} />
                  <span className="text-[10px] text-muted-foreground tabular-nums w-28 text-right">
                    {a.offsetMs}–{a.offsetMs + a.durationMs}
                  </span>
                  <button onClick={() => removeAllocation(a.id)} className="px-1.5 text-red-500 hover:bg-red-500/10 rounded"
                    title={t('resource.removeClaim', { defaultValue: '删除占用' })}>×</button>
                </div>
              ))}
            </section>
          )}

          {error && (
            <div className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{error}</div>
          )}

          <section className="border rounded-lg p-3 space-y-3">
            <h3 className="text-sm font-semibold">{t('resource.addClaim', { defaultValue: '添加占用' })}</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-3">
                <label className={labelClass}>{t('resource.selectResource', { defaultValue: '资源' })}</label>
                <div className="flex gap-2">
                  <select className={inputClass} value={newResourceId} onChange={e => setNewResourceId(e.target.value)}>
                    {resources.length === 0 && <option value="">{t('resource.noResource', { defaultValue: '（无资源，请先新建）' })}</option>}
                    {resources.map(r => <option key={r.id} value={r.id}>{r.name}{r.type ? ` · ${r.type}` : ''}</option>)}
                  </select>
                  <button onClick={quickAddResource} className="px-2 border rounded hover:bg-accent whitespace-nowrap text-xs">
                    {t('resource.new', { defaultValue: '新建' })}
                  </button>
                </div>
              </div>
              <div>
                <label className={labelClass}>{t('resource.offset', { defaultValue: '偏移 (ms)' })}</label>
                <input className={inputClass} type="number" min={0} value={offset} onChange={e => setOffset(e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>{t('resource.duration', { defaultValue: '时长 (ms)' })}</label>
                <input className={inputClass} type="number" min={0} value={duration} onChange={e => setDuration(e.target.value)} />
              </div>
              <div className="flex items-end">
                <button onClick={submit} className="w-full px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:opacity-90">
                  {t('resource.add', { defaultValue: '添加' })}
                </button>
              </div>
            </div>
          </section>
        </div>
        <div className="flex justify-end px-5 py-3 border-t">
          <button onClick={onClose} className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.close', { defaultValue: '关闭' })}
          </button>
        </div>
      </div>
    </div>
  )
}
