import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { formatTime, normalizeTimeConfig } from '@/lib/timeScale'
import { findNameIssues, translateNameIssue } from '@/lib/nameValidation'
import { Plus, Layers3, AlertTriangle } from 'lucide-react'

/** Sidebar for the Gantt view: hierarchy actions, stats and diagnostics. */
interface GanttSidePanelProps {
  onAddChild: (parentId: string | null) => void
}

export const GanttSidePanel: React.FC<GanttSidePanelProps> = ({ onAddChild }) => {
  const { t } = useTranslation()
  const { project, scheduleWarnings } = useProjectStore()
  const { selectedTaskId, collapsedTaskIds } = useUIStore()
  const config = normalizeTimeConfig(project?.timeConfig)
  const schedule = useMemo(
    () => computeSchedule(project?.modules ?? [], config),
    [project?.modules, config.scaleMs, config.precisionMs, config.displayUnit]
  )
  const rows = useMemo(
    () => flattenTree(schedule, new Set(collapsedTaskIds)),
    [schedule, collapsedTaskIds]
  )
  const counts = useMemo(() => {
    const result: Record<string, number> = { module: 0, mechanism: 0, action: 0, subaction: 0 }
    schedule.tasks.forEach(x => { result[x.kind] = (result[x.kind] ?? 0) + 1 })
    return result
  }, [schedule])
  const nameIssues = useMemo(() => findNameIssues(project), [project])
  const otherWarnings = useMemo(
    () => [...new Set([...schedule.warnings, ...scheduleWarnings])].filter(w => !/名称重复|名称不能为空/.test(w)),
    [schedule.warnings, scheduleWarnings]
  )

  if (!project) return null

  return (
    <div className="h-full flex flex-col bg-muted/30">
      <div className="px-3 py-2 border-b bg-muted">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Layers3 className="h-3.5 w-3.5" />{t('gantt.hierarchyPanel', { defaultValue: '层级与操作' })}
        </h2>
      </div>

      <div className="px-3 py-2 border-b text-xs space-y-1">
        <div className="flex justify-between"><span className="text-muted-foreground">{t('gantt.total', { defaultValue: '总节拍' })}</span><b className="tabular-nums">{formatTime(schedule.totalMs, config)}</b></div>
        <div className="flex justify-between"><span className="text-muted-foreground">{t('gantt.taskCount', { defaultValue: '节点数' })}</span><b className="tabular-nums">{schedule.tasks.length}</b></div>
        <div className="flex justify-between"><span className="text-muted-foreground">{t('gantt.visibleCount', { defaultValue: '可见行' })}</span><b className="tabular-nums">{rows.length}</b></div>
        <div className="flex flex-wrap gap-1 pt-1">
          <span className="px-1.5 border rounded text-[10px]">{t('gantt.kind.module', { defaultValue: '模块' })} {counts.module}</span>
          <span className="px-1.5 border rounded text-[10px]">{t('gantt.kind.mechanism', { defaultValue: '机构' })} {counts.mechanism}</span>
          <span className="px-1.5 border rounded text-[10px]">{t('gantt.kind.action', { defaultValue: '动作' })} {counts.action}</span>
          <span className="px-1.5 border rounded text-[10px]">{t('gantt.kind.subaction', { defaultValue: '子动作' })} {counts.subaction}</span>
        </div>
      </div>

      <div className="px-3 py-2 border-b grid grid-cols-2 gap-1.5">
        <button onClick={() => onAddChild(null)} className="px-2 py-1.5 text-xs border rounded hover:bg-accent flex items-center justify-center gap-1">
          <Plus className="h-3 w-3" />{t('gantt.addModule', { defaultValue: '新增模块' })}
        </button>
        <button onClick={() => onAddChild(selectedTaskId)} className="px-2 py-1.5 text-xs border rounded hover:bg-accent flex items-center justify-center gap-1">
          <Plus className="h-3 w-3" />{t('gantt.addChild', { defaultValue: '新增下级' })}
        </button>
      </div>

      {nameIssues.length > 0 && (
        <div className="px-3 py-2 border-b text-[11px] text-red-500 space-y-1">
          <div className="flex items-center gap-1 font-semibold">
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            {t('nameIssue.banner', { defaultValue: '名称问题（{{count}}）：请修改后再保存', count: nameIssues.length })}
          </div>
          {nameIssues.slice(0, 6).map((issue, i) => (
            <div key={`${issue.scope}-${issue.id}-${i}`} className="pl-4">· {translateNameIssue(issue, t)}</div>
          ))}
          {nameIssues.length > 6 && (
            <div className="pl-4 text-muted-foreground">+ {nameIssues.length - 6}</div>
          )}
        </div>
      )}

      {otherWarnings.length > 0 && (
        <div className="px-3 py-2 border-b text-[11px] text-amber-400 space-y-1">
          {otherWarnings.slice(0, 4).map((w, i) => (
            <div key={i} className="flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" /><span>{w}</span></div>
          ))}
        </div>
      )}

      {/* Hierarchy tree lives in the Gantt label column (row-aligned with the
          time axis). This panel intentionally keeps only stats, add actions
          and diagnostics — no duplicate tree. */}
      <div className="flex-1 min-h-0" />

      <div className="px-3 py-2 border-t text-[11px] text-muted-foreground space-y-1">
        <div>{t('gantt.sideHint', { defaultValue: '模块 / 机构 / 动作层级请在右侧甘特图的标签列查看、选中与编辑，标签行与时间轴逐行对齐。' })}</div>
        <div>{t('gantt.sideHintDeps', { defaultValue: '单击选中节点后，其依赖链路会在甘特图中高亮。' })}</div>
      </div>
    </div>
  )
}
