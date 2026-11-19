import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { computeSchedule } from '@/lib/dependencyEngine'
import { normalizeTimeConfig } from '@/lib/timeScale'
import { checkNewName, NameIssue, translateNameIssue } from '@/lib/nameValidation'
import { toast } from '@/components/ui/use-toast'
import { TaskKind } from '@/types'
import { Plus } from 'lucide-react'

interface AddNodeDialogProps {
  parentId: string | null
  onClose: () => void
  onCreated?: (id: string) => void
}

const KINDS: TaskKind[] = ['module', 'mechanism', 'action', 'subaction']
const KIND_LABEL: Record<TaskKind, string> = {
  module: '模块', mechanism: '机构', action: '动作', subaction: '子动作'
}

/** Add an action or a (recursively nestable) sub-action under any node. */
export const AddNodeDialog: React.FC<AddNodeDialogProps> = ({ parentId, onClose, onCreated }) => {
  const { t } = useTranslation()
  const { project, addAction } = useProjectStore()
  const { setSelectedTask } = useUIStore()
  const config = normalizeTimeConfig(project?.timeConfig)
  const schedule = useMemo(
    () => computeSchedule(project?.modules ?? [], config),
    [project?.modules, config.scaleMs, config.precisionMs, config.displayUnit]
  )
  const parent = parentId ? schedule.byId[parentId] : undefined

  const defaultKind = (): TaskKind => {
    if (!parent) return 'module'
    if (parent.kind === 'module') return 'mechanism'
    if (parent.kind === 'mechanism') return 'action'
    return 'subaction'
  }
  const [kind, setKind] = useState<TaskKind>(defaultKind())
  const [name, setName] = useState('')
  const [durationMs, setDurationMs] = useState(String(config.scaleMs * 10))
  const [startMs, setStartMs] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setKind(defaultKind())
    setName('')
    setDurationMs(String(config.scaleMs * 10))
    setStartMs(parent ? String(parent.startMs) : '0')
  }, [parentId, parent?.kind, config.scaleMs])

  // Focus synchronously on mount. React's `autoFocus` can be delayed when the
  // renderer composes a full-screen translucent overlay on a slow/eGPU-less
  // display, which reads as "the field is greyed out for a second". Taking
  // focus in a layout effect guarantees the caret is in the field the moment
  // the dialog paints.
  useLayoutEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  const isSummary = kind === 'module' || kind === 'mechanism'
  const submit = () => {
    const trimmed = name.trim()
    if (isSummary && trimmed) {
      const verdict = checkNewName(project, 'node', trimmed)
      if (!verdict.ok) {
        const issue: NameIssue = { scope: 'node', id: '', name: trimmed, kind, reason: verdict.reason ?? 'duplicate' }
        toast({ variant: 'destructive', title: t('nameIssue.title', { defaultValue: '名称重复，无法保存' }), description: translateNameIssue(issue, t) })
        return
      }
    }
    const id = addAction({
      parentId,
      kind,
      // A blank name lets the store pick a unique default instead of creating
      // the second "新模块" / "新机构" in the same project.
      actionDescription: trimmed || undefined,
      durationMs: isSummary ? 0 : Math.max(0, Number(durationMs) || config.scaleMs * 10),
      startMs: Math.max(0, Number(startMs) || 0)
    })
    if (!id) {
      toast({ variant: 'destructive', title: t('nameIssue.title', { defaultValue: '名称重复，无法保存' }), description: t('nameIssue.blocked', { defaultValue: '请先修改重复或空名称后再保存' }) })
      return
    }
    setSelectedTask(id)
    onCreated?.(id)
    onClose()
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'
  const labelClass = 'block text-xs text-muted-foreground mb-1'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[400px] max-w-[95vw] border">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Plus className="h-4 w-4" />{t('gantt.addNode', { defaultValue: '新增层级节点' })}
          </h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-xs text-muted-foreground">
            {parent
              ? `${t('gantt.parent', { defaultValue: '上级' })}：${parent.code} ${parent.module.actionDescription}（${KIND_LABEL[parent.kind]}）`
              : t('gantt.rootHint', { defaultValue: '将创建顶层模块' })}
          </div>
          <div>
            <label className={labelClass}>{t('gantt.nodeKind', { defaultValue: '节点类型' })}</label>
            <select className={inputClass} value={kind} onChange={e => setKind(e.target.value as TaskKind)}>
              {KINDS.map(k => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">
              {t('gantt.nestHint', { defaultValue: '子动作可作为另一个子动作的上级，层数不限。' })}
            </p>
          </div>
          <div>
            <label className={labelClass}>{t('gantt.name', { defaultValue: '名称' })}</label>
            <input ref={nameRef} className={inputClass} value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()} />
          </div>
          {!isSummary && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('gantt.start', { defaultValue: '开始 (ms)' })}</label>
                <input className={inputClass} type="number" value={startMs} onChange={e => setStartMs(e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>{t('gantt.duration', { defaultValue: '持续 (ms)' })}</label>
                <input className={inputClass} type="number" value={durationMs} onChange={e => setDurationMs(e.target.value)} />
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t">
          <button onClick={onClose} className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.cancel', { defaultValue: '取消' })}
          </button>
          <button onClick={submit} className="px-4 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90">
            {t('dialog.add', { defaultValue: '添加' })}
          </button>
        </div>
      </div>
    </div>
  )
}
