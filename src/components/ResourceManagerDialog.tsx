import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { resourceDepth, buildResourceOwnerIndex, filterResourceRows } from '@/lib/resourceTree'
import { checkNewName, findNameIssues, NameIssue, translateNameIssue } from '@/lib/nameValidation'
import { toast } from '@/components/ui/use-toast'
import { Resource } from '@/types'
import { Plus, Trash2, ChevronRight, ChevronDown, Pencil } from 'lucide-react'

/** Global resource catalogue editor: physical-module → abstract-resource mapping. */
interface Props {
  isOpen: boolean
  onClose: () => void
  /** When opened from a resource lane, scroll to and highlight this resource. */
  focusResourceId?: string | null
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

export const ResourceManagerDialog: React.FC<Props> = ({ isOpen, onClose, focusResourceId }) => {
  const { t } = useTranslation()
  const {
    project, addResource, updateResource, removeResource, setResourceMotion, addChildResource,
    setResourceOwner, addAction
  } = useProjectStore()
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  // Owner chosen in the "new resource" form. Pre-filled from the focused
  // resource so adding a sibling under the same module/mechanism is one click.
  const [newOwnerId, setNewOwnerId] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Which resource's owner picker is currently showing the "new node" form.
  const [addingOwnerFor, setAddingOwnerFor] = useState<string | null>(null)
  const [newOwnerName, setNewOwnerName] = useState('')
  const [newOwnerKind, setNewOwnerKind] = useState<'mechanism' | 'module'>('mechanism')
  const [newOwnerParent, setNewOwnerParent] = useState('')
  // Name edits stay local until blur, so a rejected duplicate never silently
  // replaces the stored name while the user is still typing.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // Editing vs creating are two different actions. When opened from a lane
  // pencil (focusResourceId set) collapse the "add new" form so there is only
  // ONE name field on screen; users can still expand it to create another one.
  const [showAddForm, setShowAddForm] = useState(!focusResourceId)
  // The catalogue is hidden until asked for: opening the manager to add a
  // resource should not dump a long list on screen. Focus-edit mode always
  // shows its one resource regardless of this flag.
  const [listVisible, setListVisible] = useState(Boolean(focusResourceId))
  const [search, setSearch] = useState('')
  // Focus-edit mode: when opened from a lane (or a row's edit action), show
  // ONLY that resource with full details. Null means the full compact list.
  const [onlyId, setOnlyId] = useState<string | null>(focusResourceId ?? null)
  // Focus handling: opened from a lane row → expand its ancestors, scroll to
  // and highlight that row. Runs once per open/focus pair so later edits do not
  // keep yanking the scroll position back.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lastFocus = useRef<string | null>(null)
  const [focusPulse, setFocusPulse] = useState<string | null>(null)
  useEffect(() => {
    if (!isOpen) { setDrafts({}); lastFocus.current = null; setFocusPulse(null); setSearch(''); setNewOwnerId('') }
    else {
      setShowAddForm(!focusResourceId)
      setOnlyId(focusResourceId ?? null)
      setListVisible(Boolean(focusResourceId))
      // Default the new-resource owner to the focused resource's owner, so a
      // sibling resource lands in the same module/mechanism lane by default.
      const focused = focusResourceId
        ? useProjectStore.getState().project?.resources.find(r => r.id === focusResourceId)
        : undefined
      setNewOwnerId(focused?.ownerNodeId ?? '')
    }
  }, [isOpen, focusResourceId])
  useEffect(() => {
    if (!isOpen || !focusResourceId || !project) return
    const key = `${isOpen}:${focusResourceId}`
    if (lastFocus.current === key) return
    lastFocus.current = key
    const byId = new Map(project.resources.map(r => [r.id, r]))
    const chain: string[] = []
    let cur = byId.get(focusResourceId)
    const guard = new Set<string>()
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id)
      chain.push(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    setExpanded(prev => {
      const next = { ...prev }
      chain.forEach(id => { next[id] = true })
      return next
    })
    setFocusPulse(focusResourceId)
    const timer = window.setTimeout(() => {
      rowRefs.current[focusResourceId]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [isOpen, focusResourceId, project])
  const duplicateIds = useMemo(
    () => new Set(findNameIssues(project).filter(i => i.scope === 'resource' && i.reason === 'duplicate').map(i => i.id)),
    [project]
  )

  if (!isOpen || !project) return null
  const allResources = treeOrder(project.resources)
  // Focus-edit mode narrows the list to a single resource with its full detail.
  const resources = onlyId
    ? allResources.filter(r => r.id === onlyId)
    : allResources
  const focusResource = onlyId ? allResources.find(r => r.id === onlyId) : undefined

  // Reverse index: resource id → owning flow node, derived the same way as
  // the resource-lane view, so the dropdown always mirrors what the chart shows.
  const ownerIndex = buildResourceOwnerIndex(project.modules, project.resources)
  // Focus-edit bypasses search (a single known row). The full catalogue can be
  // narrowed by name, type or owning node.
  const visibleResources = onlyId ? resources : filterResourceRows(resources, ownerIndex, search)
  const moduleById = new Map(project.modules.map(m => [m.id, m]))
  const nodeName = (m: { moduleName?: string; actionDescription?: string; code?: string; id: string }) =>
    m.moduleName || m.actionDescription || m.code || m.id
  // Ownership options mirror the flow tree: modules and their mechanisms.
  const moduleOptions = project.modules.filter(m => m.kind === 'module')
  const mechanismOptions = project.modules.filter(m => m.kind === 'mechanism').map(m => {
    const parent = m.parentId ? moduleById.get(m.parentId) : undefined
    const moduleName = parent ? nodeName(parent) : ''
    return { id: m.id, label: moduleName ? `${moduleName} / ${nodeName(m)}` : nodeName(m) }
  })

  // Create a new module/mechanism in the FLOW tree and bind it as the owner.
  // Both views read project.modules, so the flow chart gains the node instantly.
  const createAndAssignOwner = (resourceId: string) => {
    const trimmed = newOwnerName.trim()
    if (!trimmed) return
    const parentId = newOwnerKind === 'mechanism'
      ? (newOwnerParent || moduleOptions[0]?.id || null)
      : null
    const nodeId = addAction({
      kind: newOwnerKind,
      parentId,
      moduleName: trimmed,
      actionDescription: trimmed
    })
    if (nodeId) setResourceOwner(resourceId, nodeId)
    setAddingOwnerFor(null)
    setNewOwnerName('')
    setNewOwnerKind('mechanism')
    setNewOwnerParent('')
  }

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
    const id = addResource({
      name: trimmed,
      type: type.trim() || undefined,
      color: PALETTE[resources.length % PALETTE.length],
      ownerNodeId: newOwnerId || undefined
    })
    if (!id) {
      rejectName({ scope: 'resource', id: '', name: trimmed, reason: 'duplicate' })
      return
    }
    setName('')
    setType('')
    // Keep newOwnerId so consecutive additions stay in the same lane.
    // The catalogue stays collapsed after adding, so confirm the write here
    // instead of making the user open the list to check.
    toast({
      title: t('resource.added', { defaultValue: '资源已添加', name: trimmed }),
      description: t('resource.addedHint', { defaultValue: '展开「已有资源」可查看或继续编辑。' })
    })
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[680px] max-w-[95vw] max-h-[88vh] overflow-y-auto border">
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b sticky top-0 bg-background z-10">
          {onlyId && focusResource ? (
            <div className="flex items-center gap-2 min-w-0">
              <button onClick={() => setOnlyId(null)} className="px-2 py-1 text-xs border rounded hover:bg-accent whitespace-nowrap"
                title={t('resource.showAllTip', { defaultValue: '返回资源列表，显示全部资源' })}>
                ← {t('resource.showAll', { defaultValue: '全部资源' })}
              </button>
              <h2 className="text-base font-semibold truncate">
                {t('resource.editOneTitle', { defaultValue: '编辑资源' })} · {focusResource.name}
              </h2>
            </div>
          ) : (
            <h2 className="text-base font-semibold">{t('resource.managerTitle', { defaultValue: '资源管理（物理模块 → 抽象资源）' })}</h2>
          )}
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground shrink-0">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/40 border rounded p-2">
            {t('resource.managerHint', { defaultValue: '模块 / 机构是仪器里的物理模块；资源是在物理模块与流程基础上抽象出的可占用单元。把资源归属到某模块/机构只表示层级分组，不会让该节点下的动作自动占用资源。占用时间请在流程甘特图里为动作设置。' })}
          </div>
          {(focusPulse || onlyId) && (
            <div className="text-xs text-primary bg-primary/5 border border-primary/20 rounded p-2">
              {t('resource.editFocusHint', { defaultValue: '当前只显示选中资源：直接改名称 / 类型 / 归属 / 旋转即可，改完自动保存。点左上「全部资源」返回列表。' })}
            </div>
          )}

          {!onlyId && (
            <button onClick={() => setListVisible(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs border rounded-lg hover:bg-accent/50">
              <span className="flex items-center gap-1 font-medium">
                {listVisible ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {t('resource.existingResources', { defaultValue: '已有资源', count: resources.length })}
              </span>
              <span className="text-muted-foreground">{listVisible ? '−' : '+'}</span>
            </button>
          )}
          {!onlyId && listVisible && (
            <input className={inputClass} value={search} onChange={e => setSearch(e.target.value)}
              placeholder={t('resource.searchResources', { defaultValue: '搜索名称 / 类型 / 归属' })} />
          )}
          {(listVisible || onlyId) && (
          <section className="border rounded-lg divide-y max-h-[320px] overflow-y-auto">
            {visibleResources.map(r => {
              const depth = resourceDepth(r.id, project.resources)
              const childCount = project.resources.filter(x => x.parentId === r.id).length
              const usage = project.allocations.filter(a => a.resourceId === r.id).length
              // Collapsed by default: a large catalogue stays one line per resource.
              // In focus-edit mode (only this resource shown) force its detail open
              // so owner / rotation are editable without an extra click.
              const isOpen = Boolean(onlyId) || expanded[r.id] === true
              const motion = r.motion
              return (
                <div key={r.id} ref={el => { rowRefs.current[r.id] = el }}
                  className={`px-3 py-2 rounded ${focusPulse === r.id ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`}
                  style={{ paddingLeft: 12 + depth * 18 }}>
                  {/* Compact row — always visible, one line per resource. Full owner
                      control and rotation settings live in the collapsible detail below. */}
                  <div className="flex items-center gap-2">
                    {onlyId ? (
                      <span className="p-0.5 text-muted-foreground shrink-0"><ChevronDown className="h-3.5 w-3.5" /></span>
                    ) : (
                      <button onClick={() => setExpanded(e => ({ ...e, [r.id]: !isOpen }))} className="p-0.5 text-muted-foreground shrink-0"
                        title={t('resource.toggleDetail', { defaultValue: '展开/收起详细设置（归属、旋转）' })}>
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    <input type="color" value={r.color || '#6366f1'} className="w-7 h-7 border-0 bg-transparent p-0 cursor-pointer shrink-0"
                      onChange={e => updateResource(r.id, { color: e.target.value })} />
                    <input
                      className={`flex-1 min-w-0 px-1 py-0.5 text-sm border rounded bg-background ${duplicateIds.has(r.id) ? 'border-red-500 text-red-500' : ''}`}
                      value={drafts[r.id] ?? r.name}
                      onChange={e => setDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                      onBlur={e => commitName(r, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      title={duplicateIds.has(r.id) ? translateNameIssue({ scope: 'resource', id: r.id, name: r.name, reason: 'duplicate' }, t) : undefined}
                    />
                    <input className="w-20 shrink-0 px-1 py-0.5 text-xs border rounded bg-background" value={r.type ?? ''} placeholder={t('resource.type', { defaultValue: '类型' })}
                      onChange={e => updateResource(r.id, { type: e.target.value })} />
                    {/* Owner summary stays on the compact row so grouping is visible
                        without expanding; the editable dropdown is in the detail. */}
                    {!r.parentId ? (
                      <span className="max-w-[150px] truncate text-[10px] text-muted-foreground"
                        title={ownerIndex.get(r.id)?.mechanismName || ownerIndex.get(r.id)?.moduleName || t('resource.ownerNone', { defaultValue: '（未归属）' })}>
                        {ownerIndex.get(r.id)?.mechanismName || ownerIndex.get(r.id)?.moduleName || '—'}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">↳</span>
                    )}
                    {motion && <span className="text-[10px] text-primary shrink-0" title={t('resource.rotary', { defaultValue: '旋转' })}>↻</span>}
                    {r.slotIndex !== undefined && (
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0" title={t('resource.slotIndex', { defaultValue: '槽位索引' })}>
                        #{r.slotIndex}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground w-14 text-right tabular-nums shrink-0">{usage} {t('resource.uses', { defaultValue: '处引用' })}</span>
                    {!r.parentId && (
                      <button onClick={() => addChildResource(r.id)} className="p-1 text-primary hover:bg-primary/10 rounded shrink-0"
                        title={t('resource.addSlot', { defaultValue: '添加子槽位' })}>
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {!onlyId && (
                      <button onClick={() => { setOnlyId(r.id); setShowAddForm(false) }} className="p-1 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded shrink-0"
                        title={t('resource.editAlone', { defaultValue: '仅编辑该资源（隐藏其它资源）' })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button onClick={() => { removeResource(r.id); if (onlyId === r.id) setOnlyId(null) }} className="p-1 text-red-500 hover:bg-red-500/10 rounded shrink-0" title={t('resource.remove', { defaultValue: '删除资源' })}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Detail panel — owner + rotation — expanded on demand. */}
                  {isOpen && (
                    <div className="mt-1 ml-6 text-[11px] text-muted-foreground space-y-1.5">
                      {!r.parentId ? (
                        <>
                          {/* Ownership: which flow node (module/mechanism) this resource sits under. */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="whitespace-nowrap">{t('resource.owner', { defaultValue: '归属模块/机构' })}</label>
                            <select
                              className="px-1 py-0.5 text-[11px] border rounded bg-background max-w-[300px]"
                              value={ownerIndex.get(r.id)?.mechanismId || ownerIndex.get(r.id)?.moduleId || ''}
                              onChange={e => setResourceOwner(r.id, e.target.value || null)}
                            >
                              <option value="">{t('resource.ownerNone', { defaultValue: '（未归属）' })}</option>
                              {moduleOptions.length > 0 && (
                                <optgroup label={t('resource.groupModules', { defaultValue: '模块（直属）' })}>
                                  {moduleOptions.map(m => <option key={m.id} value={m.id}>{nodeName(m)}</option>)}
                                </optgroup>
                              )}
                              {mechanismOptions.length > 0 && (
                                <optgroup label={t('resource.groupMechanisms', { defaultValue: '机构' })}>
                                  {mechanismOptions.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </optgroup>
                              )}
                            </select>
                            <button
                              onClick={() => { setAddingOwnerFor(addingOwnerFor === r.id ? null : r.id); setNewOwnerParent(moduleOptions[0]?.id ?? '') }}
                              className="px-1.5 py-0.5 text-[11px] border rounded hover:bg-accent whitespace-nowrap"
                              title={t('resource.ownerNewTip', { defaultValue: '在流程图里新增模块/机构，并设为该资源的归属' })}
                            >
                              + {t('resource.ownerNew', { defaultValue: '新增模块/机构' })}
                            </button>
                            {ownerIndex.has(r.id) && (
                              <span className="truncate" title={t('resource.ownerHint', { defaultValue: '归属只决定该资源泳道显示在哪个模块/机构下（层级分组），不代表被该机构下所有流程占用；实际占用来自流程里为动作设置的资源占用窗口。' })}>
                                {t('resource.ownerMapped', { defaultValue: '已归属 · 仅用于层级分组' })}
                              </span>
                            )}
                          </div>
                          {addingOwnerFor === r.id && (
                            <div className="ml-2 flex items-center gap-1.5 flex-wrap p-1.5 border rounded bg-muted/40">
                              <select className="px-1 py-0.5 text-[11px] border rounded bg-background"
                                value={newOwnerKind} onChange={e => setNewOwnerKind(e.target.value as 'mechanism' | 'module')}>
                                <option value="mechanism">{t('gantt.mechanism', { defaultValue: '机构' })}</option>
                                <option value="module">{t('gantt.module', { defaultValue: '模块' })}</option>
                              </select>
                              <input className="px-1 py-0.5 text-[11px] border rounded bg-background w-32"
                                value={newOwnerName} onChange={e => setNewOwnerName(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') createAndAssignOwner(r.id) }}
                                placeholder={t('resource.ownerNewName', { defaultValue: '名称' })} />
                              {newOwnerKind === 'mechanism' && moduleOptions.length > 0 && (
                                <select className="px-1 py-0.5 text-[11px] border rounded bg-background"
                                  value={newOwnerParent} onChange={e => setNewOwnerParent(e.target.value)}>
                                  {moduleOptions.map(m => <option key={m.id} value={m.id}>{nodeName(m)}</option>)}
                                </select>
                              )}
                              <button onClick={() => createAndAssignOwner(r.id)} className="px-1.5 py-0.5 text-[11px] rounded bg-primary text-primary-foreground hover:opacity-90">
                                {t('resource.ownerCreate', { defaultValue: '创建' })}
                              </button>
                              <button onClick={() => setAddingOwnerFor(null)} className="px-1 py-0.5 text-[11px]">×</button>
                            </div>
                          )}
                          <div className="flex items-center gap-2 flex-wrap">
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
                        </>
                      ) : (
                        <div>{t('resource.ownerInherit', { defaultValue: '归属继承自父资源' })}</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {visibleResources.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {onlyId
                  ? t('resource.focusGone', { defaultValue: '该资源已不存在，请返回全部资源列表。' })
                  : search.trim()
                    ? t('resource.noMatchResources', { defaultValue: '没有匹配的资源' })
                    : t('resource.emptyShort', { defaultValue: '暂无资源' })}
              </div>
            )}
          </section>
          )}

          <section className="border rounded-lg">
            <button onClick={() => setShowAddForm(v => !v)} className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/50 rounded-lg">
              <span className="flex items-center gap-1 font-medium">
                <Plus className="h-3.5 w-3.5" />{t('resource.addNew', { defaultValue: '新建一个资源' })}
              </span>
              <span className="text-muted-foreground">{showAddForm ? '−' : '+'}</span>
            </button>
            {showAddForm && (
              <div className="px-3 pb-3 flex flex-wrap items-end gap-2 border-t pt-3">
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-xs text-muted-foreground mb-1">{t('resource.nameLabel', { defaultValue: '名称' })}</label>
                  <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder={t('resource.newName', { defaultValue: '新资源名称（如 管库抓手）' })} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
                </div>
                <div className="w-24">
                  <label className="block text-xs text-muted-foreground mb-1">{t('resource.type', { defaultValue: '类型' })}</label>
                  <input className={inputClass} value={type} onChange={e => setType(e.target.value)} placeholder="gripper" />
                </div>
                <div className="w-44">
                  <label className="block text-xs text-muted-foreground mb-1">{t('resource.owner', { defaultValue: '归属模块/机构' })}</label>
                  <select className={inputClass} value={newOwnerId} onChange={e => setNewOwnerId(e.target.value)}
                    title={t('resource.ownerHint', { defaultValue: '归属只决定层级分组，不代表自动占用资源' })}>
                    <option value="">{t('resource.ownerNone', { defaultValue: '（未归属）' })}</option>
                    {moduleOptions.length > 0 && (
                      <optgroup label={t('resource.groupModules', { defaultValue: '模块（直属）' })}>
                        {moduleOptions.map(m => <option key={m.id} value={m.id}>{nodeName(m)}</option>)}
                      </optgroup>
                    )}
                    {mechanismOptions.length > 0 && (
                      <optgroup label={t('resource.groupMechanisms', { defaultValue: '机构' })}>
                        {mechanismOptions.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
                <button onClick={submit} className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1">
                  <Plus className="h-3.5 w-3.5" />{t('resource.add', { defaultValue: '添加' })}
                </button>
              </div>
            )}
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
