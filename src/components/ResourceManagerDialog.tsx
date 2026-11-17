import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { Plus, Trash2 } from 'lucide-react'

/** Global resource catalogue editor: mechanisms / motors / actuators. */
interface Props {
  isOpen: boolean
  onClose: () => void
}

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#ec4899']

export const ResourceManagerDialog: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const { project, addResource, updateResource, removeResource } = useProjectStore()
  const [name, setName] = useState('')
  const [type, setType] = useState('')

  if (!isOpen || !project) return null
  const resources = project.resources

  const submit = () => {
    if (!name.trim()) return
    addResource({ name: name.trim(), type: type.trim() || undefined, color: PALETTE[resources.length % PALETTE.length] })
    setName('')
    setType('')
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[560px] max-w-[95vw] max-h-[88vh] overflow-y-auto border">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-background z-10">
          <h2 className="text-base font-semibold">{t('resource.managerTitle', { defaultValue: '资源管理（机构 / 电机）' })}</h2>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/40 border rounded p-2">
            {t('resource.managerHint', { defaultValue: '资源只定义一次，供所有流程的动作共用。在任务的「资源占用」里引用它们，无需在各流程重复新建机构。' })}
          </div>

          <section className="border rounded-lg divide-y">
            {resources.map(r => {
              const usage = project.allocations.filter(a => a.resourceId === r.id).length
              return (
                <div key={r.id} className="flex items-center gap-2 px-3 py-2">
                  <input type="color" value={r.color || '#6366f1'} className="w-7 h-7 border-0 bg-transparent p-0 cursor-pointer"
                    onChange={e => updateResource(r.id, { color: e.target.value })} />
                  <input className="flex-1 px-1 py-0.5 text-sm border rounded bg-background" value={r.name}
                    onChange={e => updateResource(r.id, { name: e.target.value })} />
                  <input className="w-24 px-1 py-0.5 text-xs border rounded bg-background" value={r.type ?? ''} placeholder={t('resource.type', { defaultValue: '类型' })}
                    onChange={e => updateResource(r.id, { type: e.target.value })} />
                  <span className="text-[10px] text-muted-foreground w-16 text-right tabular-nums">{usage} {t('resource.uses', { defaultValue: '处引用' })}</span>
                  <button onClick={() => removeResource(r.id)} className="p-1 text-red-500 hover:bg-red-500/10 rounded" title={t('resource.remove', { defaultValue: '删除资源' })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
              <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="管库抓手" onKeyDown={e => { if (e.key === 'Enter') submit() }} />
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
