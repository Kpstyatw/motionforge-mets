import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { resourceDepth } from '@/lib/resourceTree'
import { checkNewName, findNameIssues, NameIssue, translateNameIssue } from '@/lib/nameValidation'
import { toast } from '@/components/ui/use-toast'
import { Resource } from '@/types'
import { Plus, Trash2, ChevronRight, ChevronDown } from 'lucide-react'

/** Global resource catalogue editor: physical-module → abstract-resource mapping. */
interface Props {
  isOpen: boolean
  onClose: () => void
}

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#ec4899']

/** Order resources parent-first so children render under their parent. */
function treeOrder(resources: Resource[]): Resource[] {
  const out: Resource[] = []
  const seen = new Set<string>()
  const visit = (parentId: string | undefined) => {
    resources.filter(r => (r.parentId ?? undefined) === parentId).forEach(r => {
      if (seen.has(r.id)) return
      seen.add(r.id)
      out.push(r)
      visit(r.id)
    })
  }
  visit(undefined)
  resources.forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); out.push(r) } })
  return out
}

export const ResourceManagerDialog: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const {
    project, addResource, updateResource, removeResource, setResourceMotion, addChildResource
  } = useProjectStore()
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Name edits stay local until blur, so a rejected duplicate never silently
  // replaces the stored name while the user is still typing.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => { if (!isOpen) setDrafts({}) }, [isOpen])
  const duplicateIds = useMemo(
    () => new Set(findNameIssues(project).filter(i => i.scope === 'resource' && i.reason === 'duplicate').map(i => i.id)),
    [project]
  )

  if (!isOpen || !project) return null
  const resources = treeOrder(project.resources)

  const rejectName = (issue: NameIssue) => {
    toast({
      variant: 'destructive',
      title: t('nameIssue.title', { defaultValue: '名称重复，无法保存' }),
      description: translateNameIssue(issue, t)
    })
  }

  const commitName = (r: Resource, text: string) => {
    const trimmed = text.trim()
    const issue: NameIssue = {
      scope: 'resource', id: r.id, name: trimmed,
      reason: trimmed ? 'duplicate' : 'empty'
    }
    if (!trimmed || !updateResource(r.id, { name: trimmed })) {
      rejectName(issue)
      setDrafts(prev => ({ ...prev, [r.id]: r.name }))
      return
    }
    setDrafts(prev => {
      const next = { ...prev }
      delete next[r.id]
      return next
    })
  }

  const submit = () => {
    const trimmed = name.trim()
    const verdict = checkNewName(project, 'resource', trimmed)
    if (!verdict.ok) {
      rejectName({ scope: 'resource', id: '', name: trimmed, reason: verdict.reason ?? 'duplicate' })
      return
    }
    const id = addResource({ name: trimmed, type: type.trim() || undefined, color: PALETTE[resources.length % PALETTE.length] })
    if (!id) {
      rejectName({ scope: 'resource', id: '', name: trimmed, reason: 'duplicate' })
      return
    }
    setName('')
    setType('')
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[680px] max-w-[95vw] max-h-[88vh] overflow-y-auto border">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-background z-10">
          <h2 className="text-base font-semibold">{t('resource.managerTitle', { defaultValue: '资源管理（物理模块 → 抽象资源）' })}</h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/40 border rounded p-2">
            {t('resource.managerHint', { defaultValue: '模块 / 机构是仪器里的物理模块；资源是在物理模块与流程基础上抽象出的可占用单元。机构可在任务编辑器里映射到资源，映射后其下动作执行期自动占用该资源。' })}
          </div>

          <section className="border rounded-lg divide-y">
            {resources.map(r => {
              const depth = resourceDepth(r.id, project.resources)
              const childCount = project.resources.filter(x => x.parentId === r.id).length
              const usage = project.allocations.filter(a => a.resourceId === r.id).length
              const isOpen = expanded[r.id] !== false
              const motion = r.motion
              return (
                <div key={r.id} className="px-3 py-2" style={{ paddingLeft: 12 + depth * 18 }}>
                  <div className="flex items-center gap-2">
                    {childCount > 0 ? (
                      <button onClick={() => setExpanded(e => ({ ...e, [r.id]: !isOpen }))} className="p-0.5 text-muted-foreground">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    ) : <span className="w-4" />}
                    <input type="color" value={r.color || '#6366f1'} className="w-7 h-7 border-0 bg-transparent p-0 cursor-pointer"
                      onChange={e => updateResource(r.id, { color: e.target.value })} />
                    <input
                      className={`flex-1 min-w-0 px-1 py-0.5 text-sm border rounded bg-background ${duplicateIds.has(r.id) ? 'border-red-500 text-red-500' : ''}`}
                      value={drafts[r.id] ?? r.name}
                      onChange={e => setDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                      onBlur={e => commitName(r, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      title={duplicateIds.has(r.id) ? translateNameIssue({ scope: 'resource', id: r.id, name: r.name, reason: 'duplicate' }, t) : undefined}
                    />
                    <input className="w-24 px-1 py-0.5 text-xs border rounded bg-background" value={r.type ?? ''} placeholder={t('resource.type', { defaultValue: '类型' })}
                      onChange={e => updateResource(r.id, { type: e.target.value })} />
                    {r.slotIndex !== undefined && (
                      <span className="text-[10px] text-muted-foreground tabular-nums" title={t('resource.slotIndex', { defaultValue: '槽位索引' })}>
                        #{r.slotIndex}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground w-16 text-right tabular-nums">{usage} {t('resource.uses', { defaultValue: '处引用' })}</span>
                    {!r.parentId && (
                      <button onClick={() => addChildResource(r.id)} className="p-1 text-primary hover:bg-primary/10 rounded"
                        title={t('resource.addSlot', { defaultValue: '添加子槽位' })}>
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button onClick={() => removeResource(r.id)} className="p-1 text-red-500 hover:bg-red-500/10 rounded" title={t('resource.remove', { defaultValue: '删除资源' })}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {isOpen && !r.parentId && (
                    <div className="mt-1.5 ml-6 flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={Boolean(motion)} onChange={e => {
                          if (e.target.checked) setResourceMotion(r.id, { type: 'rotary', slots: Math.max(1, childCount || 8), stepPerCycle: 1, startSlot: 0 })
                          else setResourceMotion(r.id, null)
                        }} />
                        {t('resource.rotary', { defaultValue: '旋转' })}
                      </label>
                      {motion && (
                        <>
                          <label>{t('resource.slots', { defaultValue: '槽位数' })}
                            <input className="w-12 ml-1 px-1 border rounded bg-background tabular-nums" type="number" min={1} max={360}
                              value={motion.slots} onChange={e => setResourceMotion(r.id, { ...motion, slots: Number(e.target.value) })} />
                          </label>
                          <label>{t('resource.step', { defaultValue: '每周期步进' })}
                            <input className="w-12 ml-1 px-1 border rounded bg-background tabular-nums" type="number"
                              value={motion.stepPerCycle} onChange={e => setResourceMotion(r.id, { ...motion, stepPerCycle: Number(e.target.value) })} />
                          </label>
                          <label>{t('resource.startSlotLabel', { defaultValue: '起始槽' })}
                            <input className="w-12 ml-1 px-1 border rounded bg-background tabular-nums" type="number" min={0}
                              value={motion.startSlot ?? 0} onChange={e => setResourceMotion(r.id, { ...motion, startSlot: Number(e.target.value) })} />
                          </label>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {resources.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">{t('resource.emptyShort', { defaultValue: '暂无资源' })}</div>
            )}
          </section>

          <section className="border rounded-lg p-3 flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-xs text-muted-foreground mb-1">{t('resource.nameLabel', { defaultValue: '名称' })}</label>
              <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder={t('resource.newName', { defaultValue: '新资源名称（如 管库抓手）' })} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
            </div>
            <div className="w-28">
              <label className="block text-xs text-muted-foreground mb-1">{t('resource.type', { defaultValue: '类型' })}</label>
              <input className={inputClass} value={type} onChange={e => setType(e.target.value)} placeholder="gripper" />
            </div>
            <button onClick={submit} className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1">
              <Plus className="h-3.5 w-3.5" />{t('resource.add', { defaultValue: '添加' })}
            </button>
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
