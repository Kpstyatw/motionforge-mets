import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { ModuleData, ProjectData, Resource, ResourceAllocation, TaskKind } from '@/types'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG, normalizeTimeConfig } from '@/lib/timeScale'
import { buildGanttWorkbook } from './excelService'
import { computeResourceSchedule } from '@/lib/resourceScheduler'
import { buildResourceOwnerIndex } from '@/lib/resourceTree'
import { renderResourceGanttSvg } from '@/lib/resourceGanttSvg'
import { buildPdfReport } from './pdfExport'

const CONFIG = { ...DEFAULT_TIME_CONFIG, scaleMs: 1000, precisionMs: 100 }

function node(id: string, kind: TaskKind, parentId: string | null, startMs: number, durationMs: number, resourceId?: string): ModuleData {
  return {
    id, code: id, kind, parentId, resourceId,
    moduleName: kind === 'mechanism' ? '取血针' : kind === 'module' ? '前处理' : '',
    actionDescription: `动作${id}`, startMs, anchorMs: startMs, durationMs,
    endMs: startMs + durationMs, startMode: 'manual',
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 1000
  }
}

function fixture(): { project: ProjectData; schedule: ReturnType<typeof computeSchedule> } {
  const modules = [
    node('M', 'module', null, 0, 0),
    node('K', 'mechanism', 'M', 0, 0, 'GRIP'),
    node('A', 'action', 'K', 1000, 2000),
    node('B', 'action', 'K', 2500, 2000)
  ]
  const resources: Resource[] = [
    { id: 'GRIP', name: '取血抓手', color: '#8b5cf6', type: 'gripper' }
  ]
  const allocations: ResourceAllocation[] = [
    { id: 'a1', taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 2000, slotMode: 'fixed' },
    { id: 'a2', taskId: 'B', resourceId: 'GRIP', offsetMs: 0, durationMs: 2000, slotMode: 'fixed' }
  ]
  const project: ProjectData = {
    name: '导出测试', modules, resources, allocations,
    canvasConfig: {
      cellWidth: 20, cellHeight: 30, showGrid: true, showRuler: true,
      gridColor: '#e5e5e5', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6'
    },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: '2.0.0', schemaVersion: 2,
    timeConfig: CONFIG,
    excelLayout: { ...DEFAULT_EXCEL_LAYOUT, columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths } },
    ganttConfig: { ...DEFAULT_GANTT_CONFIG }
  }
  return { project, schedule: computeSchedule(modules, CONFIG) }
}

describe('resource Gantt in exports', () => {
  it('Excel adds a 资源甘特图 sheet with lanes, owner and occupancy cells', async () => {
    const { project, schedule } = fixture()
    const blob = await buildGanttWorkbook({ project, schedule, rows: flattenTree(schedule) })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const sheet = wb.getWorksheet('资源甘特图')
    expect(sheet).toBeTruthy()
    expect(sheet!.getCell(1, 1).value).toBe('资源')
    expect(sheet!.getCell(1, 2).value).toBe('归属模块/机构')
    // One resource lane on row 2 with its name and owner.
    expect(sheet!.getCell(2, 1).value).toBe('取血抓手')
    expect(String(sheet!.getCell(2, 2).value)).toContain('前处理')
    expect(sheet!.getCell(2, 3).value).toBe(2) // two claims
  })

  it('Excel resource sheet marks conflicting overlap windows in red', async () => {
    const { project, schedule } = fixture()
    // Overlap A[1000,3000) and B[2500,4500) → conflict [2500,3000)
    const blob = await buildGanttWorkbook({ project, schedule, rows: flattenTree(schedule) })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const sheet = wb.getWorksheet('资源甘特图')!
    expect(sheet.getCell(2, 4).value).toBe(1) // one conflict on the lane
    // At least one occupied cell carries the conflict marker.
    let marked = 0
    for (let c = 5; c <= sheet.columnCount; c++) {
      if (sheet.getCell(2, c).value === '⚠') marked++
    }
    expect(marked).toBeGreaterThan(0)
  })

  it('PDF resource SVG shows lane label, claim bars and conflict bands', () => {
    const { project, schedule } = fixture()
    const rs = computeResourceSchedule(schedule, project.allocations, project.resources)
    expect(rs.conflicts).toHaveLength(1)
    const svg = renderResourceGanttSvg({
      schedule: rs,
      owners: buildResourceOwnerIndex(project.modules),
      config: normalizeTimeConfig(CONFIG),
      totalMs: schedule.totalMs,
      width: 1000,
      height: 120
    })
    expect(svg).toContain('<svg')
    expect(svg).toContain('取血抓手')
    expect(svg).toContain('#ef4444') // conflict colour present
  })

  it('buildPdfReport embeds a resource Gantt page when resources are supplied', () => {
    const { project } = fixture()
    const report = buildPdfReport({
      projectName: '导出测试',
      modules: project.modules,
      config: {
        cellWidth: 20, cellHeight: 30, gridColor: '#e5e5e5',
        backgroundColor: '#ffffff', defaultFillColor: '#3b82f6',
        textDisplay: 'action', scaleMs: CONFIG.scaleMs, precisionMs: CONFIG.precisionMs
      },
      resources: project.resources,
      allocations: project.allocations,
      cycleConfig: project.cycleConfig,
      labels: {
        chartPage: '动作时序', resourceChartPage: '资源甘特图', tablePage: '参数表',
        totalCycle: '总周期', moduleCount: '模块数', exportedAt: '导出时间', untitledProject: '未命名',
        columns: {
          module: '模块', action: '动作', stage: '阶段', startPosition: '起始位置',
          moveCount: '步数', intervalTime: '间隔', startTime: '起始', endTime: '结束'
        }
      },
      now: new Date('2026-01-01T00:00:00Z')
    })
    expect(report.html).toContain('资源甘特图')
    expect(report.html).toContain('取血抓手')
    expect(report.html).toContain('<svg')
  })

  it('buildPdfReport stays backward compatible without resource data', () => {
    const { project } = fixture()
    const report = buildPdfReport({
      projectName: '导出测试',
      modules: project.modules,
      config: {
        cellWidth: 20, cellHeight: 30, gridColor: '#e5e5e5',
        backgroundColor: '#ffffff', defaultFillColor: '#3b82f6',
        textDisplay: 'action', scaleMs: CONFIG.scaleMs
      },
      labels: {
        chartPage: '动作时序', tablePage: '参数表',
        totalCycle: '总周期', moduleCount: '模块数', exportedAt: '导出时间', untitledProject: '未命名',
        columns: {
          module: '模块', action: '动作', stage: '阶段', startPosition: '起始位置',
          moveCount: '步数', intervalTime: '间隔', startTime: '起始', endTime: '结束'
        }
      },
      now: new Date('2026-01-01T00:00:00Z')
    })
    expect(report.html).toContain('参数表')
    expect(report.html).not.toContain('资源甘特图')
  })
})
