import { ModuleData, TaskKind, TimeConfig } from '@/types'
import { predecessorDisplayId, ScheduleResult, TreeRow } from './dependencyEngine'
import { CycleExpansion } from './cycleEngine'
import { RenderConfig } from './canvasRenderer'
import { OffsetSurface, SvgSurface } from './drawSurface'
import { formatTime, rulerTicks } from './timeScale'
import { computeLabelWidth, fitTextToWidth } from './labelWidth'

/**
 * Timing chart for the PDF report — standalone vector SVG with a left
 * hierarchy column.
 *
 * The on-screen Gantt keeps ONE row per template task and paints a bar for
 * every cycle instance on that row. This renderer follows exactly that
 * projection, so switching between single- and multi-cycle changes the
 * exported time axis the same way it changes the chart on screen. It also
 * derives px/ms from the very same `cellWidth / scaleMs` the chart uses,
 * instead of a separate pixel preference.
 */

const FONT =
  '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK SC", "Noto Sans CJK KR", system-ui, sans-serif'
const MONO = 'ui-monospace, "SFMono-Regular", Consolas, monospace'
const HEADER_HEIGHT = 40
const LINK_COLOR = '#f97316'

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
}

export interface ReportGanttSvgOptions {
  /** Template modules — used for row identity and inherited colours. */
  modules: ModuleData[]
  /** Template rows in tree order (one per task, independent of cycles). */
  rows: TreeRow[]
  /** Expanded schedule holding one task per cycle instance. */
  schedule: ScheduleResult
  expansion: CycleExpansion
  config: RenderConfig
  time: TimeConfig
  labelHeading: string
  startEndHeading: string
  kindLabels: Partial<Record<TaskKind, string>>
  /**
   * Layout-first override: pixels per millisecond derived from the printable
   * page width. When omitted the chart keeps the exact px/ms from the time
   * scale settings; the PDF report supplies it so the artwork fills the page.
   */
  pxPerMs?: number
}

/** Left column width, shared with the PDF page fitter so both pages align. */
export function reportLabelWidth(rows: TreeRow[], cellHeight: number): number {
  const labelFont = Math.max(8, Math.min(11, Math.round(cellHeight * 0.34)))
  return computeLabelWidth(
    rows.map(r => {
      const task = r.task
      const name = task.kind === 'module' || task.kind === 'mechanism'
        ? task.module.moduleName
        : task.module.actionDescription
      return { name, depth: r.depth, fontSize: labelFont, extras: 120 }
    }),
    { min: 190, max: 320, indentPerDepth: 12, basePadding: 44 }
  )
}

/**
 * px/ms that makes the report SVG exactly `width` pixels wide after the left
 * hierarchy column and ruler padding are reserved. Both the flow chart and
 * the resource chart use this value, so their time axes stay aligned even
 * though the physical spacing is chosen by the page layout.
 */
export function fitReportPxPerMs(opts: {
  rows: TreeRow[]
  cellHeight: number
  totalMs: number
  scaleMs: number
  width: number
}): number {
  const labelW = reportLabelWidth(opts.rows, opts.cellHeight)
  // svgW = labelW + [ (total + 2·scale) · px + 30 ] + 8
  const plotW = Math.max(120, opts.width - labelW - 38)
  return Math.max(0.0001, plotW / Math.max(1, opts.totalMs + opts.scaleMs * 2))
}

/** Build the report SVG fragment (no html/body wrapper). */
export function renderReportGanttSvg(options: ReportGanttSvgOptions): string {
  const { rows, schedule, expansion, config, time } = options
  const cellHeight = config.cellHeight
  const scale = time.scaleMs
  // Default to the exact px/ms from the time scale dialog. The PDF report
  // overrides it with the page-fitted value; standalone callers keep the
  // configured scale unchanged.
  const px = options.pxPerMs ?? config.cellWidth / Math.max(1, scale)
  const totalMs = Math.max(1, schedule.totalMs)
  const chartW = (totalMs + scale * 2) * px + 30
  const labelFont = Math.max(8, Math.min(11, Math.round(cellHeight * 0.34)))

  const labelW = reportLabelWidth(rows, cellHeight)
  const bodyH = HEADER_HEIGHT + rows.length * cellHeight + 8
  const svgW = labelW + chartW + 8
  const surface = new SvgSurface(svgW, bodyH)
  const chart = new OffsetSurface(surface, labelW)

  // Row index by template id — dependency arrows and label columns both use it.
  const rowOf = new Map(rows.map((r, i) => [r.task.id, i]))

  surface.rect(0, 0, svgW, bodyH, { fill: config.backgroundColor })
  surface.rect(0, 0, labelW, bodyH, { fill: '#f8fafc' })
  surface.rect(0, 0, svgW, HEADER_HEIGHT, { fill: '#f3f4f6' })
  surface.line(labelW + 0.5, 0, labelW + 0.5, bodyH, '#d1d5db', 1)
  surface.line(0, HEADER_HEIGHT + 0.5, svgW, HEADER_HEIGHT + 0.5, '#d1d5db', 1)

  const headerStyle = { fill: '#374151', fontSize: 10, fontFamily: FONT }
  surface.text(options.labelHeading, 8, HEADER_HEIGHT / 2, headerStyle)
  surface.text(options.startEndHeading, labelW - 8, HEADER_HEIGHT / 2, {
    ...headerStyle,
    align: 'right'
  })

  // Ruler — identical tick selection to the on-screen Gantt.
  const rulerStyle = { fill: '#6b7280', fontSize: 9, fontFamily: MONO }
  for (const tick of rulerTicks(totalMs, scale, px, 74)) {
    const x = tick * px
    if (x > chartW) break
    chart.line(x + 0.5, 0, x + 0.5, bodyH, '#e5e7eb', 0.5)
    chart.text(formatTime(tick, time), x + 3, HEADER_HEIGHT / 2, {
      ...rulerStyle,
      align: 'left'
    })
  }

  // Multi-cycle separators, same as the coloured boundaries on screen.
  if (expansion.expanded) {
    const cycleMs = Math.max(1, expansion.config.cycleMs)
    expansion.boundaries.slice(1, -1).forEach(ms => {
      const x = ms * px
      chart.line(x + 0.5, 0, x + 0.5, bodyH, '#8b5cf6', 1.2)
      chart.text(`C${Math.round(ms / cycleMs) + 1}`, x + 4, 13, {
        fill: '#7c3aed',
        fontSize: 9,
        fontFamily: FONT
      })
    })
  }

  rows.forEach((row, i) => {
    const y = HEADER_HEIGHT + i * cellHeight
    if (i % 2 === 1) surface.rect(0, y, svgW, cellHeight, { fill: '#f9fafb' })
    surface.line(0, y + cellHeight, svgW, y + cellHeight, '#eef0f3', 0.5)

    const task = row.task
    const indent = 6 + row.depth * 12
    const color = task.module.color || config.defaultFillColor
    const name = task.kind === 'module' || task.kind === 'mechanism'
      ? task.module.moduleName
      : task.module.actionDescription
    const kind = options.kindLabels[task.kind] ?? task.kind
    const nameX = indent + 14
    const avail = Math.max(24, labelW - nameX - 96)

    surface.rect(indent, y + cellHeight * 0.3, 7, 7, { fill: color })
    const codeText = fitTextToWidth(task.code, 66, labelFont - 1)
    surface.text(codeText, nameX, y + cellHeight * 0.34, {
      fill: '#6b7280', fontSize: labelFont - 1, fontFamily: MONO
    })
    surface.text(kind, nameX + 72, y + cellHeight * 0.34, {
      fill: '#9ca3af', fontSize: labelFont - 1, fontFamily: FONT
    })
    surface.text(fitTextToWidth(name, avail, labelFont), nameX, y + cellHeight * 0.78, {
      fill: '#12161b', fontSize: labelFont, fontFamily: FONT
    })
    surface.text(`${Math.round(task.startMs)}–${Math.round(task.endMs)}`, labelW - 8, y + cellHeight * 0.6, {
      fill: '#6b7280', fontSize: labelFont - 2, fontFamily: MONO, align: 'right'
    })
  })

  // Bars: one row per template task, one bar per cycle instance.
  const instancesOf = (templateId: string): string[] =>
    expansion.templateToInstances[templateId] ?? [templateId]

  rows.forEach((row, i) => {
    const y = HEADER_HEIGHT + i * cellHeight
    instancesOf(row.task.id).forEach(id => {
      const task = schedule.byId[id]
      if (!task || task.endMs <= task.startMs) return
      const x = task.startMs * px
      const w = Math.max(1, task.durationMs * px)
      const by = y + cellHeight * 0.22
      const bh = cellHeight * 0.56
      const color = task.module.color || config.defaultFillColor
      if (task.isSummary) {
        chart.rect(x, by + bh * 0.18, w, bh * 0.64, { fill: hexToRgba(color, 0.22) })
        chart.rect(x, by + bh * 0.18, w, bh * 0.64, { stroke: hexToRgba(color, 0.6), lineWidth: 0.6 })
      } else {
        chart.rect(x, by, w, bh, { fill: hexToRgba(color, 0.82) })
        chart.rect(x, by, w, bh, { stroke: color, lineWidth: 0.6 })
        const cycle = expansion.expanded ? (task.module.cycleIndex ?? 1) : 1
        const prefix = cycle > 1 ? `C${cycle}·` : ''
        const label = prefix + (task.module.actionDescription || '')
        if (w > 44) {
          chart.text(fitTextToWidth(label, w - 10, 9), x + 5, by + bh / 2, {
            fill: '#ffffff', fontSize: 9, fontFamily: FONT, align: 'left'
          })
        }
      }
    })
  })

  // Dependency arrows between the projected instances.
  if (config.showDependencies !== false) {
    rows.forEach(row => {
      instancesOf(row.task.id).forEach(id => {
        const succ = schedule.byId[id]
        if (!succ) return
        const succRow = rowOf.get(row.task.id) ?? 0
        ;(succ.module.predecessors ?? []).forEach(dep => {
          const pred = schedule.byId[dep.fromId]
          if (!pred) return
          // Container choices are stored on their latest leaf. Draw the edge
          // on the picked container row so it matches the on-screen Gantt.
          const displayId = predecessorDisplayId(schedule, pred.id)
          const predTemplate = expansion.instanceToTemplate[displayId] ?? displayId
          const predRow = rowOf.get(predTemplate) ?? rowOf.get(displayId)
          if (predRow === undefined) return
          const fromX = (dep.type === 'SS' || dep.type === 'SF' ? pred.startMs : pred.endMs) * px
          const toX = (dep.type === 'FF' || dep.type === 'SF' ? succ.endMs : succ.startMs) * px
          const fromY = HEADER_HEIGHT + predRow * cellHeight + cellHeight / 2
          const toY = HEADER_HEIGHT + succRow * cellHeight + cellHeight / 2
          const elbow = Math.max(fromX + 8, toX - 12)
          chart.line(fromX, fromY, elbow, fromY, LINK_COLOR, 0.9)
          chart.line(elbow, fromY, elbow, toY, LINK_COLOR, 0.9)
          chart.line(elbow, toY, toX, toY, LINK_COLOR, 0.9)
          chart.line(toX, toY, toX - 5, toY - 3, LINK_COLOR, 0.9)
          chart.line(toX, toY, toX - 5, toY + 3, LINK_COLOR, 0.9)
        })
      })
    })
  }

  return surface.toSvg()
}
