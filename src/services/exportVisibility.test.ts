import { describe, expect, it } from 'vitest'
import { ModuleData, ProjectData, TaskKind } from '@/types'
import {
  computeSchedule, predecessorDisplayId, resolvePredecessorLeaf, visibleTreeRows
} from '@/lib/dependencyEngine'
import { DEFAULT_CYCLE_CONFIG, expandCycles } from '@/lib/cycleEngine'
import {
  DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG, normalizeTimeConfig
} from '@/lib/timeScale'
import { buildGanttWorkbook } from './excelService'
import { buildPdfReport, PdfReportLabels } from './pdfExport'

const TIME = { ...DEFAULT_TIME_CONFIG, scaleMs: 100 }

const LABELS: PdfReportLabels = {
  chartPage: '时序图', tablePage: '参数表', totalCycle: '总周期', moduleCount: '模块数',
  exportedAt: '导出时间', untitledProject: '未命名',
  columns: {
    module: '模块', action: '动作', stage: '阶段', startPosition: '起始格',
    moveCount: '步数', intervalTime: '每格 ms', startTime: '开始', endTime: '结束'
  }
}

function node(
  id: string, kind: TaskKind, parentId: string | null, startMs: number, durationMs: number,
  predecessors: ModuleData['predecessors'] = []
): ModuleData {
  return {
    id, code: `T-${id}`, kind, parentId,
    moduleName: kind === 'mechanism' ? '取血针' : kind === 'module' ? '前处理' : '',
    actionDescription: `动作${id}`, stage: 'A', color: '#3b82f6',
    startMs, anchorMs: startMs, durationMs, endMs: startMs + durationMs,
    startMode: 'manual', predecessors,
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: TIME.scaleMs
  }
}

function template(): ModuleData[] {
  return [
    node('M', 'module', null, 0, 0),
    node('K', 'mechanism', 'M', 0, 0),
    node('A', 'action', 'K', 100, 200),
    node('B', 'action', 'K', 400, 200),
    node('S', 'subaction', 'B', 400, 100)
  ]
}

function project(): ProjectData {
  return {
    name: '隐藏导出测试', modules: template(), resources: [], allocations: [],
    canvasConfig: {
      cellWidth: 35, cellHeight: 34, showGrid: true, showRuler: true,
      gridColor: '#e5e5e5', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6'
    },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: '2.0.0', schemaVersion: 2, timeConfig: TIME,
    excelLayout: { ...DEFAULT_EXCEL_LAYOUT, columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths } },
    ganttConfig: { ...DEFAULT_GANTT_CONFIG }
  }
}

function renderReport(opts: {
  collapsed?: string[]; hidden?: string[]; repeats?: number; modules?: ModuleData[]
} = {}) {
  const modules = opts.modules ?? template()
  const time = normalizeTimeConfig(TIME)
  const expansion = expandCycles(modules, [], {
    ...DEFAULT_CYCLE_CONFIG,
    enabled: (opts.repeats ?? 1) > 1,
    repeats: opts.repeats ?? 1,
    cycleMs: 1000
  }, time.precisionMs)
  const doc = buildPdfReport({
    modules,
    config: {
      ...DEFAULT_GANTT_CONFIG,
      cellWidth: 35, cellHeight: 34, scaleMs: time.scaleMs,
      precisionMs: time.precisionMs, displayUnit: time.displayUnit,
      gridColor: '#e5e5e5', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6',
      textDisplay: 'action'
    },
    cycleConfig: expansion.config,
    collapsedTaskIds: opts.collapsed,
    hiddenTaskIds: opts.hidden,
    labels: LABELS,
    now: new Date('2026-01-01T00:00:00Z')
  })
  return { doc, expansion }
}

describe('exports mirror Gantt visibility', () => {
  it('visibleTreeRows applies both collapse and explicit hide', () => {
    const schedule = computeSchedule(template(), normalizeTimeConfig(TIME))
    expect(visibleTreeRows(schedule).map(r => r.task.id)).toEqual(['M', 'K', 'A', 'B', 'S'])
    expect(visibleTreeRows(schedule, new Set(['K'])).map(r => r.task.id)).toEqual(['M', 'K'])
    // hideTasks() expands a hidden parent's whole subtree before storing ids.
    expect(visibleTreeRows(schedule, new Set(), new Set(['B', 'S'])).map(r => r.task.id))
      .toEqual(['M', 'K', 'A'])
  })

  it('PDF omits hidden rows from both the chart and the parameter table', () => {
    const { doc } = renderReport({ hidden: ['B', 'S'] })
    expect(doc.html).toContain('动作A')
    expect(doc.html).not.toContain('动作B')
    expect(doc.html).not.toContain('动作S')
    expect(doc.html).not.toContain('T-B')
    expect(doc.html).not.toContain('T-S')
  })

  it('PDF omits descendants of a collapsed node', () => {
    const { doc } = renderReport({ collapsed: ['K'] })
    expect(doc.html).toContain('取血针')
    expect(doc.html).not.toContain('动作A')
    expect(doc.html).not.toContain('动作B')
    expect(doc.html).not.toContain('动作S')
  })

  it('multi-cycle PDF hides every @Cn instance of a hidden template row', () => {
    const { doc } = renderReport({ repeats: 3, hidden: ['B', 'S'] })
    expect(doc.html).not.toContain('动作B')
    expect(doc.html).not.toContain('动作S')
    // Hiding rows must not shrink the cycle axis itself.
    expect(doc.html).toContain('C2')
    expect(doc.html).toContain('C3')
  })

  it('Excel keeps hidden rows in the workbook and only flags them hidden', async () => {
    const data = project()
    const schedule = computeSchedule(data.modules, normalizeTimeConfig(TIME))
    const rows = visibleTreeRows(schedule) // all rows: Excel does not delete them
    const blob = await buildGanttWorkbook({
      project: data, schedule, rows, hiddenRowIds: new Set(['B', 'S'])
    })

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const table = wb.getWorksheet('动作时序')!
    const matrix = wb.getWorksheet('甘特矩阵')!
    // header + M/K/A/B/S — nothing was dropped, unlike the PDF.
    expect(table.rowCount).toBe(6)
    expect(matrix.rowCount).toBe(6)
    expect([5, 6].map(r => table.getRow(r).hidden)).toEqual([true, true])
    expect([5, 6].map(r => matrix.getRow(r).hidden)).toEqual([true, true])
    expect([2, 3, 4].map(r => table.getRow(r).hidden)).toEqual([false, false, false])

    const meta = wb.getWorksheet('设置与依赖')!
    const hierarchy = meta.getRows(1, meta.rowCount)!.filter(r => r.getCell(1).value === '层级')
    const hiddenHierarchy = hierarchy.filter(r => r.hidden)
    expect(hiddenHierarchy).toHaveLength(2)
    // Data is still round-trippable: hidden rows did not vanish from sheet 3.
    const cells: string[] = []
    meta.eachRow(row => row.eachCell(cell => cells.push(String(cell.value ?? ''))))
    const dump = cells.join('|')
    expect(dump).toContain('T-B')
    expect(dump).toContain('T-S')
  })

  it('Excel includeHiddenRows shows the flagged rows instead of hiding them', async () => {
    const data = project()
    const schedule = computeSchedule(data.modules, normalizeTimeConfig(TIME))
    const blob = await buildGanttWorkbook({
      project: data, schedule, rows: visibleTreeRows(schedule),
      hiddenRowIds: new Set(['B', 'S']), includeHiddenRows: true
    })
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const table = wb.getWorksheet('动作时序')!
    expect(table.rowCount).toBe(6)
    expect(table.getRows(2, 5)!.every(r => r.hidden === false)).toBe(true)
  })

  it('a container chosen as predecessor draws its edge on the container row', () => {
    const schedule = computeSchedule(template(), normalizeTimeConfig(TIME))
    expect(resolvePredecessorLeaf(schedule, 'B')).toBe('S')
    expect(predecessorDisplayId(schedule, 'S')).toBe('B') // B is the picked container
    expect(predecessorDisplayId(schedule, 'A')).toBe('A') // an ordinary leaf stays put

    // The editor stores the container choice on its latest-ending leaf.
    const modules = template()
    modules.find(m => m.id === 'A')!.predecessors = [
      { id: 'd1', fromId: 'S', type: 'FS', lagMs: 0 }
    ]
    const { doc } = renderReport({ modules })
    const centreY = (row: number) => 40 + row * 34 + 17 // header + row height + half
    const edgeYs = [...doc.html.matchAll(/<line[^>]*y1="([\d.]+)"[^>]*stroke="#f97316"/g)]
      .map(match => Number(match[1]))
    expect(edgeYs).toContain(centreY(3)) // B row, not S row
    expect(edgeYs).toContain(centreY(2)) // A row
    expect(edgeYs).not.toContain(centreY(4))
  })

  it('print page fills a fixed printable width and scales the chart to fit', () => {
    const small = renderReport().doc.html
    const wide = renderReport({ repeats: 3 }).doc.html
    const manyRows = renderReport({
      modules: [
        ...template(),
        ...Array.from({ length: 24 }, (_, i) => node(`X${i}`, 'action', 'K', 700 + i * 100, 50))
      ]
    }).doc.html
    const pageSize = (html: string) => html.match(/@page \{ size: ([\d.]+)mm ([\d.]+)mm/)!.slice(1).map(Number)
    const [smallW] = pageSize(small)
    const [wideW] = pageSize(wide)
    const [rowsW, rowsH] = pageSize(manyRows)
    // Layout first: one width for all charts, height follows the artwork.
    expect(smallW).toBe(420)
    expect(wideW).toBe(smallW)
    expect(rowsW).toBe(smallW)
    expect(rowsH).toBeGreaterThan(120)
    expect(small).toContain('width: 100%; height: auto; max-width: 100%')
    // The fitted SVG occupies the printable width (~A3 minus 8mm margins).
    const svgWidth = Number(small.match(/<svg[^>]*width="([\d.]+)"/)?.[1] ?? 0)
    expect(svgWidth).toBeGreaterThan(1400)
    expect(svgWidth).toBeLessThan(1560)
    // The <h2> heading eats ~48px inside each chart section. If the printable
    // height only just fits the SVG, Chromium's avoid-break rule moves the
    // whole section to page 2 and leaves page 1 blank. Keep a real safety band.
    for (const html of [small, wide, manyRows]) {
      const [, pageH] = pageSize(html)
      const svgH = Number(html.match(/<svg[^>]*height="([\d.]+)"/)?.[1] ?? 0)
      const printablePx = (pageH - 16 - 14) * 96 / 25.4
      expect(printablePx - svgH).toBeGreaterThanOrEqual(100)
    }
  })

  it('page height keeps growing for large projects instead of clamping and leaving a blank first page', () => {
    // A tall chart must never exceed the printable page: when it did, the
    // avoid-break section was pushed to page 2 and page 1 came out blank.
    const big = renderReport({
      modules: [
        ...template(),
        ...Array.from({ length: 80 }, (_, i) => node(`B${i}`, 'action', 'K', 700 + i * 100, 50))
      ]
    }).doc.html
    const [, pageH] = big.match(/@page \{ size: ([\d.]+)mm ([\d.]+)mm/)!.slice(1).map(Number)
    // Previously capped at 594mm; the tall SVG needs far more.
    expect(pageH).toBeGreaterThan(594)
    const svgH = Number(big.match(/<svg[^>]*height="([\d.]+)"/)?.[1] ?? 0)
    const printablePx = (pageH - 16 - 14) * 96 / 25.4
    expect(printablePx).toBeGreaterThan(svgH)
    expect(printablePx - svgH).toBeGreaterThanOrEqual(100)
  })

  it('running head and foot live in reserved margins, never over the chart', () => {
    const doc = renderReport().doc
    // No fixed overlays left inside the page area.
    expect(doc.html).not.toContain('class="run-header"')
    expect(doc.html).not.toContain('position: fixed')
    expect(doc.html).not.toContain('padding: 9mm 0 7mm')
    // Asymmetric @page margins reserve space for Chromium's print templates.
    expect(doc.html).toMatch(/margin: 16mm 8mm 14mm/)
    expect(doc.headerHtml).toContain('未命名')
    expect(doc.footerHtml).toContain('pageNumber')
  })
})
