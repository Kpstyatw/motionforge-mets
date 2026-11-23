import { ResourceSchedule } from './resourceScheduler'
import { ResourceOwner } from './resourceTree'
import { buildResourceViewRows, ResourceViewLabels } from './resourceLanesView'
import { TimeConfig } from '@/types'
import { formatTime, normalizeTimeConfig, rulerTicks } from './timeScale'

/**
 * Resource Gantt → standalone SVG, for the PDF report.
 *
 * Mirrors the on-screen ResourceLanes swim-lanes: the same 模块 → 机构 → 资源
 * hierarchy rows, with claim bars at absolute windows and red conflict bands
 * on resource rows only. Built from the SAME ResourceSchedule and hierarchy
 * projection the UI uses, so the printed chart cannot disagree with the app.
 * Pure and DOM-free; Chromium renders the markup so CJK labels use system
 * fonts and stay vector/searchable in the PDF.
 */

export interface ResourceGanttSvgOptions {
  schedule: ResourceSchedule
  owners?: Map<string, ResourceOwner>
  config: Partial<TimeConfig> | undefined
  totalMs: number
  /** Target SVG width; also used to derive the scale when pxPerMs is absent. */
  width: number
  height: number
  /**
   * Pixels per millisecond from the flow Gantt. When supplied, the resource
   * chart uses exactly the same time scale instead of stretching to `width`.
   */
  pxPerMs?: number
  /** Optional column heading shown above the label column. */
  labelHeading?: string
  /** Fallback names for unowned resources, same as the on-screen lane view. */
  labels?: ResourceViewLabels
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function hex(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').replace('#', '')
  return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : fallback
}

const FONT =
  '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK SC", system-ui, sans-serif'

/** Render the resource swim-lanes as an SVG fragment (no <html>/<body>). */
export function renderResourceGanttSvg(options: ResourceGanttSvgOptions): string {
  const { schedule, owners, totalMs, width, height } = options
  const config = normalizeTimeConfig(options.config)
  const scale = Math.max(1, config.scaleMs)
  // The flow chart maps time with `cellWidth / scaleMs`. Use that exact px/ms
  // when the caller supplies it; only fall back to fitting `width` for
  // standalone callers. Stretching here used to make the PDF resource chart's
  // ruler disagree with the flow chart on the facing page.
  const pxPerMs = options.pxPerMs ?? Math.max(
    0.0001, (width - 158) / Math.max(1, totalMs + scale * 2)
  )
  const plotW = (totalMs + scale * 2) * pxPerMs + 30
  // Give the leftover width to the label column so the whole SVG stays the
  // same width as the flow chart and both time axes end at the same x.
  const labelW = Math.max(120, Math.min(400, width - plotW - 8))
  const plotX = labelW
  const svgW = labelW + plotW + 8
  const tickH = 26
  // One row per hierarchy node — module, mechanism and resource are separate
  // rows, exactly like the flow Gantt's left column. Only resource rows paint
  // claim bars; group rows are headings.
  const viewRows = buildResourceViewRows(schedule.lanes, owners, options.labels)
  const rowH = viewRows.length
    ? Math.max(14, Math.min(26, (height - tickH - 6) / viewRows.length))
    : 20
  const bodyH = tickH + viewRows.length * rowH + 4
  const out: string[] = []

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${bodyH}" viewBox="0 0 ${svgW} ${bodyH}" font-family="${FONT}">`)
  out.push(`<rect x="0" y="0" width="${svgW}" height="${bodyH}" fill="#ffffff"/>`)
  if (options.labelHeading) {
    out.push(`<text x="6" y="${tickH - 8}" font-size="10" font-weight="600" fill="#374151">${esc(options.labelHeading)}</text>`)
  }

  // Time ruler.
  const ticks = rulerTicks(totalMs, config.scaleMs, pxPerMs, 70)
  for (const t of ticks) {
    const x = plotX + t * pxPerMs
    if (x > plotX + plotW + 1) continue
    out.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${bodyH}" stroke="#e5e7eb" stroke-width="1"/>`)
    out.push(`<text x="${(x + 3).toFixed(1)}" y="16" font-size="9" fill="#6b7280">${esc(formatTime(t, config))}</text>`)
  }
  out.push(`<line x1="${plotX - 3}" y1="0" x2="${plotX - 3}" y2="${bodyH}" stroke="#d1d5db" stroke-width="1"/>`)
  out.push(`<line x1="0" y1="${tickH}" x2="${svgW}" y2="${tickH}" stroke="#d1d5db" stroke-width="1"/>`)

  viewRows.forEach((row, i) => {
    const y = tickH + i * rowH
    const fontSize = Math.min(10, rowH * 0.5).toFixed(1)
    const textY = (y + rowH / 2 + 3).toFixed(1)
    // Same 12 px per level as the flow Gantt: 0 module, 1 mechanism, 2 resource.
    const indent = 6 + row.depth * 12
    // Alternating row shading for readability across a wide A3 page.
    if (i % 2 === 1) {
      out.push(`<rect x="0" y="${y.toFixed(1)}" width="${svgW}" height="${rowH.toFixed(1)}" fill="#f9fafb"/>`)
    }
    if (row.kind !== 'resource') {
      // Hierarchy heading: owns no claim bars, just like the flow chart's
      // module/mechanism rows.
      out.push(`<rect x="0" y="${y.toFixed(1)}" width="${labelW.toFixed(1)}" height="${rowH.toFixed(1)}" fill="#f1f5f9"/>`)
      out.push(`<text x="${indent}" y="${textY}" font-size="${fontSize}" font-weight="600" fill="#475569">${esc(row.name)} · ${row.count}</text>`)
      out.push(`<line x1="0" y1="${(y + rowH).toFixed(1)}" x2="${svgW}" y2="${(y + rowH).toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>`)
      return
    }
    const lane = row.lane
    const baseColor = hex(lane.resource.color, '#8b5cf6')
    out.push(`<rect x="${indent}" y="${(y + rowH * 0.26).toFixed(1)}" width="7" height="7" rx="1" fill="${baseColor}"/>`)
    out.push(`<text x="${indent + 11}" y="${textY}" font-size="${fontSize}" fill="#12161b">${esc(row.name)}</text>`)

    // Claim bars at absolute windows.
    for (const a of lane.allocations) {
      if (a.endMs <= a.startMs) continue
      const bx = plotX + a.startMs * pxPerMs
      const bw = Math.max(1, (a.endMs - a.startMs) * pxPerMs)
      const conflicted = lane.conflicts.some(c =>
        c.a.allocation.id === a.allocation.id || c.b.allocation.id === a.allocation.id)
      out.push(`<rect x="${bx.toFixed(1)}" y="${(y + rowH * 0.24).toFixed(1)}" width="${bw.toFixed(1)}" height="${(rowH * 0.52).toFixed(1)}" rx="2" fill="${conflicted ? '#ef4444' : baseColor}" fill-opacity="${conflicted ? 0.9 : 0.82}"/>`)
    }

    // Conflict bands: red hatch over the overlap window on this lane.
    for (const c of lane.conflicts) {
      const cx = plotX + c.overlapStartMs * pxPerMs
      const cw = Math.max(1, c.overlapMs * pxPerMs)
      out.push(`<rect x="${cx.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${rowH.toFixed(1)}" fill="#ef4444" fill-opacity="0.16" stroke="#ef4444" stroke-width="1" stroke-dasharray="3 2"/>`)
    }
    out.push(`<line x1="0" y1="${(y + rowH).toFixed(1)}" x2="${svgW}" y2="${(y + rowH).toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>`)
  })

  if (!viewRows.length) {
    out.push(`<text x="${plotX + 6}" y="${(tickH + 20).toFixed(1)}" font-size="10" fill="#9ca3af">—</text>`)
  }

  out.push('</svg>')
  return out.join('')
}
