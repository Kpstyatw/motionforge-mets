import { describe, expect, it } from 'vitest'
import { ModuleData, TaskKind } from '@/types'
import { DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG, normalizeTimeConfig } from './timeScale'
import { computeSchedule, flattenTree } from './dependencyEngine'
import { DEFAULT_CYCLE_CONFIG, expandCycles } from './cycleEngine'
import { renderReportGanttSvg } from './reportGanttSvg'

interface LineSeg {
  x1: number; y1: number; x2: number; y2: number
}

function arrowSegments(svg: string): LineSeg[] {
  return [...svg.matchAll(
    /<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)" stroke="#000000"/g
  )].map(m => ({
    x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4])
  }))
}

function node(id: string, kind: TaskKind, parentId: string | null, startMs: number, durationMs: number, predecessors: unknown[] = []): ModuleData {
  return {
    id, code: id, kind, parentId, predecessors,
    moduleName: kind === 'module' ? '前处理' : '',
    actionDescription: `动作${id}`, startMs, anchorMs: startMs, durationMs,
    endMs: startMs + durationMs, startMode: 'manual',
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 100
  } as ModuleData
}

function renderTightFsSvg(): string {
  const px = 0.35
  const modules = [
    node('M', 'module', null, 0, 0),
    // FS, lag 0: B starts exactly where A ends — the old elbow back-tracked.
    node('A', 'action', 'M', 0, 200),
    node('B', 'action', 'M', 200, 200, [
      { id: 'd1', fromId: 'A', type: 'FS', lagMs: 0 }
    ])
  ]
  const time = normalizeTimeConfig({ ...DEFAULT_TIME_CONFIG, scaleMs: 100 })
  const expansion = expandCycles(modules, [], {
    ...DEFAULT_CYCLE_CONFIG, enabled: false, repeats: 1, cycleMs: 1000
  }, time.precisionMs)
  const schedule = computeSchedule(expansion.modules, time)
  const config = {
    ...DEFAULT_GANTT_CONFIG,
    cellWidth: px * time.scaleMs,
    cellHeight: 34,
    gridColor: '#e5e5e5', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6',
    textDisplay: 'action' as const, showDependencies: true
  }
  const svg = renderReportGanttSvg({
    modules, rows: flattenTree(schedule), schedule, expansion, config, time,
    labelHeading: '模块 / 机构 / 动作', startEndHeading: '起止', kindLabels: {}
  })
  return svg
}

function renderTightFs(): LineSeg[] {
  return arrowSegments(renderTightFsSvg())
}

/** Horizontal segments grouped by their y, sorted top to bottom. */
function horizontalRows(segs: LineSeg[]): Array<{ y: number; segs: LineSeg[] }> {
  const rows: Array<{ y: number; segs: LineSeg[] }> = []
  for (const s of segs) {
    if (Math.abs(s.y1 - s.y2) > 0.5) continue
    let row = rows.find(r => Math.abs(r.y - s.y1) < 0.5)
    if (!row) { row = { y: s.y1, segs: [] }; rows.push(row) }
    row.segs.push(s)
  }
  return rows.sort((a, b) => a.y - b.y)
}

describe('PDF report dependency arrow routing', () => {
  it('does not back-track left through the target bar for a lag-0 FS edge', () => {
    const rows = horizontalRows(renderTightFs())
    const sourceRow = rows[0]
    const gutterRow = rows[1]
    const targetRow = rows[2]
    expect(sourceRow).toBeTruthy()
    expect(gutterRow).toBeTruthy()
    expect(targetRow).toBeTruthy()

    // The target-row leg must approach its endpoint from the LEFT (x1 < x2),
    // never run back left from the right side of the bar as the old elbow did.
    expect(targetRow.segs.length).toBeGreaterThan(0)
    expect(targetRow.segs.every(s => s.x1 < s.x2)).toBe(true)
    // The gutter leg runs leftward in the empty lane between the two rows.
    expect(gutterRow.y).toBeGreaterThan(sourceRow.y)
    expect(gutterRow.y).toBeLessThan(targetRow.y)
    expect(gutterRow.segs.some(s => s.x2 < s.x1)).toBe(true)
  })

  it('paints arrows before bar labels so text stays readable', () => {
    const svg = renderTightFsSvg()
    // In-bar labels are the white <text> runs; arrows are black <line> runs.
    // SVG paints in document order, so the arrows must all precede the labels.
    // (The page background is also #ffffff, so match text nodes specifically.)
    const lastArrow = svg.lastIndexOf('stroke="#000000"')
    const firstLabel = svg.search(/<text[^>]*fill="#ffffff"/)
    expect(lastArrow).toBeGreaterThan(0)
    expect(firstLabel).toBeGreaterThan(0)
    expect(lastArrow).toBeLessThan(firstLabel)
  })

  it('places the arrow head along the final approach direction', () => {
    const segs = renderTightFs()
    const rows = horizontalRows(segs)
    const targetRow = rows[2]
    const tipX = Math.max(...targetRow.segs.map(s => s.x2))
    const tipY = targetRow.y
    // Two head strokes fan out from the tip, back toward the left.
    const heads = segs.filter(s =>
      Math.abs(s.x1 - tipX) < 0.5 && Math.abs(s.y1 - tipY) < 0.5 &&
      Math.abs(s.y1 - s.y2) > 0.5
    )
    expect(heads.length).toBe(2)
    expect(heads.every(s => s.x2 < tipX)).toBe(true)
  })
})
