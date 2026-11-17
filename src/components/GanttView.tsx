import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAnimationStore } from '@/stores/useAnimationStore'
import {
  collectPredecessorIds, collectSuccessorIds, computeSchedule, flattenTree, TreeRow
} from '@/lib/dependencyEngine'
import { formatTime, normalizeTimeConfig, rulerTicks } from '@/lib/timeScale'
import { TaskKind } from '@/types'
import { ChevronDown, ChevronRight, ZoomIn, ZoomOut, Maximize2, Plus, Clock3 } from 'lucide-react'

/**
 * The Gantt view. Rows follow the four-level hierarchy
 * 模块 → 机构 → 动作 → 子动作 → ... (sub-actions nest arbitrarily deep).
 * Module/mechanism rows are summary brackets rolled up from their descendants;
 * action/subaction rows are real bars with dependency arrows.
 *
 * Bars, ruler, dependency arrows and the Excel sheet all read the same
 * `ScheduleResult`, so a millisecond changed anywhere changes everywhere.
 */

const LABEL_WIDTH = 320
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

interface GanttViewProps {
  onEditTask: (id: string) => void
  onOpenTimeScale: () => void
  onOpenExcel: () => void
  onAddChild: (parentId: string | null) => void
}

export const GanttView: React.FC<GanttViewProps> = ({
  onEditTask, onOpenTimeScale, onOpenExcel, onAddChild
}) => {
  const { t } = useTranslation()
  const { project, setGanttConfig } = useProjectStore()
  const {
    selectedTaskId, setSelectedTask, collapsedTaskIds, toggleCollapsed,
    expandAll, collapseAllSubActions
  } = useUIStore()
  const currentFrame = useAnimationStore(state => state.currentFrame)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  const config = normalizeTimeConfig(project?.timeConfig)
  const gantt = project?.ganttConfig
  const pxPerMs = gantt?.pxPerMs ?? 0.35
  const rowHeight = gantt?.rowHeight ?? 34
  const showDependencies = gantt?.showDependencies ?? true
  const showSummaries = gantt?.showSummaries ?? true

  const schedule = useMemo(
    () => computeSchedule(project?.modules ?? [], config),
    [project?.modules, config.scaleMs, config.precisionMs, config.displayUnit]
  )
  const collapsed = useMemo(() => new Set(collapsedTaskIds), [collapsedTaskIds])
  const rows = useMemo(() => flattenTree(schedule, collapsed), [schedule, collapsed])
  const hiddenCount = schedule.tasks.length - rows.length

  const chain = useMemo(() => {
    if (!selectedTaskId || !schedule.byId[selectedTaskId]) return null
    const set = new Set<string>([selectedTaskId])
    collectPredecessorIds(schedule, selectedTaskId).forEach(id => set.add(id))
    collectSuccessorIds(schedule, selectedTaskId).forEach(id => set.add(id))
    return set
  }, [schedule, selectedTaskId])

  const totalMs = Math.max(schedule.totalMs, 1)
  const chartWidth = Math.max(700, (totalMs + config.scaleMs * 3) * pxPerMs + 60)
  const bodyHeight = Math.max(240, rows.length * rowHeight + 60)
  const ticks = rulerTicks(totalMs, config.scaleMs, pxPerMs, 74)
  const visibleIds = new Set(rows.map(r => r.task.id))
  const rowIndex = new Map(rows.map((r, i) => [r.task.id, i]))

  const zoom = (factor: number) => setGanttConfig({ pxPerMs: Math.min(8, Math.max(0.004, pxPerMs * factor)) })
  const fit = () => {
    const box = scrollRef.current
    if (!box) return
    const available = Math.max(200, box.clientWidth - LABEL_WIDTH - 48)
    setGanttConfig({ pxPerMs: Math.min(8, Math.max(0.004, available / (totalMs + config.scaleMs))) })
  }

  const label = (kind: TaskKind) => t(`gantt.kind.${kind}`, { defaultValue: KIND_LABEL[kind] })

  const barY = (i: number) => i * rowHeight + rowHeight * 0.22
  const barH = rowHeight * 0.56

  // Dependency paths (drawn under the bars).
  const linkPaths = useMemo(() => {
    if (!showDependencies) return []
    const paths: Array<{ d: string; id: string; from: string; to: string; text: string }> = []
    rows.forEach(({ task }) => {
      if (task.isSummary) return
      const toRow = rowIndex.get(task.id)
      if (toRow === undefined) return
      ;(task.module.predecessors ?? []).forEach(dep => {
        const pred = schedule.byId[dep.fromId]
        const fromRow = rowIndex.get(dep.fromId)
        if (!pred || fromRow === undefined || !visibleIds.has(dep.fromId)) return
        const startFromEnd = dep.type === 'FS' || dep.type === 'FF'
        const endAtFinish = dep.type === 'FF' || dep.type === 'SF'
        const x1 = (startFromEnd ? pred.endMs : pred.startMs) * pxPerMs
        const x2 = (endAtFinish ? task.endMs : task.startMs) * pxPerMs
        const y1 = barY(fromRow) + barH / 2
        const y2 = barY(toRow) + barH / 2
        const elbow = Math.max(x1 + 10, x2 - 14)
        const d = `M ${x1} ${y1} L ${elbow} ${y1} L ${elbow} ${y2} L ${x2} ${y2}`
        paths.push({
          d, id: dep.id, from: dep.fromId, to: task.id,
          text: `${pred.code} → ${task.code} (${dep.type} ${dep.lagMs >= 0 ? '+' : ''}${dep.lagMs}ms)`
        })
      })
    })
    return paths
  }, [rows, rowIndex, schedule, pxPerMs, showDependencies, rowHeight, visibleIds])

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      {/* Gantt toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b flex-wrap text-xs">
        <span className="font-semibold mr-1">{t('gantt.title', { defaultValue: '动作时序甘特图' })}</span>
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
            onClick={() => collapseAllSubActions(schedule.tasks
              .filter(x => (x.kind === 'action' || x.kind === 'subaction') && x.childIds.length > 0)
              .map(x => x.id))}
            className="px-2 py-1 border rounded hover:bg-accent"
          >
            {t('gantt.hideSubActions', { defaultValue: '隐藏所有子动作' })}
          </button>
          <button
            onClick={() => useUIStore.getState().setCollapsedTasks(schedule.tasks.filter(x => x.childIds.length > 0).map(x => x.id))}
            className="px-2 py-1 border rounded hover:bg-accent"
          >
            {t('gantt.collapseAll', { defaultValue: '全部折叠' })}
          </button>
          {hiddenCount > 0 && <span className="text-muted-foreground">{hiddenCount} {t('gantt.hidden', { defaultValue: '行已隐藏' })}</span>}
        </div>
        <div className="flex items-center gap-1 border-l pl-2">
          <button onClick={() => onAddChild(selectedTaskId)} className="px-2 py-1 border rounded hover:bg-accent flex items-center gap-1">
            <Plus className="h-3 w-3" />{t('gantt.addChild', { defaultValue: '新增下级' })}
          </button>
          <button onClick={onOpenExcel} className="px-2 py-1 border rounded hover:bg-accent">
            {t('gantt.excel', { defaultValue: 'Excel 转换' })}
          </button>
        </div>
      </div>

      {/* Scrollable chart */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        <div className="flex" style={{ width: LABEL_WIDTH + chartWidth, minHeight: HEADER_HEIGHT + bodyHeight }}>
          {/* Sticky label column */}
          <div
            className="flex-shrink-0 border-r bg-background z-10"
            style={{ width: LABEL_WIDTH, position: 'sticky', left: 0 }}
          >
            <div className="flex items-center justify-between px-3 border-b bg-muted/60 font-medium text-xs"
              style={{ height: HEADER_HEIGHT }}>
              <span>{t('gantt.hierarchy', { defaultValue: '模块 / 机构 / 动作 / 子动作' })}</span>
              <span className="text-muted-foreground">{t('gantt.startEnd', { defaultValue: '起止 (ms)' })}</span>
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
                onEdit={onEditTask}
                onToggle={() => toggleCollapsed(row.task.id)}
              />
            ))}
          </div>

          {/* Chart surface */}
          <div className="relative flex-shrink-0" style={{ width: chartWidth }}>
            <svg width={chartWidth} height={HEADER_HEIGHT} className="block border-b bg-muted/40">
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

              {/* bars / summary brackets */}
              {rows.map(({ task }, i) => {
                const y = barY(i)
                const x = task.startMs * pxPerMs
                const w = Math.max(1, task.durationMs * pxPerMs)
                const dimmed = Boolean(chain && !chain.has(task.id))
                const color = task.module.color || '#3b82f6'
                const isHover = hovered === task.id
                return (
                  <g key={task.id} opacity={dimmed ? 0.28 : 1}
                    onMouseEnter={() => setHovered(task.id)}
                    onClick={() => setSelectedTask(task.id)}
                    onDoubleClick={() => onEditTask(task.id)}
                    style={{ cursor: 'pointer' }}>
                    <title>{`${task.code} ${task.module.actionDescription}\n${task.startMs} → ${task.endMs} ms (${task.durationMs} ms)`}</title>
                    {task.isSummary ? (
                      <>
                        <rect x={x} y={y + barH * 0.28} width={w} height={barH * 0.44}
                          fill={color} fillOpacity={0.22} stroke={color} strokeOpacity={0.6} rx={2} />
                        <line x1={x} y1={y + barH} x2={x} y2={y + barH * 0.72} stroke={color} strokeWidth={2} />
                        <line x1={x + w} y1={y + barH} x2={x + w} y2={y + barH * 0.72} stroke={color} strokeWidth={2} />
                      </>
                    ) : (
                      <>
                        <rect x={x} y={y} width={w} height={barH} rx={3}
                          fill={color} fillOpacity={isHover ? 0.95 : 0.8}
                          stroke={selectedTaskId === task.id ? '#ffffff' : color}
                          strokeWidth={selectedTaskId === task.id ? 2 : 1} />
                        {w > 52 && (
                          <text x={x + 6} y={y + barH / 2 + 4} fontSize={10} fill="#ffffff"
                            style={{ pointerEvents: 'none' }}>
                            {task.module.actionDescription.length > Math.max(4, Math.floor(w / 8))
                              ? `${task.module.actionDescription.slice(0, Math.max(4, Math.floor(w / 8)))}…`
                              : task.module.actionDescription}
                          </text>
                        )}
                      </>
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
              })}

              {/* playhead */}
              {currentFrame > 0 && currentFrame <= totalMs && (
                <line x1={currentFrame * pxPerMs} y1={0} x2={currentFrame * pxPerMs} y2={bodyHeight}
                  stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />
              )}
            </svg>
          </div>
        </div>
      </div>
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
  onSelect: (id: string) => void
  onEdit: (id: string) => void
  onToggle: () => void
}

const GanttLabelRow: React.FC<GanttLabelRowProps> = ({
  row, index, height, selected, dimmed, label, onSelect, onEdit, onToggle
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
      <span className="font-mono text-[10px] text-muted-foreground w-8 flex-shrink-0">{task.code}</span>
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
