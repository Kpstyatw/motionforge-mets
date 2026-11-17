import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ResourceSchedule, resourceBusyMs } from '@/lib/resourceScheduler'
import { formatTime } from '@/lib/timeScale'
import { TimeConfig } from '@/types'
import { Plus, AlertTriangle } from 'lucide-react'

/**
 * Resource swim-lane view: one lane per physical resource, with every exact
 * claim drawn at its absolute window. Overlapping claims on the same lane are
 * highlighted red. This is the "resource-centric" projection of the very same
 * schedules/allocations the flow Gantt uses — no data is duplicated.
 */

const LABEL_WIDTH = 200
const HEADER_HEIGHT = 46

interface ResourceLanesProps {
  resourceSchedule: ResourceSchedule
  config: TimeConfig
  pxPerMs: number
  ticks: number[]
  chartWidth: number
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  onJumpToFlow: (taskId: string) => void
  onManageResources: () => void
}

export const ResourceLanes: React.FC<ResourceLanesProps> = ({
  resourceSchedule, config, pxPerMs, ticks, chartWidth,
  selectedTaskId, onSelectTask, onJumpToFlow, onManageResources
}) => {
  const { t } = useTranslation()
  const rowHeight = 42
  const lanes = resourceSchedule.lanes
  const bodyHeight = Math.max(240, lanes.length * rowHeight + 40)
  const conflictIds = useMemo(() => new Set(resourceSchedule.conflicts.map(c => c.id)), [resourceSchedule.conflicts])

  const barY = (i: number) => i * rowHeight + rowHeight * 0.24
  const barH = rowHeight * 0.52

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex" style={{ width: LABEL_WIDTH + chartWidth, minHeight: HEADER_HEIGHT + bodyHeight }}>
          {/* sticky resource labels */}
          <div className="flex-shrink-0 border-r bg-background z-10" style={{ width: LABEL_WIDTH, position: 'sticky', left: 0 }}>
            <div className="flex items-center justify-between px-3 border-b bg-muted/60 font-medium text-xs" style={{ height: HEADER_HEIGHT }}>
              <span>{t('resource.laneHeader', { defaultValue: '资源泳道' })}</span>
              <button onClick={onManageResources} className="p-1 rounded hover:bg-accent" title={t('resource.manage', { defaultValue: '管理资源' })}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {lanes.map(lane => {
              const conflicts = lane.conflicts.length
              return (
                <div key={lane.resource.id}
                  className={`flex flex-col justify-center px-3 border-b text-xs ${conflicts ? 'bg-red-500/5' : ''}`}
                  style={{ height: rowHeight }}>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: lane.resource.color || '#6366f1' }} />
                    <span className="truncate font-medium" title={lane.resource.name}>{lane.resource.name}</span>
                    {conflicts > 0 && (
                      <span className="ml-auto px-1 rounded bg-red-500/15 text-red-400 flex items-center gap-0.5 text-[10px]"
                        title={`${conflicts} ${t('resource.conflicts', { defaultValue: '处冲突' })}`}>
                        <AlertTriangle className="h-3 w-3" />{conflicts}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                    {lane.allocations.length} {t('resource.claims', { defaultValue: '占用' })} · {formatTime(resourceBusyMs(lane), config)} {t('resource.busy', { defaultValue: '忙碌' })}
                    {lane.resource.type ? ` · ${lane.resource.type}` : ''}
                  </div>
                </div>
              )
            })}
            {lanes.length === 0 && (
              <div className="p-4 text-xs text-muted-foreground">
                {t('resource.empty', { defaultValue: '暂无资源。点击 + 添加机构/电机，再为动作设置占用。' })}
              </div>
            )}
          </div>

          {/* chart surface */}
          <div className="relative flex-shrink-0" style={{ width: chartWidth }}>
            <svg width={chartWidth} height={HEADER_HEIGHT} className="block border-b bg-muted/40">
              {ticks.map(ms => (
                <g key={ms}>
                  <line x1={ms * pxPerMs} y1={0} x2={ms * pxPerMs} y2={HEADER_HEIGHT} stroke="currentColor" strokeOpacity={0.18} />
                  <text x={ms * pxPerMs + 4} y={HEADER_HEIGHT / 2 + 4} fontSize={10} fill="currentColor" fillOpacity={0.75}>
                    {formatTime(ms, config)}
                  </text>
                </g>
              ))}
            </svg>
            <svg width={chartWidth} height={bodyHeight} className="block">
              {ticks.map(ms => (
                <line key={`g${ms}`} x1={ms * pxPerMs} y1={0} x2={ms * pxPerMs} y2={bodyHeight} stroke="currentColor" strokeOpacity={0.09} />
              ))}
              {lanes.map((lane, i) => (
                <line key={`h${lane.resource.id}`} x1={0} y1={(i + 1) * rowHeight} x2={chartWidth} y2={(i + 1) * rowHeight} stroke="currentColor" strokeOpacity={0.07} />
              ))}

              {lanes.map((lane, i) => {
                const y = barY(i)
                const color = lane.resource.color || '#6366f1'
                return lane.allocations.map(a => {
                  const x = a.startMs * pxPerMs
                  const w = Math.max(1, (a.endMs - a.startMs) * pxPerMs)
                  const inConflict = lane.conflicts.some(c => c.a.allocation.id === a.allocation.id || c.b.allocation.id === a.allocation.id)
                  const selected = selectedTaskId === a.task.id
                  return (
                    <g key={a.allocation.id} style={{ cursor: 'pointer' }}
                      onClick={() => onSelectTask(a.task.id)}
                      onDoubleClick={() => onJumpToFlow(a.task.id)}>
                      <title>{`${lane.resource.name} ← ${a.task.code} ${a.task.module.actionDescription}\n${a.startMs} → ${a.endMs} ms\n双击跳转到流程视图`}</title>
                      <rect x={x} y={y} width={w} height={barH} rx={3}
                        fill={inConflict ? '#ef4444' : color}
                        fillOpacity={selected ? 0.95 : 0.72}
                        stroke={inConflict ? '#fca5a5' : selected ? '#ffffff' : color}
                        strokeWidth={selected ? 2 : 1} />
                      {w > 60 && (
                        <text x={x + 5} y={y + barH / 2 + 3.5} fontSize={9} fill="#ffffff" style={{ pointerEvents: 'none' }}>
                          {a.task.code}{inConflict ? ' ⚠' : ''}
                        </text>
                      )}
                    </g>
                  )
                })
              })}

              {/* conflict bands: vertical red hatch over the overlap window */}
              {resourceSchedule.conflicts.map(c => {
                const laneIndex = lanes.findIndex(l => l.resource.id === c.resourceId)
                if (laneIndex < 0) return false
                const x1 = c.overlapStartMs * pxPerMs
                const x2 = c.overlapEndMs * pxPerMs
                const y = barY(laneIndex) - 3
                const w = Math.max(2, x2 - x1)
                return (
                  <g key={`c${c.id}`} style={{ cursor: 'pointer' }} onClick={() => onJumpToFlow(c.b.task.id)}>
                    <title>{`⚠ ${c.resourceName} 冲突 ${c.overlapMs}ms\n${c.a.task.code} × ${c.b.task.code}\n${c.overlapStartMs} → ${c.overlapEndMs} ms\n点击跳转到流程视图`}</title>
                    <rect x={x1} y={y} width={w} height={barH + 6} fill="none" stroke="#ef4444" strokeWidth={2} rx={2} />
                    <line x1={x1} y1={y} x2={x2} y2={y + barH + 6} stroke="#ef4444" strokeWidth={1} />
                    <line x1={x2} y1={y} x2={x1} y2={y + barH + 6} stroke="#ef4444" strokeWidth={1} />
                  </g>
                )
              })}
            </svg>
          </div>
        </div>
      </div>
      {conflictIds.size > 0 && (
        <div className="px-3 py-1.5 border-t text-[11px] text-red-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {t('resource.conflictHint', { defaultValue: '红色为资源占用冲突（仅提示，不自动改时序）。点击冲突块可跳到对应动作。' })}
        </div>
      )}
    </div>
  )
}
