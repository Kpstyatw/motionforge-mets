import { ResourceSchedule } from './resourceScheduler'
import { ResourceOwner } from './resourceTree'
import { TimeConfig } from '@/types'
import { formatTime, normalizeTimeConfig, rulerTicks } from './timeScale'

/**
 * Resource Gantt → standalone SVG, for the PDF report.
 *
 * Mirrors the on-screen ResourceLanes swim-lanes: one row per resource with
 * its claim bars at absolute windows and red bands over conflicts. Built from
 * the SAME ResourceSchedule the UI uses, so the printed chart cannot disagree
 * with the app. Pure and DOM-free; Chromium renders the markup so CJK labels
 * use system fonts and stay vector/searchable in the PDF.
 */

export interface ResourceGanttSvgOptions {
  schedule: ResourceSchedule
  owners?: Map<string, ResourceOwner>
  config: Partial<TimeConfig> | undefined
  totalMs: number
  width: number
  height: number
  /** Optional column heading shown above the label column. */
  labelHeading?: string
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
  const labelW = Math.min(210, Math.max(120, width * 0.2))
  const plotX = labelW + 6
  const plotW = Math.max(1, width - plotX - 8)
  const tickH = 26
  const pxPerMs = plotW / Math.max(1, totalMs)
  const lanes = schedule.lanes
  const rowH = lanes.length
    ? Math.max(14, Math.min(26, (height - tickH - 6) / lanes.length))
    : 20
  const bodyH = tickH + lanes.length * rowH + 4
  const out: string[] = []

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bodyH}" viewBox="0 0 ${width} ${bodyH}" font-family="${FONT}">`)
  out.push(`<rect x="0" y="0" width="${width}" height="${bodyH}" fill="#ffffff"/>`)
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
  out.push(`<line x1="0" y1="${tickH}" x2="${width}" y2="${tickH}" stroke="#d1d5db" stroke-width="1"/>`)

  lanes.forEach((lane, i) => {
    const y = tickH + i * rowH
    const baseColor = hex(lane.resource.color, '#8b5cf6')
    // Alternating row shading for readability across a wide A3 page.
    if (i % 2 === 1) {
      out.push(`<rect x="0" y="${y.toFixed(1)}" width="${width}" height="${rowH.toFixed(1)}" fill="#f9fafb"/>`)
    }
    const owner = owners?.get(lane.resource.id)
    const ownerLabel = owner ? `${owner.moduleName || ''}${owner.mechanismName ? ' / ' + owner.mechanismName : ''} · ` : ''
    const label = `${ownerLabel}${lane.resource.name}`
    const indent = 4 + (lane.depth ?? 0) * 10
    out.push(`<text x="${indent}" y="${(y + rowH / 2 + 3).toFixed(1)}" font-size="${Math.min(10, rowH * 0.5).toFixed(1)}" fill="#12161b">${esc(label)}</text>`)

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
    out.push(`<line x1="0" y1="${(y + rowH).toFixed(1)}" x2="${width}" y2="${(y + rowH).toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>`)
  })

  if (!lanes.length) {
    out.push(`<text x="${plotX + 6}" y="${(tickH + 20).toFixed(1)}" font-size="10" fill="#9ca3af">—</text>`)
  }

  out.push('</svg>')
  return out.join('')
}
