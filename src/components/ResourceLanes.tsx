import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResourceSchedule, resourceBusyMs, ResourceLane } from '@/lib/resourceScheduler'
import { ResourceOwner, resourceChain } from '@/lib/resourceTree'
import { ScheduleResult } from '@/lib/dependencyEngine'
import { cycleIndexOf, templateIdOf } from '@/lib/cycleEngine'
import { formatTime } from '@/lib/timeScale'
import { measureTextWidth, fitTextToWidth, computeLabelWidth } from '@/lib/labelWidth'
import { TimeConfig } from '@/types'
import { Plus, AlertTriangle, Pencil } from 'lucide-react'

/**
 * Resource swim-lane view, now organised as a flow-ownership tree:
 *   模块 → 机构 → 资源 → (a resource's own child slots, e.g. rotary holes)
 * The ownership is reversed from mechanism `resourceId` bindings, so it needs
 * no new authored data. Every exact claim is still drawn at its absolute
 * window on its own resource row; group header rows carry no bars, which keeps
 * the view readable when one resource is claimed many times per cycle.
 */

const LABEL_WIDTH_MIN = 200
const LABEL_WIDTH_MAX = 900
const HEADER_HEIGHT = 46
const RESOURCE_ROW_H = 42
const GROUP_ROW_H = 28

type ViewRow =
  | { kind: 'module' | 'mechanism'; key: string; name: string; top: number; height: number; count: number }
  | { kind: 'resource'; key: string; name: string; top: number; height: number; lane: ResourceLane; indent: number }

interface ResourceLanesProps {
  resourceSchedule: ResourceSchedule
  resourceOwners: Map<string, ResourceOwner>
  schedule: ScheduleResult
  config: TimeConfig
  pxPerMs: number
  ticks: number[]
  chartWidth: number
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  onJumpToFlow: (taskId: string) => void
  onManageResources: () => void
  onEditResource: (resourceId: string) => void
}

export const ResourceLanes: React.FC<ResourceLanesProps> = ({
  resourceSchedule, resourceOwners, schedule, config, pxPerMs, ticks, chartWidth,
  selectedTaskId, onSelectTask, onJumpToFlow, onManageResources, onEditResource
}) => {
  const { t } = useTranslation()
  const lanes = resourceSchedule.lanes
  const conflictIds = useMemo(() => new Set(resourceSchedule.conflicts.map(c => c.id)), [resourceSchedule.conflicts])

  // A resource inherits the ownership of its nearest bound ancestor (a rotary
  // slot sits under the plate that is actually bound to a mechanism).
  const resources = useMemo(() => lanes.map(l => l.resource), [lanes])

  const viewRows = useMemo(() => {
    interface Group {
      moduleKey: string; moduleName: string
      // Resources bound directly to the module (no mechanism) sit here and
      // render under the module header without an empty mechanism row.
      direct: Array<{ lane: ResourceLane; indent: number }>
      mechs: Map<string, { name: string; items: Array<{ lane: ResourceLane; indent: number }> }>
    }
    const groups = new Map<string, Group>()
    const loose: Array<{ lane: ResourceLane; indent: number }> = []

    for (const lane of lanes) {
      const chain = resourceChain(lane.resource.id, resources)
      let owner: ResourceOwner | undefined
      let dist = 0
      for (let d = 0; d < chain.length; d++) {
        const o = resourceOwners.get(chain[d])
        if (o) { owner = o; dist = d; break }
      }
      const item = { lane, indent: dist }
      if (!owner) { loose.push(item); continue }
      const moduleKey = owner.moduleId || `__m__${owner.moduleName}`
      let group = groups.get(moduleKey)
      if (!group) {
        group = { moduleKey, moduleName: owner.moduleName, direct: [], mechs: new Map() }
        groups.set(moduleKey, group)
      }
      if (!owner.mechanismId) { group.direct.push(item); continue }
      let mech = group.mechs.get(owner.mechanismId)
      if (!mech) {
        mech = { name: owner.mechanismName, items: [] }
        group.mechs.set(owner.mechanismId, mech)
      }
      mech.items.push(item)
    }

    const rows: ViewRow[] = []
    let top = 0
    const pushModule = (name: string, count: number) => {
      const label = name || t('resource.ungroupedModule', { defaultValue: '未归属模块' })
      rows.push({ kind: 'module', key: `mod:${label}`, name: label, top, height: GROUP_ROW_H, count })
      top += GROUP_ROW_H
    }
    const pushMech = (name: string, key: string, count: number) => {
      rows.push({ kind: 'mechanism', key: `mech:${key}`, name, top, height: GROUP_ROW_H, count })
      top += GROUP_ROW_H
    }
    const pushResource = (item: { lane: ResourceLane; indent: number }) => {
      rows.push({
        kind: 'resource', key: `res:${item.lane.resource.id}`, name: item.lane.resource.name,
        top, height: RESOURCE_ROW_H, lane: item.lane, indent: item.indent
      })
      top += RESOURCE_ROW_H
    }

    for (const group of groups.values()) {
      const mechCount = [...group.mechs.values()].reduce((n, m) => n + m.items.length, 0)
      pushModule(group.moduleName, mechCount + group.direct.length)
      group.direct.forEach(pushResource)
      for (const [mechKey, mech] of group.mechs) {
        pushMech(mech.name, mechKey, mech.items.length)
        mech.items.forEach(pushResource)
      }
    }
    if (loose.length) {
      pushModule('', loose.length)
      pushMech(t('resource.ungrouped', { defaultValue: '未分组资源' }), '__loose__', loose.length)
      loose.forEach(pushResource)
    }
    return { rows, totalHeight: top }
  }, [lanes, resources, resourceOwners, t])

  const bodyHeight = Math.max(240, viewRows.totalHeight + 40)
  const resourceTop = useMemo(() => {
    const map = new Map<string, number>()
    viewRows.rows.forEach(r => { if (r.kind === 'resource') map.set(r.lane.resource.id, r.top) })
    return map
  }, [viewRows])

  // Full flow path (模块/机构/动作/子动作) of the acting task, for tooltips.
  const flowPath = (taskId: string): string => {
    const chain: string[] = []
    let cur = schedule.byId[taskId]
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      const summary = cur.kind === 'module' || cur.kind === 'mechanism'
      const name = (summary ? cur.module.moduleName : cur.module.actionDescription) || cur.code
      chain.unshift(name)
      if (!cur.parentId) break
      cur = schedule.byId[cur.parentId]
    }
    return chain.join(' / ')
  }

  // Auto-size the sticky label column to the longest visible name, with drag-to-resize.
  const autoLabelWidth = useMemo(() => computeLabelWidth(
    viewRows.rows.map(row => ({
      name: row.name,
      depth: row.kind === 'resource' ? row.indent + 2 : row.kind === 'mechanism' ? 1 : 0,
      extras: row.kind === 'resource'
        ? 24 + (row.lane.resource.motion ? 34 : 0) + (row.lane.resource.slotIndex !== undefined ? 22 : 0) + (row.lane.conflicts.length ? 34 : 0)
        : 20
    })),
    { min: LABEL_WIDTH_MIN, max: LABEL_WIDTH_MAX, basePadding: 48 }
  ), [viewRows])
  const [manualLabelWidth, setManualLabelWidth] = useState<number | null>(null)
  const labelWidth = manualLabelWidth ?? autoLabelWidth
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = labelWidth
    const onMove = (ev: MouseEvent) => setManualLabelWidth(Math.min(LABEL_WIDTH_MAX, Math.max(LABEL_WIDTH_MIN, startW + ev.clientX - startX)))
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex" style={{ width: labelWidth + chartWidth, minHeight: HEADER_HEIGHT + bodyHeight }}>
          {/* sticky labels — ownership tree + resource names */}
          <div className="flex-shrink-0 border-r bg-background z-10 relative"
            style={{ width: labelWidth, position: 'sticky', left: 0 }}
            title={t('gantt.labelResizeTip', { defaultValue: '拖动右边缘调整列宽，双击恢复自适应' })}>
            <div className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-20"
              onMouseDown={startResize}
              onDoubleClick={() => setManualLabelWidth(null)} />
            <div className="flex items-center justify-between px-3 border-b bg-muted/60 font-medium text-xs" style={{ height: HEADER_HEIGHT }}>
              <span>{t('resource.laneHeader', { defaultValue: '资源泳道 · 模块 / 机构 / 资源' })}</span>
              <button onClick={onManageResources} className="p-1 rounded hover:bg-accent" title={t('resource.manage', { defaultValue: '管理资源' })}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {viewRows.rows.map(row => {
              if (row.kind !== 'resource') {
                const isModule = row.kind === 'module'
                return (
                  <div key={row.key}
                    className={`flex items-center gap-1.5 px-3 border-b ${isModule ? 'bg-muted/70 font-medium' : 'bg-muted/30'}`}
                    style={{ height: row.height, paddingLeft: isModule ? 10 : 24 }}>
                    <span className={`h-2 w-2 rounded-sm flex-shrink-0 ${isModule ? 'bg-blue-400' : 'bg-sky-400'}`} />
                    <span className={`truncate ${isModule ? 'text-xs' : 'text-[11px]'}`} title={row.name}>{row.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{row.count}</span>
                  </div>
                )
              }
              const lane = row.lane
              const conflicts = lane.conflicts.length
              return (
                <div key={row.key}
                  className={`flex flex-col justify-center px-3 border-b text-xs ${conflicts ? 'bg-red-500/5' : ''}`}
                  style={{ height: row.height, paddingLeft: 26 + row.indent * 14 }}>
                  <div className="flex items-center gap-1.5">
                    {row.indent > 0 && <span className="text-muted-foreground text-[10px]">└</span>}
                    <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: lane.resource.color || '#6366f1' }} />
                    <span className="truncate font-medium" title={lane.resource.name}>{lane.resource.name}</span>
                    {lane.resource.motion && (
                      <span className="text-[9px] px-1 rounded bg-primary/10 text-primary" title={t('resource.rotaryLane', { defaultValue: '旋转盘：每周期选中一个子槽位' })}>
                        ↻{lane.resource.motion.slots}
                      </span>
                    )}
                    {lane.resource.slotIndex !== undefined && (
                      <span className="text-[9px] text-muted-foreground tabular-nums">#{lane.resource.slotIndex}</span>
                    )}
                    {conflicts > 0 && (
                      <span className="px-1 rounded bg-red-500/15 text-red-400 flex items-center gap-0.5 text-[10px]"
                        title={`${conflicts} ${t('resource.conflicts', { defaultValue: '处冲突' })}`}>
                        <AlertTriangle className="h-3 w-3" />{conflicts}
                      </span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onEditResource(lane.resource.id) }}
                      className="ml-auto p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 flex-shrink-0"
                      title={t('resource.editResource', { defaultValue: '编辑该资源（名称 / 归属 / 类型 / 旋转）' })}>
                      <Pencil className="h-3 w-3" />
                    </button>
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
              {viewRows.rows.map(row => (
                <line key={`h${row.key}`} x1={0} y1={row.top + row.height} x2={chartWidth} y2={row.top + row.height}
                  stroke="currentColor" strokeOpacity={row.kind === 'resource' ? 0.07 : 0.14} />
              ))}

              {viewRows.rows.filter(r => r.kind === 'resource').map(row => {
                if (row.kind !== 'resource') return null
                const lane = row.lane
                const color = lane.resource.color || '#6366f1'
                const barH = row.height * 0.52
                const y = row.top + (row.height - barH) / 2
                return lane.allocations.map(a => {
                  const x = a.startMs * pxPerMs
                  const w = Math.max(1, (a.endMs - a.startMs) * pxPerMs)
                  const inConflict = lane.conflicts.some(c => c.a.allocation.id === a.allocation.id || c.b.allocation.id === a.allocation.id)
                  const selected = selectedTaskId !== null && templateIdOf(selectedTaskId) === templateIdOf(a.task.id)
                  const cycle = cycleIndexOf(a.task.id)
                  const cycleTag = cycle > 1 ? `C${cycle}·` : ''
                  const desc = a.task.module.actionDescription || a.task.code
                  const wide = w > 118
                  const medium = w > 46
                  const label = wide
                    ? cycleTag + fitTextToWidth(desc, Math.max(0, w - 12 - measureTextWidth(cycleTag, 10)), 10)
                    : medium ? cycleTag + templateIdOf(a.task.code)
                      : a.task.code
                  const showLabel = w > 18
                  const source = a.allocation.source === 'mechanism'
                    ? t('resource.sourceAuto', { defaultValue: '自动占用（历史数据）' })
                    : t('resource.sourceManual', { defaultValue: '手动占用' })
                  const tip = [
                    `${lane.resource.name} ← ${a.task.code}`,
                    flowPath(a.task.id),
                    `${a.startMs} → ${a.endMs} ms (${a.endMs - a.startMs} ms)${cycle > 1 ? `\n周期 C${cycle}` : ''}`,
                    source,
                    t('resource.jumpFlowTip', { defaultValue: '双击跳转到流程视图并定位该动作' })
                  ].join('\n')
                  return (
                    <g key={a.allocation.id} style={{ cursor: 'pointer' }}
                      onClick={() => onSelectTask(templateIdOf(a.task.id))}
                      onDoubleClick={() => onJumpToFlow(templateIdOf(a.task.id))}>
                      <title>{tip}</title>
                      <rect x={x} y={y} width={w} height={barH} rx={3}
                        fill={inConflict ? '#ef4444' : color}
                        fillOpacity={selected ? 0.95 : 0.72}
                        stroke={inConflict ? '#fca5a5' : selected ? '#ffffff' : color}
                        strokeWidth={selected ? 2 : 1} />
                      {showLabel && (
                        <text x={x + 5} y={y + barH / 2 + 3.5} fontSize={10} fill="#ffffff" style={{ pointerEvents: 'none' }}>
                          {label}{inConflict ? ' ⚠' : ''}
                        </text>
                      )}
                    </g>
                  )
                })
              })}

              {/* conflict bands: vertical red hatch over the overlap window */}
              {resourceSchedule.conflicts.map(c => {
                const top = resourceTop.get(c.resourceId)
                if (top === undefined) return null
                const x1 = c.overlapStartMs * pxPerMs
                const x2 = c.overlapEndMs * pxPerMs
                const barH = RESOURCE_ROW_H * 0.52
                const y = top + (RESOURCE_ROW_H - barH) / 2 - 3
                const w = Math.max(2, x2 - x1)
                return (
                  <g key={`c${c.id}`} style={{ cursor: 'pointer' }} onClick={() => onJumpToFlow(templateIdOf(c.b.task.id))}>
                    <title>{`⚠ ${c.resourceName} ${t('resource.conflicts', { defaultValue: '冲突' })} ${c.overlapMs}ms\n${flowPath(c.a.task.id)} × ${flowPath(c.b.task.id)}\n${c.overlapStartMs} → ${c.overlapEndMs} ms\n${t('resource.jumpFlowTip', { defaultValue: '点击跳转到流程视图' })}`}</title>
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
