import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAnimationStore } from '@/stores/useAnimationStore'
import {
  collectPredecessorIds, collectSuccessorIds, flattenTree, TreeRow
} from '@/lib/dependencyEngine'
import { useCycleView } from '@/hooks/useCycleView'
import {
  templateIdOf, cycleIndexOf, normalizeCycleConfig
} from '@/lib/cycleEngine'
import { measureTextWidth, fitTextToWidth, computeLabelWidth } from '@/lib/labelWidth'
import { formatTime, rulerTicks } from '@/lib/timeScale'
import { CycleDialog } from './CycleDialog'
import { ResourceLanes } from './ResourceLanes'
import { TaskKind } from '@/types'
import { ChevronDown, ChevronRight, ZoomIn, ZoomOut, Maximize2, Plus, Clock3, Layers3, Repeat2, Settings2, EyeOff, Eye, AlertTriangle } from 'lucide-react'

/**
 * The Gantt view. Rows follow the four-level hierarchy
 * 模块 → 机构 → 动作 → 子动作 → ... (sub-actions nest arbitrarily deep).
 * Module/mechanism rows are summary brackets rolled up from their descendants;
 * action/subaction rows are real bars with dependency arrows.
 *
 * Bars, ruler, dependency arrows and the Excel sheet all read the same
 * `ScheduleResult`, so a millisecond changed anywhere changes everywhere.
 */

const LABEL_WIDTH_MIN = 320
const LABEL_WIDTH_MAX = 1100
const HEADER_HEIGHT = 46

const KIND_LABEL: Record<TaskKind, string> = {
  module: '模块', mechanism: '机构', action: '动作', subaction: '子动作'
}

const KIND_STYLE: Record<TaskKind, string> = {
  module: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  mechanism: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  action: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  subaction: 'bg-violet-500/15 text-violet-300 border-violet-500/30'
}

/** Which dimension the Gantt groups rows by: the flow tree or physical resources. */
type GroupBy = 'flow' | 'resource'

interface GanttViewProps {
  onEditTask: (id: string) => void
  onOpenTimeScale: () => void
  onAddChild: (parentId: string | null) => void
  onManageResources: () => void
  onEditResource: (resourceId: string) => void
}

export const GanttView: React.FC<GanttViewProps> = ({
  onEditTask, onOpenTimeScale, onAddChild, onManageResources, onEditResource
}) => {
  const { t } = useTranslation()
  const { project, setGanttConfig, setCycleConfig } = useProjectStore()
  const {
    selectedTaskId, setSelectedTask, collapsedTaskIds, toggleCollapsed,
    expandAll, collapseAllSubActions, hiddenTaskIds, hideTasks, unhideAll
  } = useUIStore()
  const currentFrame = useAnimationStore(state => state.currentFrame)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [groupBy, setGroupBy] = useState<GroupBy>('flow')
  const [cycleDialogOpen, setCycleDialogOpen] = useState(false)

  const { config, expansion, schedule, templateSchedule, resourceSchedule, mechanismConflicts, resourceOwners, totalMs } = useCycleView()
  const expanded = expansion.expanded
  const cycleCfg = normalizeCycleConfig(expansion.config)
  const gantt = project?.ganttConfig
  const pxPerMs = gantt?.pxPerMs ?? 0.35
  const rowHeight = gantt?.rowHeight ?? 34
  const showDependencies = gantt?.showDependencies ?? true
  const showSummaries = gantt?.showSummaries ?? true
  const showModuleSummaryBars = gantt?.showModuleSummaryBars ?? true

  // Cycles extend the TIME axis, not the row list: rows always follow the
  // template hierarchy exactly once, and each row draws one bar per cycle.
  const rowSchedule = expanded ? templateSchedule : schedule
  // Explicitly hidden rows are removed from the tree entirely (they are not
  // just collapsed). Store ids are template ids, so hiding survives the
  // single/multi-cycle switch. A hidden parent's subtree was expanded when it
  // was hidden, so filtering by id here drops every one of its descendants.
  const hiddenSet = useMemo(() => new Set(hiddenTaskIds), [hiddenTaskIds])
  const rows = useMemo(
    () => flattenTree(rowSchedule, new Set(collapsedTaskIds))
      .filter(row => !hiddenSet.has(row.task.id)),
    [rowSchedule, collapsedTaskIds, hiddenSet]
  )
  const hiddenCount = rowSchedule.tasks.length - rows.length

  // Auto-size the sticky label column to the longest visible name so long
  // task names show in full instead of being ellipsised at a fixed width.
  const autoLabelWidth = useMemo(() => computeLabelWidth(
    rows.map(row => ({
      name: row.task.module.actionDescription || '',
      depth: row.depth,
      extras: (row.hasChildren ? 18 : 20) + 64 +
        (expanded && row.task.module.cycleIndex ? 30 : 0) + 36 +
        measureTextWidth(`${row.task.startMs}–${row.task.endMs}`, 10)
    })),
    { min: LABEL_WIDTH_MIN, max: LABEL_WIDTH_MAX }
  ), [rows, expanded])
  // Manual resize overrides the auto value; null means "follow content".
  const [manualLabelWidth, setManualLabelWidth] = useState<number | null>(null)
  const labelWidth = manualLabelWidth ?? autoLabelWidth

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = labelWidth
    const onMove = (ev: MouseEvent) => {
      setManualLabelWidth(Math.min(LABEL_WIDTH_MAX, Math.max(LABEL_WIDTH_MIN, startW + ev.clientX - startX)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const chain = useMemo(() => {
    if (!selectedTaskId || !rowSchedule.byId[selectedTaskId]) return null
    const set = new Set<string>([selectedTaskId])
    collectPredecessorIds(rowSchedule, selectedTaskId).forEach(id => set.add(id))
    collectSuccessorIds(rowSchedule, selectedTaskId).forEach(id => set.add(id))
    return set
  }, [rowSchedule, selectedTaskId])

  const chartWidth = Math.max(700, (totalMs + config.scaleMs * 3) * pxPerMs + 60)
  const bodyHeight = Math.max(240, rows.length * rowHeight + 60)
  const ticks = rulerTicks(totalMs, config.scaleMs, pxPerMs, 74)
  const visibleIds = new Set(rows.map(r => r.task.id))
  const rowIndex = new Map(rows.map((r, i) => [r.task.id, i]))

  const zoom = (factor: number) => setGanttConfig({ pxPerMs: Math.min(8, Math.max(0.004, pxPerMs * factor)) })
  const fit = () => {
    const box = scrollRef.current
    if (!box) return
    const available = Math.max(200, box.clientWidth - labelWidth - 48)
    setGanttConfig({ pxPerMs: Math.min(8, Math.max(0.004, available / (totalMs + config.scaleMs))) })
  }

  // Hide the selected row together with its whole subtree. Ids come from the
  // template schedule so a row hidden in one cycle mode stays hidden in the
  // other, and a hidden parent takes all of its descendants with it.
  const hideSelected = () => {
    if (!selectedTaskId || !rowSchedule.byId[selectedTaskId]) return
    const ids: string[] = []
    const walk = (id: string) => {
      ids.push(id)
      ;(rowSchedule.byId[id]?.childIds ?? []).forEach(walk)
    }
    walk(selectedTaskId)
    hideTasks(ids)
    if (ids.includes(selectedTaskId)) setSelectedTask(null)
  }

  const label = (kind: TaskKind) => t(`gantt.kind.${kind}`, { defaultValue: KIND_LABEL[kind] })

  const barY = (i: number) => i * rowHeight + rowHeight * 0.22
  const barH = rowHeight * 0.56

  // Dependency paths (drawn under the bars).
  const linkPaths = useMemo(() => {
    if (!showDependencies) return []
    const paths: Array<{ d: string; id: string; from: string; to: string; text: string }> = []
    // Walk the timed instances (one per cycle) but resolve both ends back to
    // template rows, so arrows land on the correct Y when cycles share a row.
    schedule.tasks.forEach(task => {
      if (task.isSummary) return
      const toId = templateIdOf(task.id)
      const toRow = rowIndex.get(toId)
      if (toRow === undefined) return
      ;(task.module.predecessors ?? []).forEach(dep => {
        const pred = schedule.byId[dep.fromId]
        const fromId = templateIdOf(dep.fromId)
        const fromRow = rowIndex.get(fromId)
        if (!pred || fromRow === undefined || !visibleIds.has(fromId)) return
        const startFromEnd = dep.type === 'FS' || dep.type === 'FF'
        const endAtFinish = dep.type === 'FF' || dep.type === 'SF'
        const x1 = (startFromEnd ? pred.endMs : pred.startMs) * pxPerMs
        const x2 = (endAtFinish ? task.endMs : task.startMs) * pxPerMs
        const y1 = barY(fromRow) + barH / 2
        const y2 = barY(toRow) + barH / 2
        const elbow = Math.max(x1 + 10, x2 - 14)
        const d = `M ${x1} ${y1} L ${elbow} ${y1} L ${elbow} ${y2} L ${x2} ${y2}`
        paths.push({
          d, id: dep.id, from: fromId, to: toId,
          text: `${pred.code} → ${task.code} (${dep.type} ${dep.lagMs >= 0 ? '+' : ''}${dep.lagMs}ms)`
        })
      })
    })
    return paths
  }, [rowIndex, schedule, pxPerMs, showDependencies, rowHeight, visibleIds])

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      {/* Gantt toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b flex-wrap text-xs">
        <span className="font-semibold mr-1">{t('gantt.title', { defaultValue: '动作时序甘特图' })}</span>
        <div className="flex items-center gap-0.5 border rounded p-0.5">
          <button
            onClick={() => setGroupBy('flow')}
            className={`px-2 py-0.5 rounded ${groupBy === 'flow' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
            title={t('gantt.groupFlowTip', { defaultValue: '按模块/机构/动作层级查看流程' })}
          >
            {t('gantt.groupFlow', { defaultValue: '流程' })}
          </button>
          <button
            onClick={() => setGroupBy('resource')}
            className={`px-2 py-0.5 rounded flex items-center gap-1 ${groupBy === 'resource' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
            title={t('gantt.groupResourceTip', { defaultValue: '按机构/电机查看占用与冲突' })}
          >
            <Layers3 className="h-3 w-3" />{t('gantt.groupResource', { defaultValue: '资源' })}
            {resourceSchedule.conflicts.length > 0 && (
              <span className="px-1 rounded bg-red-500 text-white text-[9px]"
                title={t('resource.conflictHint', { defaultValue: '红色为资源占用冲突（仅提示，不自动改时序）。' })}>
                {resourceSchedule.conflicts.length}
              </span>
            )}
          </button>
        </div>
        {mechanismConflicts.conflicts.length > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-amber-500 text-white text-[10px] flex items-center gap-1"
            title={t('gantt.mechanismConflictHint', { defaultValue: '橙色为机构并发冲突：同一机构在同一时间执行多个动作（仅提示，不自动改时序）。' })}>
            <AlertTriangle className="h-3 w-3" />
            {t('gantt.mechanismConflict', { defaultValue: '机构冲突' })} {mechanismConflicts.conflicts.length}
          </span>
        )}
        {/* Single cycle / projected multi-cycle view switch */}
        <div className="flex items-center gap-1 border-l pl-2">
          <div className="flex border rounded p-0.5">
            <button
              onClick={() => setCycleConfig({ enabled: false })}
              className={`px-2 py-0.5 rounded ${!expanded ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
              title={t('cycle.singleTip', { defaultValue: '只显示一份动作模板，可直接编辑' })}
            >
              {t('cycle.single', { defaultValue: '单周期' })}
            </button>
            <button
              onClick={() => setCycleConfig({ enabled: true })}
              className={`px-2 py-0.5 rounded flex items-center gap-1 ${expanded ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
              title={t('cycle.multiTip', { defaultValue: '按固定周期展开多个只读实例' })}
            >
              <Repeat2 className="h-3 w-3" />
              {t('cycle.multi', { defaultValue: '多周期' })}
            </button>
          </div>
          <button onClick={() => setCycleDialogOpen(true)} className="p-1 border rounded hover:bg-accent"
            title={t('cycle.settings', { defaultValue: '周期时长与数量' })}>
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <span className="text-muted-foreground tabular-nums">
            {expanded
              ? `${cycleCfg.repeats} × ${formatTime(cycleCfg.cycleMs, config)}`
              : formatTime(cycleCfg.cycleMs, config)}
          </span>
        </div>
        <span className="text-muted-foreground tabular-nums">
          {t('gantt.total', { defaultValue: '总节拍' })} {formatTime(totalMs, config)}
        </span>
        <span className="px-2 py-0.5 rounded border bg-muted/40 tabular-nums">
          {t('gantt.scale', { defaultValue: '刻度' })} {config.scaleMs} ms · {t('gantt.precision', { defaultValue: '精度' })} {config.precisionMs} ms
        </span>
        <button onClick={onOpenTimeScale} className="px-2 py-1 border rounded hover:bg-accent flex items-center gap-1">
          <Clock3 className="h-3 w-3" />{t('gantt.timeSettings', { defaultValue: '时间刻度' })}
        </button>
        <div className="flex items-center gap-1 border-l pl-2">
          <button onClick={() => zoom(1 / 1.3)} className="p-1 border rounded hover:bg-accent" title={t('gantt.zoomOut', { defaultValue: '缩小' })}><ZoomOut className="h-3.5 w-3.5" /></button>
          <span className="w-12 text-center tabular-nums">{(pxPerMs * 1000).toFixed(0)} px/s</span>
          <button onClick={() => zoom(1.3)} className="p-1 border rounded hover:bg-accent" title={t('gantt.zoomIn', { defaultValue: '放大' })}><ZoomIn className="h-3.5 w-3.5" /></button>
          <button onClick={fit} className="p-1 border rounded hover:bg-accent" title={t('gantt.fit', { defaultValue: '适应窗口' })}><Maximize2 className="h-3.5 w-3.5" /></button>
        </div>
        <div className="flex items-center gap-1 border-l pl-2">
          <button onClick={expandAll} className="px-2 py-1 border rounded hover:bg-accent">
            {t('gantt.expandAll', { defaultValue: '全部展开' })}
          </button>
          <button
            onClick={() => collapseAllSubActions(rowSchedule.tasks
              .filter(x => (x.kind === 'action' || x.kind === 'subaction') && x.childIds.length > 0)
              .map(x => x.id))}
            className="px-2 py-1 border rounded hover:bg-accent"
          >
            {t('gantt.hideSubActions', { defaultValue: '隐藏所有子动作' })}
          </button>
          <button
            onClick={() => useUIStore.getState().setCollapsedTasks(rowSchedule.tasks.filter(x => x.childIds.length > 0).map(x => x.id))}
            className="px-2 py-1 border rounded hover:bg-accent"
          >
            {t('gantt.collapseAll', { defaultValue: '全部折叠' })}
          </button>
          {hiddenCount > 0 && <span className="text-muted-foreground">{hiddenCount} {t('gantt.hidden', { defaultValue: '行已隐藏' })}</span>}
        </div>
        <div className="flex items-center gap-1 border-l pl-2">
          <button
            onClick={hideSelected}
            disabled={!selectedTaskId}
            className="px-2 py-1 border rounded hover:bg-accent disabled:opacity-40 flex items-center gap-1"
            title={t('gantt.hideSelectedTip', { defaultValue: '从图中移除选中的动作/子动作及其下级' })}
          >
            <EyeOff className="h-3.5 w-3.5" />{t('gantt.hideSelected', { defaultValue: '隐藏选中' })}
          </button>
          {hiddenTaskIds.length > 0 && (
            <button
              onClick={unhideAll}
              className="px-2 py-1 border rounded hover:bg-accent flex items-center gap-1"
              title={t('gantt.restoreHiddenTip', { defaultValue: '恢复所有被隐藏的行' })}
            >
              <Eye className="h-3.5 w-3.5" />
              {t('gantt.restoreHidden', { defaultValue: '恢复显示' })} ({hiddenTaskIds.length})
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 border-l pl-2">
          <button onClick={() => onAddChild(selectedTaskId ? templateIdOf(selectedTaskId) : null)} className="px-2 py-1 border rounded hover:bg-accent flex items-center gap-1">
            <Plus className="h-3 w-3" />{t('gantt.addChild', { defaultValue: '新增下级' })}
          </button>
        </div>
      </div>

      {/* Scrollable chart — grouped either by flow tree or by physical resource */}
      {groupBy === 'resource' ? (
        <ResourceLanes
          resourceSchedule={resourceSchedule}
          resourceOwners={resourceOwners}
          schedule={schedule}
          config={config}
          pxPerMs={pxPerMs}
          ticks={ticks}
          chartWidth={chartWidth}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTask}
          onJumpToFlow={id => { setSelectedTask(id); setGroupBy('flow') }}
          onManageResources={onManageResources}
          onEditResource={onEditResource}
        />
      ) : (
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        <div className="flex" style={{ width: labelWidth + chartWidth, minHeight: HEADER_HEIGHT + bodyHeight }}>
          {/* Sticky label column — width follows the longest name, draggable to resize */}
          <div
            className="flex-shrink-0 border-r bg-background z-30 relative"
            style={{ width: labelWidth, position: 'sticky', left: 0 }}
            title={t('gantt.labelResizeTip', { defaultValue: '拖动右边缘调整列宽，双击恢复自适应' })}
          >
            <div
              className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-20"
              onMouseDown={startResize}
              onDoubleClick={() => setManualLabelWidth(null)}
            />
            <div className="flex items-center justify-between px-3 border-b bg-muted font-medium text-xs"
              style={{ height: HEADER_HEIGHT, position: 'sticky', top: 0, zIndex: 10 }}>
              <span>{t('gantt.hierarchy', { defaultValue: '模块 / 机构 / 动作 / 子动作' })}</span>
              <span className="text-muted-foreground">
                {t('gantt.startEnd', { defaultValue: '起止 (ms)' })}{expanded ? ` ×${cycleCfg.repeats}` : ''}
              </span>
            </div>
            {rows.map((row, i) => (
              <GanttLabelRow
                key={row.task.id}
                row={row}
                index={i}
                height={rowHeight}
                selected={selectedTaskId === row.task.id}
                dimmed={Boolean(chain && !chain.has(row.task.id))}
                label={label(row.task.kind)}
                onSelect={id => setSelectedTask(id)}
                onEdit={id => onEditTask(templateIdOf(id))}
                showCycle={expanded}
                onToggle={() => toggleCollapsed(row.task.id)}
              />
            ))}
          </div>

          {/* Chart surface */}
          <div className="relative flex-shrink-0" style={{ width: chartWidth }}>
            <svg width={chartWidth} height={HEADER_HEIGHT} className="block border-b bg-muted"
              style={{ position: 'sticky', top: 0, zIndex: 20 }}>
              {ticks.map(ms => {
                const x = ms * pxPerMs
                return (
                  <g key={ms}>
                    <line x1={x} y1={0} x2={x} y2={HEADER_HEIGHT} stroke="currentColor" strokeOpacity={0.18} />
                    <text x={x + 4} y={HEADER_HEIGHT / 2 + 4} fontSize={10} fill="currentColor" fillOpacity={0.75}>
                      {formatTime(ms, config)}
                    </text>
                  </g>
                )
              })}
              {expanded && expansion.boundaries.slice(1, -1).map(ms => (
                <g key={`cb${ms}`}>
                  <line x1={ms * pxPerMs} y1={0} x2={ms * pxPerMs} y2={HEADER_HEIGHT}
                    stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="4 3" />
                  <text x={ms * pxPerMs + 4} y={13} fontSize={10} fill="#7c3aed" fontWeight="bold">
                    {`C${Math.round(ms / cycleCfg.cycleMs) + 1}`}
                  </text>
                </g>
              ))}
            </svg>
            <svg
              width={chartWidth}
              height={bodyHeight}
              className="block"
              onMouseLeave={() => setHovered(null)}
            >
              <defs>
                <marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 z" fill="#f97316" />
                </marker>
              </defs>

              {/* time grid */}
              {ticks.map(ms => (
                <line key={`g${ms}`} x1={ms * pxPerMs} y1={0} x2={ms * pxPerMs} y2={bodyHeight}
                  stroke="currentColor" strokeOpacity={0.09} />
              ))}
              {expanded && expansion.boundaries.slice(1, -1).map(ms => (
                <g key={`cbb${ms}`}>
                  <line x1={ms * pxPerMs} y1={0} x2={ms * pxPerMs} y2={bodyHeight}
                    stroke="#8b5cf6" strokeWidth={1.5} strokeOpacity={0.55} strokeDasharray="5 4" />
                  <rect x={ms * pxPerMs + 2} y={4} width={26} height={15} rx={3} fill="#8b5cf6" fillOpacity={0.18} />
                  <text x={ms * pxPerMs + 5} y={15} fontSize={10} fill="#7c3aed" fontWeight="bold">
                    {`C${Math.round(ms / cycleCfg.cycleMs) + 1}`}
                  </text>
                </g>
              ))}
              {rows.map((r, i) => (
                <line key={`h${r.task.id}`} x1={0} y1={(i + 1) * rowHeight} x2={chartWidth} y2={(i + 1) * rowHeight}
                  stroke="currentColor" strokeOpacity={0.07} />
              ))}

              {/* dependency arrows */}
              {linkPaths.map(link => {
                const active = !selectedTaskId || !chain ||
                  (chain.has(link.from) && chain.has(link.to))
                return (
                  <path key={link.id} d={link.d} fill="none" stroke="#f97316"
                    strokeWidth={active ? 1.6 : 1} strokeOpacity={active ? 0.95 : 0.2}
                    markerEnd="url(#gantt-arrow)">
                    <title>{link.text}</title>
                  </path>
                )
              })}

              {/* bars / summary brackets — one bar per cycle on each template row */}
              {rows.map(({ task: rowTask }, i) =>
                (expansion.templateToInstances[rowTask.id] ?? [rowTask.id]).map(instanceId => {
                  const task = schedule.byId[instanceId]
                  if (!task) return null
                  const y = barY(i)
                  const x = task.startMs * pxPerMs
                  const w = Math.max(1, task.durationMs * pxPerMs)
                  const cycle = cycleIndexOf(task.id)
                  const dimmed = Boolean(chain && !chain.has(rowTask.id))
                  const color = task.module.color || '#3b82f6'
                  const isHover = hovered === task.id
                  const selected = selectedTaskId === rowTask.id
                  const desc = task.module.actionDescription || ''
                  const cyclePrefix = expanded && cycle > 1 ? `C${cycle}·` : ''
                  // Reserve 6px padding each side and the cycle prefix, then
                  // fit the remaining pixels so text never spills past the bar.
                  const availTextW = Math.max(0, w - 12 - measureTextWidth(cyclePrefix, 10))
                  const shortDesc = fitTextToWidth(desc, availTextW, 10)
                  const barText = cyclePrefix + shortDesc
                  const showText = w > (expanded && cycle > 1 ? 22 : 52)
                  const taskConflicts = resourceSchedule.conflicts.filter(c => c.a.task.id === task.id || c.b.task.id === task.id)
                  const mechConflicts = mechanismConflicts.conflicts.filter(c => c.a.id === task.id || c.b.id === task.id)
                  // Conflict bars get a strong outline so the warning is visible even
                  // when the badge triangle would fall outside the chart's left edge.
                  const conflictStroke = !task.isSummary && mechConflicts.length > 0 ? '#f59e0b'
                    : !task.isSummary && taskConflicts.length > 0 ? '#ef4444' : null
                  // Badge triangles sit just left of the bar; when the bar starts near
                  // x=0 they would be clipped, so shift the whole set right into view.
                  const badgeCount = (taskConflicts.length ? 1 : 0) + (mechConflicts.length ? 1 : 0)
                  const rawCenters = Array.from({ length: badgeCount }, (_, i) => x - 6 - i * 11)
                  const badgeShift = rawCenters.length && Math.min(...rawCenters) < 7 ? 7 - Math.min(...rawCenters) : 0
                  const badgeCenters = rawCenters.map(c => c + badgeShift) // index 0 = red, last = amber
                  return (
                  <g key={task.id} data-task-id={task.id} opacity={dimmed ? (expanded && cycle > 1 ? 0.5 : 0.28) : 1}
                    onMouseEnter={() => setHovered(task.id)}
                    onClick={() => setSelectedTask(rowTask.id)}
                    onDoubleClick={() => onEditTask(rowTask.id)}
                    style={{ cursor: 'pointer' }}>
                    <title>{`${task.code} ${desc}\n${task.startMs} → ${task.endMs} ms (${task.durationMs} ms)${expanded ? `\n周期 C${cycle} / ${cycleCfg.repeats}` : ''}${taskConflicts.length ? `\n🔴 ${taskConflicts.length} ${t('resource.conflicts', { defaultValue: '处资源冲突' })}: ${taskConflicts.map(c => c.resourceName).join(', ')}` : ''}${mechConflicts.length ? `\n🟠 ${t('gantt.mechanismConflict', { defaultValue: '机构并发冲突' })} ${mechConflicts.length} ${t('resource.conflicts', { defaultValue: '处' })}: ${mechConflicts.map(c => `${c.ownerName} × ${mechConflicts.length ? (c.a.id === task.id ? c.b.code : c.a.code) : ''} ${c.overlapMs}ms`).join(', ')}` : ''}`}</title>
                    {task.isSummary ? (
                      showModuleSummaryBars ? (
                        <>
                          <rect x={x} y={y + barH * 0.28} width={w} height={barH * 0.44}
                            fill={color} fillOpacity={0.22} stroke={color} strokeOpacity={0.6} rx={2} />
                          <line x1={x} y1={y + barH} x2={x} y2={y + barH * 0.72} stroke={color} strokeWidth={2} />
                          <line x1={x + w} y1={y + barH} x2={x + w} y2={y + barH * 0.72} stroke={color} strokeWidth={2} />
                        </>
                      ) : null
                    ) : (
                      <>
                        <rect x={x} y={y} width={w} height={barH} rx={3}
                          fill={color} fillOpacity={isHover ? 0.95 : (expanded && cycle > 1 ? 0.62 : 0.8)}
                          stroke={conflictStroke ?? (selected ? '#ffffff' : color)}
                          strokeWidth={conflictStroke ? 2.5 : (selected ? 2 : 1)} />
                        {showText && (
                          <text x={x + 6} y={y + barH / 2 + 4} fontSize={10} fill="#ffffff"
                            style={{ pointerEvents: 'none' }}>
                            {barText}
                          </text>
                        )}
                      </>
                    )}
                    {/* resource conflict badge (red) */}
                    {!task.isSummary && taskConflicts.length > 0 && (
                      <g>
                        <title>{`🔴 ${t('resource.conflicts', { defaultValue: '资源冲突' })}: ${taskConflicts.map(c => `${c.resourceName} ${c.overlapMs}ms`).join('；')}`}</title>
                        <path d={`M ${badgeCenters[0] - 5} ${y - 2} L ${badgeCenters[0] + 5} ${y - 2} L ${badgeCenters[0]} ${y + 8} Z`} fill="#ef4444" />
                        <text x={badgeCenters[0]} y={y + 7} textAnchor="middle" fontSize={9} fill="#ffffff" style={{ pointerEvents: 'none' }}>!</text>
                      </g>
                    )}
                    {/* mechanism concurrency conflict badge (amber) */}
                    {!task.isSummary && mechConflicts.length > 0 && (
                      <g>
                        <title>{`🟠 ${t('gantt.mechanismConflict', { defaultValue: '机构并发冲突' })}: ${mechConflicts.map(c => `${c.ownerName} × ${c.a.id === task.id ? c.b.code : c.a.code} ${c.overlapMs}ms`).join('；')}`}</title>
                        <path d={`M ${badgeCenters[badgeCount - 1] - 5} ${y - 2} L ${badgeCenters[badgeCount - 1] + 5} ${y - 2} L ${badgeCenters[badgeCount - 1]} ${y + 8} Z`} fill="#f59e0b" />
                        <text x={badgeCenters[badgeCount - 1]} y={y + 7} textAnchor="middle" fontSize={9} fill="#ffffff" style={{ pointerEvents: 'none' }}>M</text>
                      </g>
                    )}
                    {/* parent bracket spanning all descendants */}
                    {showSummaries && task.childIds.length > 0 && !task.isSummary &&
                      task.rollupEndMs > task.rollupStartMs && (
                      <>
                        <line x1={task.rollupStartMs * pxPerMs} y1={y - 3}
                          x2={task.rollupEndMs * pxPerMs} y2={y - 3}
                          stroke={color} strokeOpacity={0.55} strokeWidth={1.5} />
                        <line x1={task.rollupStartMs * pxPerMs} y1={y - 3}
                          x2={task.rollupStartMs * pxPerMs} y2={y} stroke={color} strokeOpacity={0.55} />
                        <line x1={task.rollupEndMs * pxPerMs} y1={y - 3}
                          x2={task.rollupEndMs * pxPerMs} y2={y} stroke={color} strokeOpacity={0.55} />
                      </>
                    )}
                  </g>
                  )
                })
              )}

              {/* playhead */}
              {currentFrame > 0 && currentFrame <= totalMs && (
                <line x1={currentFrame * pxPerMs} y1={0} x2={currentFrame * pxPerMs} y2={bodyHeight}
                  stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />
              )}
            </svg>
          </div>
        </div>
      </div>
      )}
      <CycleDialog isOpen={cycleDialogOpen} onClose={() => setCycleDialogOpen(false)} />
    </div>
  )
}

interface GanttLabelRowProps {
  row: TreeRow
  index: number
  height: number
  selected: boolean
  dimmed: boolean
  label: string
  showCycle: boolean
  onSelect: (id: string) => void
  onEdit: (id: string) => void
  onToggle: () => void
}

const GanttLabelRow: React.FC<GanttLabelRowProps> = ({
  row, index, height, selected, dimmed, label, showCycle, onSelect, onEdit, onToggle
}) => {
  const { task, depth, hasChildren, collapsed } = row
  return (
    <div
      className={`flex items-center gap-1 px-2 border-b text-xs cursor-pointer select-none ${selected ? 'bg-primary/15' : index % 2 ? 'bg-muted/20' : ''} hover:bg-accent/50`}
      style={{ height, opacity: dimmed ? 0.5 : 1, paddingLeft: 6 + depth * 14 }}
      onClick={() => onSelect(task.id)}
      onDoubleClick={() => onEdit(task.id)}
      title={`${task.code} · ${task.startMs} → ${task.endMs} ms`}
    >
      {hasChildren ? (
        <button onClick={e => { e.stopPropagation(); onToggle() }} className="p-0.5 hover:bg-accent rounded">
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      ) : <span className="w-5" />}
      <span className="h-2 w-2 rounded-full border border-black/10 flex-shrink-0"
        style={{ backgroundColor: task.module.color || '#3b82f6' }} title={task.module.color} />
      <span className="font-mono text-[10px] text-muted-foreground w-16 flex-shrink-0 truncate" title={task.code}>{task.code}</span>
      {showCycle && task.module.cycleIndex ? (
        <span className="px-1 rounded bg-violet-500/15 text-violet-500 border border-violet-500/30 text-[9px] flex-shrink-0">
          C{task.module.cycleIndex}
        </span>
      ) : null}
      <span className={`px-1 border rounded text-[9px] flex-shrink-0 ${KIND_STYLE[task.kind]}`}>{label}</span>
      <span className="truncate flex-1 font-medium" title={task.module.actionDescription}>
        {task.module.actionDescription}
      </span>
      <span className="font-mono tabular-nums text-[10px] text-muted-foreground flex-shrink-0">
        {task.startMs}–{task.endMs}
      </span>
    </div>
  )
}
