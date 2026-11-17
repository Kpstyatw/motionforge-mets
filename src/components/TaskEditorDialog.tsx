import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { computeSchedule, wouldCreateCycle } from '@/lib/dependencyEngine'
import { normalizeTimeConfig, parseTimeInput, quantize, describeDuration } from '@/lib/timeScale'
import { DependencyType, TaskKind } from '@/types'
import { toast } from '@/components/ui/use-toast'
import { Plus, Trash2, Link2, GitBranch, Boxes } from 'lucide-react'

/** Editor for one action / sub-action (or a summary node). */
interface TaskEditorDialogProps {
  taskId: string | null
  onClose: () => void
  onAddChild: (parentId: string) => void
  onEditAllocations?: (taskId: string) => void
}

const KIND_LABEL: Record<TaskKind, string> = {
  module: '模块', mechanism: '机构', action: '动作', subaction: '子动作'
}
const TYPES: DependencyType[] = ['FS', 'SS', 'FF', 'SF']
const TYPE_HINT: Record<DependencyType, string> = {
  FS: '完成→开始', SS: '开始→开始', FF: '完成→完成', SF: '开始→完成'
}

export const TaskEditorDialog: React.FC<TaskEditorDialogProps> = ({ taskId, onClose, onAddChild, onEditAllocations }) => {
  const { t } = useTranslation()
  const {
    project, setTaskTiming, setStartMode, addPredecessor, updatePredecessor,
    removePredecessor, setTaskField, deleteTask, scheduleWarnings
  } = useProjectStore()
  const { setSelectedTask } = useUIStore()
  const config = normalizeTimeConfig(project?.timeConfig)
  const schedule = useMemo(
    () => computeSchedule(project?.modules ?? [], config),
    [project?.modules, config.scaleMs, config.precisionMs, config.displayUnit]
  )
  const task = taskId ? schedule.byId[taskId] : undefined

  const [name, setName] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [stage, setStage] = useState('')
  const [startText, setStartText] = useState('0')
  const [durationText, setDurationText] = useState('0')
  const [endText, setEndText] = useState('0')
  const [newPredId, setNewPredId] = useState('')

  useEffect(() => {
    if (!task) return
    setName(task.module.actionDescription)
    setModuleName(task.module.moduleName)
    setStage(task.module.stage ?? '')
    setStartText(String(task.startMs))
    setDurationText(String(task.durationMs))
    setEndText(String(task.endMs))
    setNewPredId('')
  }, [task?.id, task?.startMs, task?.durationMs, task?.endMs, task?.module.actionDescription])

  if (!taskId || !task || !project) return null

  const commitTime = (field: 'startMs' | 'durationMs' | 'endMs', text: string) => {
    const parsed = parseTimeInput(text)
    if (parsed === null) {
      toast({ variant: 'destructive', title: t('gantt.invalidTime', { defaultValue: '时间格式无效' }) })
      return
    }
    const q = Math.max(0, quantize(parsed, config.precisionMs, 'round'))
    setTaskTiming(task.id, { [field]: q })
  }

  const candidatePredecessors = schedule.tasks.filter(candidate =>
    candidate.isLeaf &&
    candidate.id !== task.id &&
    !wouldCreateCycle(project.modules, task.id, candidate.id) &&
    !(task.module.predecessors ?? []).some(d => d.fromId === candidate.id)
  )

  const successors = (schedule.successors[task.id] ?? [])
    .map(id => schedule.byId[id])
    .filter(Boolean)

  const handleAddPredecessor = () => {
    const fromId = newPredId || candidatePredecessors[0]?.id
    if (!fromId) {
      toast({ title: t('gantt.noCandidate', { defaultValue: '没有可添加的前置任务' }) })
      return
    }
    const ok = addPredecessor(task.id, fromId, 'FS', 0)
    if (!ok) toast({ variant: 'destructive', title: scheduleWarnings[0] ?? t('gantt.cycleBlocked', { defaultValue: '会形成循环依赖' }) })
    else setNewPredId('')
  }

  const handleDelete = () => {
    if (!window.confirm(t('gantt.confirmDelete', { defaultValue: '删除该任务及其所有子动作、相关依赖？' }))) return
    deleteTask(task.id)
    setSelectedTask(null)
    onClose()
  }

  const inputClass = 'w-full px-2 py-1 text-sm border rounded bg-background'
  const labelClass = 'block text-xs text-muted-foreground mb-1'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[720px] max-w-[95vw] max-h-[90vh] overflow-y-auto border">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-background z-10">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            <h2 className="text-base font-semibold">
              {t('gantt.taskEditor', { defaultValue: '任务编辑' })} · {task.code}
            </h2>
            <span className="px-1.5 py-0.5 text-xs border rounded bg-muted">
              {t(`gantt.kind.${task.kind}`, { defaultValue: KIND_LABEL[task.kind] })}
            </span>
          </div>
          <button onClick={onClose} className="text-xl text-muted-foreground hover:text-foreground">×</button>
        </div>

        <div className="p-5 space-y-5">
          {/* identity */}
          <section className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>{t('gantt.name', { defaultValue: '名称' })}</label>
              <input className={inputClass} value={name}
                onChange={e => setName(e.target.value)}
                onBlur={() => name.trim() && setTaskField(task.id, 'actionDescription', name.trim())} />
            </div>
            <div>
              <label className={labelClass}>{t('gantt.stage', { defaultValue: '阶段' })}</label>
              <input className={inputClass} value={stage}
                onChange={e => setStage(e.target.value)}
                onBlur={() => setTaskField(task.id, 'stage', stage.trim())} />
            </div>
            <div className="col-span-3">
              <label className={labelClass}>{t('gantt.mechanism', { defaultValue: '所属机构 / 模块' })}</label>
              <input className={inputClass} value={moduleName}
                onChange={e => setModuleName(e.target.value)}
                onBlur={() => moduleName.trim() && setTaskField(task.id, 'moduleName', moduleName.trim())}
                disabled={task.isSummary} />
            </div>
          </section>

          {/* timing */}
          <section className="border rounded-lg p-3">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">{t('gantt.timing', { defaultValue: '时序（整数毫秒）' })}</h3>
              <span className="text-xs text-muted-foreground">
                {t('gantt.precision', { defaultValue: '精度' })} {config.precisionMs} ms · {describeDuration(task.durationMs)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelClass}>{t('gantt.start', { defaultValue: '开始 (ms)' })}</label>
                <input className={inputClass} value={startText} onChange={e => setStartText(e.target.value)}
                  onBlur={() => commitTime('startMs', startText)}
                  onKeyDown={e => e.key === 'Enter' && commitTime('startMs', startText)} />
              </div>
              <div>
                <label className={labelClass}>{t('gantt.duration', { defaultValue: '持续时长 (ms)' })}</label>
                <input className={inputClass} value={durationText} onChange={e => setDurationText(e.target.value)}
                  onBlur={() => commitTime('durationMs', durationText)}
                  onKeyDown={e => e.key === 'Enter' && commitTime('durationMs', durationText)} />
              </div>
              <div>
                <label className={labelClass}>{t('gantt.end', { defaultValue: '结束 (ms)' })}</label>
                <input className={inputClass} value={endText} onChange={e => setEndText(e.target.value)}
                  onBlur={() => commitTime('endMs', endText)}
                  onKeyDown={e => e.key === 'Enter' && commitTime('endMs', endText)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {t('gantt.timeHint', { defaultValue: '支持 1234、1234ms、1.234s、01:23.456；修改任一前置任务后，所有后置动作起始时间自动级联重算。' })}
            </p>
            {task.isSummary ? (
              <p className="text-xs mt-2 text-blue-400">
                {t('gantt.summaryHint', { defaultValue: '汇总行：起止时间由所有后代任务自动卷算，不可直接编辑。' })}
              </p>
            ) : (
              <div className="flex items-center gap-3 mt-3 text-xs">
                <span>{t('gantt.startMode', { defaultValue: '起始方式' })}</span>
                <button
                  onClick={() => setStartMode(task.id, task.startMode === 'auto' ? 'manual' : 'auto')}
                  className={`px-2 py-1 border rounded ${task.startMode === 'auto' ? 'bg-primary/15 border-primary' : ''}`}
                >
                  {task.startMode === 'auto'
                    ? t('gantt.auto', { defaultValue: '跟随依赖（自动）' })
                    : t('gantt.manual', { defaultValue: '锁定起始（不早于依赖）' })}
                </button>
                {task.constraintMs !== null && (
                  <span className="text-muted-foreground">
                    {t('gantt.constraint', { defaultValue: '依赖最早允许' })} {task.constraintMs} ms
                    {task.clamped ? ` · ${t('gantt.clamped', { defaultValue: '已按依赖顺延' })}` : ''}
                  </span>
                )}
              </div>
            )}
          </section>

          {/* predecessors */}
          <section className="border rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold flex items-center gap-1">
                <Link2 className="h-3.5 w-3.5" />{t('gantt.predecessors', { defaultValue: '前置任务' })}
              </h3>
              {!task.isSummary && (
                <div className="flex items-center gap-1">
                  <select className="px-2 py-1 text-xs border rounded bg-background max-w-[220px]"
                    value={newPredId} onChange={e => setNewPredId(e.target.value)}>
                    <option value="">{t('gantt.selectPred', { defaultValue: '选择前置任务' })}</option>
                    {candidatePredecessors.map(c => (
                      <option key={c.id} value={c.id}>{c.code} · {c.module.actionDescription}</option>
                    ))}
                  </select>
                  <button onClick={handleAddPredecessor} className="px-2 py-1 text-xs border rounded hover:bg-accent flex items-center gap-1">
                    <Plus className="h-3 w-3" />{t('gantt.add', { defaultValue: '新增' })}
                  </button>
                </div>
              )}
            </div>
            {task.isSummary ? (
              <p className="text-xs text-muted-foreground">
                {t('gantt.summaryNoDeps', { defaultValue: '模块 / 机构汇总行不支持前置任务；请在动作或子动作上设置。' })}
              </p>
            ) : (task.module.predecessors ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('gantt.noPreds', { defaultValue: '暂无前置任务，起始时间由自身设置决定。' })}</p>
            ) : (
              <div className="space-y-2">
                {(task.module.predecessors ?? []).map(dep => {
                  const pred = schedule.byId[dep.fromId]
                  return (
                    <div key={dep.id} className="flex items-center gap-2 text-xs border rounded px-2 py-1.5">
                      <span className="font-mono w-10">{pred?.code ?? '?'}</span>
                      <span className="flex-1 truncate">{pred?.module.actionDescription ?? dep.fromId}</span>
                      <select className="px-1 py-0.5 border rounded bg-background"
                        value={dep.type}
                        onChange={e => updatePredecessor(task.id, dep.id, { type: e.target.value as DependencyType })}>
                        {TYPES.map(type => <option key={type} value={type}>{type} · {TYPE_HINT[type]}</option>)}
                      </select>
                      <input type="number" className="w-20 px-1 py-0.5 border rounded bg-background text-right"
                        value={dep.lagMs}
                        onChange={e => updatePredecessor(task.id, dep.id, { lagMs: Number(e.target.value) || 0 })} />
                      <span className="text-muted-foreground">ms</span>
                      <button onClick={() => removePredecessor(task.id, dep.id)}
                        className="p-1 text-red-400 hover:bg-red-500/10 rounded" title={t('gantt.remove', { defaultValue: '删除' })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            {successors.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                {t('gantt.successors', { defaultValue: '后置任务' })}：
                {successors.map(s => `${s.code} ${s.module.actionDescription}`).join('、')}
              </p>
            )}
          </section>

          {/* hierarchy */}
          <section className="border rounded-lg p-3 flex items-center justify-between">
            <div className="text-xs">
              <div className="font-semibold mb-1">{t('gantt.hierarchy', { defaultValue: '层级' })}</div>
              <div className="text-muted-foreground">
                {t('gantt.level', { defaultValue: '第' })} {task.depth + 1} {t('gantt.levelUnit', { defaultValue: '层' })}
                {' · '}{task.childIds.length} {t('gantt.children', { defaultValue: '个直接子级' })}
                {' · '}{t('gantt.path', { defaultValue: '可继续添加子动作的子动作' })}
              </div>
            </div>
            <button onClick={() => onAddChild(task.id)}
              className="px-3 py-1.5 text-xs border rounded hover:bg-accent flex items-center gap-1">
              <Plus className="h-3.5 w-3.5" />{t('gantt.addChild', { defaultValue: '新增下级' })}
            </button>
          </section>

          {/* resource allocation */}
          {!task.isSummary && (
            <section className="border rounded-lg p-3 flex items-center justify-between">
              <div className="text-xs">
                <div className="font-semibold mb-1 flex items-center gap-1"><Boxes className="h-3.5 w-3.5" />{t('resource.allocSection', { defaultValue: '资源占用' })}</div>
                <div className="text-muted-foreground">
                  {project.allocations.filter(a => a.taskId === task.id).length} {t('resource.claims', { defaultValue: '条占用' })}
                  {' · '}{t('resource.allocSectionHint', { defaultValue: '精确窗口，重叠会提示' })}
                </div>
              </div>
              <button onClick={() => onEditAllocations?.(task.id)}
                className="px-3 py-1.5 text-xs border rounded hover:bg-accent flex items-center gap-1">
                <Boxes className="h-3.5 w-3.5" />{t('resource.editAlloc', { defaultValue: '编辑占用' })}
              </button>
            </section>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t">
          <button onClick={handleDelete} className="px-3 py-1.5 text-xs border border-red-500/40 text-red-400 rounded hover:bg-red-500/10">
            {t('gantt.deleteTask', { defaultValue: '删除任务（含子动作）' })}
          </button>
          <button onClick={onClose} className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.close', { defaultValue: '关闭' })}
          </button>
        </div>
      </div>
    </div>
  )
}
