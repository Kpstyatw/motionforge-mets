import { ModuleData, Resource, ResourceAllocation, CycleConfig, TaskKind } from '@/types'
import { RenderConfig } from '@/lib/canvasRenderer'
import { endMsOf, startMsOf } from '@/lib/timingModel'
import { computeSchedule, serializePredecessors, visibleTreeRows } from '@/lib/dependencyEngine'
import { computeResourceSchedule } from '@/lib/resourceScheduler'
import { buildResourceOwnerIndex } from '@/lib/resourceTree'
import { buildResourceViewRows } from '@/lib/resourceLanesView'
import { expandCycles, templateIdOf } from '@/lib/cycleEngine'
import { renderResourceGanttSvg } from '@/lib/resourceGanttSvg'
import { fitReportPxPerMs, renderReportGanttSvg } from '@/lib/reportGanttSvg'
import { formatTime, normalizeTimeConfig } from '@/lib/timeScale'

/**
 * PDF report.
 *
 * The point of the PDF is not "a picture in a wrapper" — PNG already does that.
 * It is the one export that can be handed to somebody who does not have
 * CycleView installed: the chart and the numbers behind it in a single file
 * that cannot be edited, stamped with the project, the cycle time and the date.
 * That is what makes it usable as a design record months later.
 *
 * Rendering goes through Chromium's own print pipeline (see the
 * `pdf:export` handler in the main process) rather than a JS PDF library,
 * because the module names in this domain are routinely Chinese or Japanese.
 * A JS library would need megabytes of embedded CJK font; Chromium just uses
 * the system fonts, and the output stays vector and searchable.
 */

export interface PdfReportLabels {
  chartPage: string
  resourceChartPage?: string
  tablePage: string
  totalCycle: string
  moduleCount: string
  exportedAt: string
  untitledProject: string
  /** Left hierarchy column on the timing chart. */
  hierarchy?: string
  startEnd?: string
  kindLabels?: Partial<Record<TaskKind, string>>
  columns: {
    module: string
    action: string
    stage: string
    startPosition: string
    moveCount: string
    intervalTime: string
    startTime: string
    endTime: string
    kind?: string
    predecessors?: string
  }
}

export interface PdfReportInput {
  projectName?: string
  modules: ModuleData[]
  config: RenderConfig
  labels: PdfReportLabels
  /** Resource data — when present, a resource Gantt page is appended. */
  resources?: Resource[]
  allocations?: ResourceAllocation[]
  cycleConfig?: CycleConfig
  /** View-only Gantt state (template ids) — hidden rows must not be exported. */
  collapsedTaskIds?: string[]
  hiddenTaskIds?: string[]
  /** Defaults to now; injectable so the output is reproducible in tests. */
  now?: Date
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Natural SVG size emitted by SvgSurface — the basis for a fitted print page. */
function svgSize(svg: string): { width: number; height: number } | null {
  const match = svg.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/)
  if (!match) return null
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * Cycle summary in the configured display unit, with the raw millisecond
 * value kept alongside for exact quoting. Previously always "x s / y ms"
 * even when the dialog was set to minutes or milliseconds.
 */
function formatCycle(ms: number, config: import('@/types').TimeConfig): string {
  const primary = formatTime(ms, config)
  const raw = `${Math.round(ms)} ms`
  return primary === raw ? primary : `${primary} / ${raw}`
}

interface TableRow {
  module: ModuleData
  startTime: number
  endTime: number
}

/**
 * Flatten the timing model into report rows. The start/end columns are the
 * report's real contribution over the source CSV: the CSV says a module moves
 * 12 cells at 80ms, the report says it runs from 800ms to 1760ms.
 */
export function buildReportRows(modules: ModuleData[]): TableRow[] {
  // The report uses the same canonical ms values as the chart and the Excel
  // sheet; grouping/cell arithmetic no longer decides any report number.
  return modules.map(module => ({
    module,
    startTime: startMsOf(module),
    endTime: endMsOf(module)
  }))
}

export interface PdfReportDocument {
  html: string
  headerHtml: string
  footerHtml: string
  fileName: string
}

export function buildPdfReport(input: PdfReportInput): PdfReportDocument {
  const { modules, config, labels } = input
  const now = input.now ?? new Date()
  const projectName = (input.projectName || '').trim() || labels.untitledProject

  const time = normalizeTimeConfig({
    scaleMs: config.scaleMs,
    precisionMs: config.precisionMs,
    displayUnit: config.displayUnit
  })

  // Project the template exactly like the on-screen Gantt does: one row per
  // template task, one bar per cycle instance. Multi-cycle exports therefore
  // use the full (shifted) time axis instead of the first cycle's duration.
  const expansion = expandCycles(
    modules, input.allocations ?? [], input.cycleConfig, time.precisionMs
  )
  const expandedSchedule = computeSchedule(expansion.modules, time)
  const totalMs = Math.max(1, expandedSchedule.totalMs)
  // Layout first: one fixed printable width for every chart page. The px/ms
  // is derived from this width so the artwork fills the page instead of a
  // large configured pixel scale producing a tiny chart in a huge page (or
  // vice versa). Tick labels still come from scaleMs, only their physical
  // spacing follows the paper.
  const marginMm = 8
  // Dedicated bands for the running head/foot. Chromium's own header/footer
  // templates live in the page margins, so content can never collide with
  // them — unlike the old position:fixed copies inside the page area.
  const headerMm = 16
  const footerMm = 14
  const pxPerMm = 96 / 25.4
  const pageWMm = 420 // A3 landscape
  const printableWPx = (pageWMm - 2 * marginMm) * pxPerMm

  // Rows follow the template exactly like the screen chart. Hidden state is
  // stored by template id, so multi-cycle exports filter instances by mapping
  // their ids back to the template — otherwise hidden rows reappear as @Cn.
  const templateSchedule = expansion.expanded
    ? computeSchedule(modules, time)
    : expandedSchedule
  const chartRows = visibleTreeRows(
    templateSchedule,
    new Set(input.collapsedTaskIds ?? []),
    new Set(input.hiddenTaskIds ?? [])
  )
  const visibleIds = new Set(chartRows.map(r => r.task.id))
  // One shared physical scale, fitted to the printable page. The configured
  // scaleMs still decides the tick VALUES; only their pixel spacing follows
  // the layout, which is what "layout first" means for the PDF.
  const fittedPx = fitReportPxPerMs({
    rows: chartRows, cellHeight: config.cellHeight, totalMs,
    scaleMs: time.scaleMs, width: printableWPx
  })

  // Report chart: vector SVG with the same visible hierarchy rows and cycle
  // bars as the flow view. A frozen mid-animation frame would be meaningless.
  const chartSvg = renderReportGanttSvg({
    modules,
    rows: chartRows,
    schedule: expandedSchedule,
    expansion,
    config,
    time,
    pxPerMs: fittedPx,
    labelHeading: labels.hierarchy ?? '模块 / 机构 / 动作 / 子动作',
    startEndHeading: labels.startEnd ?? '起止 (ms)',
    kindLabels: labels.kindLabels ?? {}
  })

  const rows = buildReportRows(
    expansion.modules.filter(m => visibleIds.has(templateIdOf(m.id)))
  )
  const c = labels.columns
  const schedule = expandedSchedule

  // Resource Gantt page. Built from the same projection + ResourceSchedule the
  // app uses, so the printed resource chart matches the on-screen lanes.
  let resourceChartSvg = ''
  if (input.resources?.length) {
    const resourceSchedule = computeResourceSchedule(
      expandedSchedule,
      expansion.allocations,
      input.resources
    )
    // The two chart pages share ONE fitted scale, so their time axes line up
    // even though the pixel spacing follows the paper rather than the raw
    // px/ms setting. Width matches the flow SVG so the left column and the
    // ruler end at the same x on both pages.
    const resourceOwners = buildResourceOwnerIndex(modules, input.resources ?? [])
    // Group headings add rows, so the page height follows the full hierarchy
    // count — otherwise module/mechanism rows would be squeezed or clipped.
    const resourceRows = buildResourceViewRows(resourceSchedule.lanes, resourceOwners)
    resourceChartSvg = renderResourceGanttSvg({
      schedule: resourceSchedule,
      owners: resourceOwners,
      config: time,
      totalMs,
      width: svgSize(chartSvg)?.width ?? printableWPx,
      pxPerMs: fittedPx,
      height: Math.max(160, resourceRows.length * 22 + 40),
      labelHeading: labels.resourceChartPage
    })
  }
  const KIND_TEXT: Record<string, string> = {
    module: '模块', mechanism: '机构', action: '动作', subaction: '子动作'
  }

  const tableRows = rows
    .map(
      ({ module, startTime, endTime }) => `<tr>
        <td>${escapeHtml(module.moduleName)}</td>
        <td>${escapeHtml(module.actionDescription)}</td>
        <td>${escapeHtml(module.stage || '')}</td>
        <td class="num">${module.calculatedStartX ?? module.startX}</td>
        <td class="num">${module.moveCount}</td>
        <td class="num">${module.duration}</td>
        <td class="num">${Math.round(startTime)}</td>
        <td class="num">${Math.round(endTime)}</td>
        <td>${escapeHtml(KIND_TEXT[module.kind ?? 'action'] ?? '动作')}</td>
        <td>${escapeHtml(serializePredecessors(
          (module.predecessors ?? []).filter(dep => visibleIds.has(templateIdOf(dep.fromId))),
          schedule.byId
        ))}</td>
      </tr>`
    )
    .join('')

  const meta =
    `${escapeHtml(labels.totalCycle)} ${formatCycle(totalMs, time)}` +
    ` &nbsp;·&nbsp; ${escapeHtml(labels.moduleCount)} ${modules.length}` +
    ` &nbsp;·&nbsp; ${escapeHtml(labels.exportedAt)} ${formatDate(now)}`

  // The width is fixed so every chart can be fitted to the same printable
  // area (no letterboxing); the height follows the fitted artwork so a short
  // report does not end with half an empty page.
  const artwork = [chartSvg, resourceChartSvg]
    .map(svgSize)
    .filter((size): size is { width: number; height: number } => size !== null)
  // Each chart section also carries an <h2> heading (~48px tall including its
  // bottom margin). Reserve a generous band so the section fits on its page.
  //
  // The page height MUST follow the tallest chart with NO upper clamp. A large
  // project yields a chart several thousand pixels tall; clamping the page to
  // 594mm made that chart exceed the printable area, so `page-break-inside:
  // avoid` pushed the whole section to page 2 and left a blank first page with
  // only the running head/foot. Growing the page to the artwork keeps every
  // section on one fully drawn page and removes the blank leading page.
  const headingReservePx = 120
  const contentH = Math.max(220, ...artwork.map(s => s.height))
  const pageHMm = Math.max(
    120,
    (contentH + headingReservePx) / pxPerMm + headerMm + footerMm
  )

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(projectName)}</title>
<style>
  /* Chromium's print pipeline lays this out; preferCSSPageSize honours the
     @page box below. The running head/foot are print templates inside the
     reserved top/bottom margins, so artwork can never overlap them. */
  @page { size: ${pageWMm.toFixed(1)}mm ${pageHMm.toFixed(1)}mm;
          margin: ${headerMm}mm ${marginMm}mm ${footerMm}mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font: 10pt/1.5 "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB",
          "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK SC", "Noto Sans CJK KR", "Segoe UI",
          system-ui, sans-serif;
    color: #12161B;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h2 {
    font-size: 12pt; font-weight: 600; margin: 0 0 4mm;
    padding-bottom: 2mm; border-bottom: 1px solid #d4d9df;
  }
  /* One fixed page width; charts are fitted to it before rendering, so they
     fill the printable area without CSS stretching the time axis. */
  .chart-page { page-break-after: always; page-break-inside: avoid; }
  .chart-frame svg { display: block; width: 100%; height: auto; max-width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  thead { display: table-header-group; }
  th, td {
    border: 1px solid #d4d9df; padding: 1.4mm 2mm;
    text-align: left; vertical-align: top;
  }
  th { background: #f3f4f6; font-weight: 600; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
  <section class="chart-page">
    <h2>${escapeHtml(labels.chartPage)}</h2>
    <div class="chart-frame">${chartSvg}</div>
  </section>
  ${resourceChartSvg ? `<section class="chart-page">
    <h2>${escapeHtml(labels.resourceChartPage ?? '资源甘特图')}</h2>
    <div class="chart-frame resource-frame">${resourceChartSvg}</div>
  </section>` : ''}
  <section>
    <h2>${escapeHtml(labels.tablePage)}</h2>
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(c.module)}</th>
          <th>${escapeHtml(c.action)}</th>
          <th>${escapeHtml(c.stage)}</th>
          <th>${escapeHtml(c.startPosition)}</th>
          <th>${escapeHtml(c.moveCount)}</th>
          <th>${escapeHtml(c.intervalTime)}</th>
          <th>${escapeHtml(c.startTime)}</th>
          <th>${escapeHtml(c.endTime)}</th>
          <th>${escapeHtml(c.kind ?? '类型')}</th>
          <th>${escapeHtml(c.predecessors ?? '前置任务')}</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </section>
</body>
</html>`

  // Print templates live in the reserved @page margins, so they cannot collide
  // with the charts. Keep them to one plain block with px units (no flex/table/
  // mm): Chromium's header iframe renders that faithfully while richer markup
  // gets shrunk to ~0.75pt.
  const templateBody = 'html,body{margin:0;padding:0}'
  const headerHtml =
    `<style>${templateBody}</style>` +
    `<div style="font:10px 'Segoe UI',system-ui,sans-serif;color:#68707a;` +
    `width:100%;padding:0 10px">${escapeHtml(projectName)} &nbsp;·&nbsp; ${meta}</div>`
  const footerHtml =
    `<style>${templateBody}</style>` +
    `<div style="font:10px 'Segoe UI',system-ui,sans-serif;color:#68707a;` +
    `width:100%;padding:0 10px">DYNMECH CycleView · dynmech.com &nbsp;·&nbsp; ` +
    `<span class="pageNumber"></span> / <span class="totalPages"></span></div>`

  const stem = projectName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'cycleview'

  return { html, headerHtml, footerHtml, fileName: `${stem}-timing.pdf` }
}
