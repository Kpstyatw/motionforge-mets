import { describe, expect, it } from 'vitest'
import { ModuleData, TaskKind } from '@/types'
import { DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG, formatTime, normalizeTimeConfig } from '@/lib/timeScale'
import { renderReportGanttSvg } from '@/lib/reportGanttSvg'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { DEFAULT_CYCLE_CONFIG, expandCycles } from '@/lib/cycleEngine'
import { buildPdfReport } from './pdfExport'

const LABELS = {
  chartPage: '时序图', tablePage: '参数表', totalCycle: '总周期', moduleCount: '模块数',
  exportedAt: '导出时间', untitledProject: '未命名',
  columns: {
    module: '模块', action: '动作', stage: '阶段', startPosition: '起始格',
    moveCount: '步数', intervalTime: '每格 ms', startTime: '开始', endTime: '结束'
  }
}

function node(id: string, kind: TaskKind, parentId: string | null, startMs: number, durationMs: number): ModuleData {
  return {
    id, code: id, kind, parentId,
    moduleName: kind === 'mechanism' ? '取血针' : kind === 'module' ? '前处理' : '',
    actionDescription: `动作${id}`, startMs, anchorMs: startMs, durationMs,
    endMs: startMs + durationMs, startMode: 'manual',
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 100
  }
}

function template(): ModuleData[] {
  return [
    node('M', 'module', null, 0, 0),
    node('K', 'mechanism', 'M', 0, 0),
    node('A', 'action', 'K', 100, 200),
    node('B', 'action', 'K', 400, 200)
  ]
}

function render(opts: { displayUnit?: 'ms' | 's' | 'min'; repeats?: number; pxPerMs?: number } = {}) {
  const modules = template()
  const time = normalizeTimeConfig({
    ...DEFAULT_TIME_CONFIG,
    scaleMs: 100,
    displayUnit: opts.displayUnit ?? 'ms'
  })
  const expansion = expandCycles(modules, [], {
    ...DEFAULT_CYCLE_CONFIG, enabled: (opts.repeats ?? 1) > 1, repeats: opts.repeats ?? 1, cycleMs: 1000
  }, time.precisionMs)
  const schedule = computeSchedule(expansion.modules, time)
  const config = {
    ...DEFAULT_GANTT_CONFIG,
    cellWidth: (opts.pxPerMs ?? 0.35) * time.scaleMs,
    cellHeight: 34,
    gridColor: '#e5e5e5', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6',
    textDisplay: 'action' as const, showDependencies: true
  }
  return {
    time, config, expansion, schedule,
    svg: renderReportGanttSvg({
      modules,
      rows: flattenTree(expansion.expanded ? computeSchedule(modules, time) : schedule),
      schedule, expansion, config, time,
      labelHeading: '模块 / 机构 / 动作', startEndHeading: '起止', kindLabels: {}
    })
  }
}

describe('export time scale and hierarchy', () => {
  it('formatTime honours the configured unit instead of switching to seconds at 10s', () => {
    expect(formatTime(12000, normalizeTimeConfig({ displayUnit: 'ms', precisionMs: 1 }))).toBe('12000ms')
    expect(formatTime(12000, normalizeTimeConfig({ displayUnit: 's', precisionMs: 1 }))).toBe('12.000s')
    expect(formatTime(120000, normalizeTimeConfig({ displayUnit: 'min', precisionMs: 1 }))).toBe('2:00')
  })

  it('PDF chart keeps a left hierarchy column aligned with the template rows', () => {
    const { svg } = render()
    expect(svg).toContain('前处理')
    expect(svg).toContain('取血针')
    expect(svg).toContain('模块')
    expect(svg).toContain('机构')
    expect(svg).toContain('动作A')
    // One template row per task, not one per action only.
    expect((svg.match(/模块|机构/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('derives chart pixels from pxPerMs, not the grid cellWidth preference', () => {
    const tight = render({ pxPerMs: 0.1 })
    const wide = render({ pxPerMs: 0.8 })
    const widthOf = (svg: string) => Number(svg.match(/width="([\d.]+)"/)?.[1] ?? 0)
    expect(widthOf(wide.svg)).toBeGreaterThan(widthOf(tight.svg))
  })

  it('multi-cycle export stretches the time axis and paints a bar per cycle', () => {
    const single = render({ repeats: 1 })
    const multi = render({ repeats: 3 })
    const widthOf = (svg: string) => Number(svg.match(/width="([\d.]+)"/)?.[1] ?? 0)
    expect(widthOf(multi.svg)).toBeGreaterThan(widthOf(single.svg))
    expect(multi.svg).toContain('C2')
    expect(multi.svg).toContain('C3')
    expect(multi.schedule.totalMs).toBeGreaterThan(single.schedule.totalMs)
  })

  it('PDF report header uses the configured display unit', () => {
    const modules = template()
    const time = normalizeTimeConfig({ ...DEFAULT_TIME_CONFIG, displayUnit: 'min' })
    const report = buildPdfReport({
      modules,
      config: {
        cellWidth: 35, cellHeight: 34, gridColor: '#e5e5e5',
        backgroundColor: '#ffffff', defaultFillColor: '#3b82f6',
        textDisplay: 'action', scaleMs: time.scaleMs, displayUnit: time.displayUnit
      },
      labels: LABELS
    })
    expect(report.html).toContain('0:00')
    expect(report.html).not.toContain('0.60 s / 600 ms')
  })
})
