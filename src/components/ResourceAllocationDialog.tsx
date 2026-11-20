import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { AllocationEventPoint, AllocationEventRef, ResourceAllocation } from '@/types'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { computeSchedule } from '@/lib/dependencyEngine'
import { clampAllocationWindow, resolveEventTime } from '@/lib/resourceScheduler'
import { checkNewName, translateNameIssue } from '@/lib/nameValidation'
import { AlertTriangle } from 'lucide-react'

/**
 * Edit the exact-window resource claims of one action. Two modes:
 *  - manual: offset + duration relative to this action's start (legacy);
 *  - event: window anchored to two real task events, which may be different
 *    actions (e.g. claim on grip-start, release on inject-end).
 * Both follow dependency cascades because their times come from the schedule.
 */
interface Props {
  taskId: string | null
  onClose: () => void
}

const emptyRef = (): AllocationEventRef => ({ taskId: '', at: 'start', offsetMs: 0 })

export const ResourceAllocationDialog: React.FC<Props> = ({ taskId, onClose }) => {
  const { t } = useTranslation()
  const {
    project, addResource, addAllocation, updateAllocation, removeAllocation
  } = useProjectStore()

  const [newResourceId, setNewResourceId] = useState('')
  const [newSlotMode, setNewSlotMode] = useState<'fixed' | 'activeSlot'>('fixed')
  const [mode, setMode] = useState<'manual' | 'event'>('manual')
  const [offset, setOffset] = useState('0')
  const [duration, setDuration] = useState('0')
  const [startRef, setStartRef] = useState<AllocationEventRef>(emptyRef())
  const [endRef, setEndRef] = useState<AllocationEventRef>(emptyRef())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // In-app replacement for window.prompt(), which Electron disables (returns
  // null silently). Keeps the quick-add flow working in both web and desktop.
  const [quickName, setQuickName] = useState('')
  const [quickAdding, setQuickAdding] = useState(false)

  const cfg = useMemo(
    () => normalizeTimeConfig(project?.timeConfig),
    [project?.timeConfig]
  )
  // Hooks must run before any early return (a previous version crashed the
  // renderer when a hook sat after a return).
  const schedule = useMemo(
    () => computeSchedule(project?.modules ?? [], cfg),
    [project?.modules, cfg]
  )

  const task = taskId ? project?.modules.find(m => m.id === taskId) : undefined
  const claims = taskId ? project?.allocations.filter(a => a.taskId === taskId) ?? [] : []
  const resources = project?.resources ?? []
  const schedulable = (project?.modules ?? []).filter(m => m.kind === 'action' || m.kind === 'subaction')

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'

  if (!taskId || !project || !task) return null

  const taskDurationMs = task.durationMs ?? task.moveCount * task.duration ?? 0
  const resourceName = (id: string) => resources.find(r => r.id === id)?.name ?? id
  const taskLabel = (id: string) => {
    const node = project.modules.find(m => m.id === id)
    return node ? `${node.code ?? ''} ${node.actionDescription || node.moduleName}`.trim() : id
  }

  const eventStart = startRef.taskId ? resolveEventTime(startRef, schedule) : undefined
  const eventEnd = endRef.taskId ? resolveEventTime(endRef, schedule) : undefined
  const eventValid = eventStart !== undefined && eventEnd !== undefined && eventEnd > eventStart

  const resetForm = () => {
    setNewResourceId('')
    setNewSlotMode('fixed')
    setMode('manual')
    setOffset('0')
    setDuration('0')
    setStartRef(emptyRef())
    setEndRef(emptyRef())
    setEditingId(null)
  }

  const loadForEdit = (a: ResourceAllocation) => {
    setEditingId(a.id)
    setNewResourceId(a.resourceId)
    setNewSlotMode(a.slotMode ?? 'fixed')
    const isEvent = a.bindMode === 'event'
    setMode(isEvent ? 'event' : 'manual')
    setOffset(String(a.offsetMs))
    setDuration(String(a.durationMs))
    setStartRef(a.startRef ?? emptyRef())
    setEndRef(a.endRef ?? emptyRef())
    setError(null)
  }

  const submit = () => {
    if (!newResourceId) {
      setError(t('resource.needResource', { defaultValue: '请先选择或新建一个资源' }))
      return
    }
    const resourceId = newResourceId

    let patch: Omit<ResourceAllocation, 'id'>
    if (mode === 'event') {
      if (!startRef.taskId || !endRef.taskId) {
        setError(t('resource.needEventTasks', { defaultValue: '请选择占用开始动作与释放动作' }))
        return
      }
      if (!project.modules.some(m => m.id === startRef.taskId)
        || !project.modules.some(m => m.id === endRef.taskId)) {
        setError(t('resource.eventTaskMissing', { defaultValue: '引用的动作已不存在' }))
        return
      }
      if (!eventValid) {
        setError(t('resource.eventOrder', { defaultValue: '释放事件必须晚于占用事件' }))
        return
      }
      patch = {
        taskId, resourceId, slotMode: newSlotMode,
        offsetMs: 0, durationMs: 0,
        bindMode: 'event', startRef, endRef
      }
    } else {
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
      patch = {
        taskId, resourceId, slotMode: newSlotMode,
        ...clamped,
        bindMode: 'manual', startRef: undefined, endRef: undefined
      }
    }

    if (editingId) {
      updateAllocation(editingId, patch)
    } else if (!addAllocation(patch)) {
      setError(t('resource.addFailed', { defaultValue: '添加占用失败，请检查引用是否有效' }))
      return
    }
    setError(null)
    resetForm()
  }

  const quickAddResource = () => {
    const name = quickName.trim()
    if (!name) return
    const verdict = checkNewName(project, 'resource', name)
    if (!verdict.ok) {
      setError(translateNameIssue({ scope: 'resource', id: '', name, reason: verdict.reason ?? 'duplicate' }, t))
      return
    }
    const id = addResource({ name })
    if (!id) {
      setError(t('nameIssue.duplicateResource', { defaultValue: '资源名称重复：{{name}}', name }))
      return
    }
    setNewResourceId(id)
    setQuickName('')
    setQuickAdding(false)
    setError(null)
  }

  const editRef = (which: 'start' | 'end', patch: Partial<AllocationEventRef>) => {
    const setter = which === 'start' ? setStartRef : setEndRef
    setter(prev => ({ ...prev, ...patch }))
  }

  const refSelectors = (which: 'start' | 'end', ref: AllocationEventRef) => (
    <div className="col-span-3 grid grid-cols-3 gap-2 border rounded p-2 bg-muted/30">
      <div className="col-span-3 text-xs text-muted-foreground">
        {which === 'start'
          ? t('resource.startEvent', { defaultValue: '占用开始事件' })
          : t('resource.endEvent', { defaultValue: '释放事件' })}
      </div>
      <select className={inputClass} value={ref.taskId}
        onChange={e => editRef(which, { taskId: e.target.value })}>
        <option value="">{t('resource.selectAction', { defaultValue: '（选择动作）' })}</option>
        {schedulable.map(m => <option key={m.id} value={m.id}>{taskLabel(m.id)}</option>)}
      </select>
      <select className={inputClass} value={ref.at}
        onChange={e => editRef(which, { at: e.target.value as AllocationEventPoint })}>
        <option value="start">{t('resource.atStart', { defaultValue: '开始时' })}</option>
        <option value="end">{t('resource.atEnd', { defaultValue: '结束时' })}</option>
      </select>
      <input className={inputClass} type="number" value={ref.offsetMs ?? 0}
        title={t('resource.eventOffsetHint', { defaultValue: '相对事件的微调（ms，可为负）' })}
        onChange={e => editRef(which, { offsetMs: Number(e.target.value) || 0 })} />
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[600px] max-w-[95vw] max-h-[88vh] overflow-y-auto border">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-background z-10">
          <h2 className="text-base font-semibold">{t('resource.allocTitle', { defaultValue: '资源占用' })} — {task.actionDescription}</h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/40 border rounded p-2">
            {t('resource.allocHint', { defaultValue: '占用窗口可手动填写偏移与时长，也可绑定到真实动作的开始/结束事件。任一方式下，依赖顺延时窗口都会自动跟随。同一资源窗口重叠仅提示，不改时序。' })}
            <div className="mt-1 tabular-nums">{t('resource.taskDuration', { defaultValue: '动作时长' })}: {taskDurationMs} ms</div>
          </div>

          {claims.length > 0 && (
            <section className="border rounded-lg divide-y">
              {claims.map(a => {
                const isEvent = a.bindMode === 'event'
                const s = isEvent ? resolveEventTime(a.startRef, schedule) : undefined
                const e = isEvent ? resolveEventTime(a.endRef, schedule) : undefined
                return (
                  <div key={a.id} className="px-3 py-2 text-sm space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium flex-1 truncate">{resourceName(a.resourceId)}</span>
                      {isEvent ? (
                        <span className="text-[10px] px-1 rounded bg-primary/10 text-primary"
                          title={t('resource.eventModeHint', { defaultValue: '窗口由起止动作事件决定' })}>
                          {t('resource.eventMode', { defaultValue: '绑定动作' })}
                        </span>
                      ) : null}
                      {a.slotMode === 'activeSlot' && (
                        <span className="text-[10px] px-1 rounded bg-primary/10 text-primary"
                          title={t('resource.activeSlotHint', { defaultValue: '按动作所属周期解析到当前选中槽位' })}>
                          {t('resource.activeSlot', { defaultValue: '当前槽位' })}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {isEvent
                          ? (s !== undefined && e !== undefined ? `${s}–${e}` : t('resource.invalidRef', { defaultValue: '引用失效' }))
                          : `${a.offsetMs}–${a.offsetMs + a.durationMs}`}
                      </span>
                      <button onClick={() => loadForEdit(a)}
                        className="px-1.5 text-xs border rounded hover:bg-accent"
                        title={t('common.edit', { defaultValue: '编辑' })}>✎</button>
                      <button onClick={() => { if (editingId === a.id) resetForm(); removeAllocation(a.id) }}
                        className="px-1.5 text-red-500 hover:bg-red-500/10 rounded"
                        title={t('resource.removeClaim', { defaultValue: '删除占用' })}>×</button>
                    </div>
                    {isEvent && (
                      <div className="text-xs text-muted-foreground">
                        {taskLabel(a.startRef?.taskId ?? '')} · {a.startRef?.at === 'end'
                          ? t('resource.atEnd', { defaultValue: '结束时' }) : t('resource.atStart', { defaultValue: '开始时' })}
                        {' → '}
                        {taskLabel(a.endRef?.taskId ?? '')} · {a.endRef?.at === 'end'
                          ? t('resource.atEnd', { defaultValue: '结束时' }) : t('resource.atStart', { defaultValue: '开始时' })}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          )}

          {error && (
            <div className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{error}</div>
          )}

          <section className="border rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {editingId ? t('resource.editClaim', { defaultValue: '编辑占用' }) : t('resource.addClaim', { defaultValue: '添加占用' })}
              </h3>
              {editingId && (
                <button onClick={resetForm} className="text-xs text-muted-foreground hover:underline">
                  {t('resource.cancelEdit', { defaultValue: '取消编辑' })}
                </button>
              )}
            </div>
            <div className="flex gap-1 border-b pb-2">
              {(['manual', 'event'] as const).map(m => (
                <button key={m} onClick={() => { setMode(m); setError(null) }}
                  className={`px-3 py-1 text-xs rounded ${mode === m ? 'bg-primary text-primary-foreground' : 'border hover:bg-accent'}`}>
                  {m === 'manual'
                    ? t('resource.manualMode', { defaultValue: '手动时长' })
                    : t('resource.eventMode', { defaultValue: '绑定动作' })}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-3">
                <label className="block text-xs text-muted-foreground mb-1">{t('resource.selectResource', { defaultValue: '资源' })}</label>
                <div className="flex gap-2">
                  <select className={inputClass} value={newResourceId} onChange={e => { setNewResourceId(e.target.value); setError(null) }}>
                    <option value="">
                      {resources.length === 0
                        ? t('resource.noResource', { defaultValue: '（无资源，请先新建）' })
                        : t('resource.selectPlaceholder', { defaultValue: '（请选择资源）' })}
                    </option>
                    {resources.map(r => <option key={r.id} value={r.id}>{r.name}{r.type ? ` · ${r.type}` : ''}</option>)}
                  </select>
                  <button onClick={() => setQuickAdding(v => !v)} className="px-2 border rounded hover:bg-accent whitespace-nowrap text-xs">
                    {t('resource.new', { defaultValue: '新建' })}
                  </button>
                </div>
                {quickAdding && (
                  <div className="flex gap-2 mt-2">
                    <input
                      autoFocus
                      className={inputClass}
                      value={quickName}
                      placeholder={t('resource.newName', { defaultValue: '新资源名称（如 管库抓手）' })}
                      onChange={e => setQuickName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); quickAddResource() } }}
                    />
                    <button onClick={quickAddResource} className="px-3 border rounded bg-primary text-primary-foreground hover:opacity-90 whitespace-nowrap text-xs">
                      {t('resource.add', { defaultValue: '添加' })}
                    </button>
                  </div>
                )}
              </div>
              <div className="col-span-3">
                <label className="block text-xs text-muted-foreground mb-1">{t('resource.targetMode', { defaultValue: '占用目标' })}</label>
                <select className={inputClass} value={newSlotMode} onChange={e => setNewSlotMode(e.target.value as 'fixed' | 'activeSlot')}>
                  <option value="fixed">{t('resource.fixedSlot', { defaultValue: '该资源本身' })}</option>
                  <option value="activeSlot">{t('resource.activeSlot', { defaultValue: '当前选中槽位（旋转盘）' })}</option>
                </select>
              </div>

              {mode === 'manual' ? (
                <>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">{t('resource.offset', { defaultValue: '偏移 (ms)' })}</label>
                    <input className={inputClass} type="number" min={0} value={offset} onChange={e => setOffset(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">{t('resource.duration', { defaultValue: '时长 (ms)' })}</label>
                    <input className={inputClass} type="number" min={0} value={duration} onChange={e => setDuration(e.target.value)} />
                  </div>
                  <div className="flex items-end text-xs text-muted-foreground tabular-nums">
                    {t('resource.window', { defaultValue: '窗口' })}: {Number(offset) || 0}–{(Number(offset) || 0) + (Number(duration) || 0)}
                  </div>
                </>
              ) : (
                <>
                  {refSelectors('start', startRef)}
                  {refSelectors('end', endRef)}
                  <div className="col-span-3 text-xs tabular-nums flex items-center gap-2">
                    <span className="text-muted-foreground">{t('resource.window', { defaultValue: '窗口' })}:</span>
                    {eventValid
                      ? <span className="text-foreground">{eventStart}–{eventEnd} ({eventEnd! - eventStart!} ms)</span>
                      : <span className="text-red-400">{t('resource.eventPreviewInvalid', { defaultValue: '请选择有效的起止动作事件' })}</span>}
                  </div>
                </>
              )}

              <div className="col-span-3 flex justify-end">
                <button onClick={submit} className="px-4 py-1 text-sm rounded bg-primary text-primary-foreground hover:opacity-90">
                  {editingId ? t('resource.save', { defaultValue: '保存' }) : t('resource.add', { defaultValue: '添加' })}
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
