import { describe, expect, it } from 'vitest'
import { ProjectData, ModuleData, TaskKind } from '@/types'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG } from '@/lib/timeScale'
import {
  buildExcelRows, buildGanttWorkbook, excelFileName, importGanttWorkbook, matrixStep
} from './excelService'

const CONFIG = { ...DEFAULT_TIME_CONFIG }

function node(
  id: string, code: string, kind: TaskKind, parentId: string | null,
  startMs: number, durationMs: number, predecessors: ModuleData['predecessors'] = []
): ModuleData {
  return {
    id, code, kind, parentId,
    moduleName: kind === 'module' ? '进样模块' : 'Feeder_1',
    actionDescription: kind === 'module' ? '进样模块' : kind === 'mechanism' ? 'Feeder_1' : `动作 ${code}`,
    stage: 'A', color: '#3b82f6',
    startMs, anchorMs: startMs, durationMs, endMs: startMs + durationMs,
    startMode: 'auto', predecessors,
    startX: startMs / CONFIG.scaleMs, calculatedStartX: startMs / CONFIG.scaleMs,
    moveCount: durationMs / CONFIG.scaleMs, duration: CONFIG.scaleMs,
    isSequentialAction: false
  }
}

function fixture(): ProjectData {
  const modules = [
    node('M', 'T01', 'module', null, 0, 0),
    node('K', 'T02', 'mechanism', 'M', 0, 0),
    node('A', 'T03', 'action', 'K', 200, 800),
    node('B', 'T04', 'action', 'K', 0, 300, [{ id: 'e1', fromId: 'A', type: 'FS', lagMs: 125 }]),
    node('S', 'T05', 'subaction', 'B', 0, 50, [{ id: 'e2', fromId: 'B', type: 'SS', lagMs: 10 }])
  ]
  return {
    name: 'IVD 测试项目',
    modules,
    canvasConfig: {
      cellWidth: 20, cellHeight: 30, showGrid: true, showRuler: true,
      gridColor: '#e5e5e5', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: '2.0.0', schemaVersion: 2,
    timeConfig: CONFIG,
    excelLayout: { ...DEFAULT_EXCEL_LAYOUT, columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths } },
    ganttConfig: { ...DEFAULT_GANTT_CONFIG }
  }
}

describe('Gantt ⇄ Excel', () => {
  it('table rows carry exactly the resolved schedule values', () => {
    const project = fixture()
    const schedule = computeSchedule(project.modules, CONFIG)
    const rows = flattenTree(schedule)
    const table = buildExcelRows(schedule, rows)
    expect(table).toHaveLength(5)
    expect(schedule.byId.B.startMs).toBe(1125) // A ends at 1000 + 125 lag
    expect(schedule.byId.S.startMs).toBe(1135)
    const b = table.find(r => r.code === 'T04')!
    expect(b.startMs + b.durationMs).toBe(b.endMs)
    expect(b.startMs).toBe(schedule.byId.B.startMs)
    expect(b.predecessors).toContain('T03:FS:+125')
    expect(b.parentCode).toBe('T02')
  })

  it('exports a workbook with custom cell sizes and imports it back losslessly', async () => {
    const project = fixture()
    const schedule = computeSchedule(project.modules, CONFIG)
    const rows = flattenTree(schedule)
    const layout = {
      ...project.excelLayout,
      rowHeight: 31, headerHeight: 42, fontSize: 12,
      matrixCellWidth: 6, matrixRowHeight: 24, matrixStepMs: 250,
      columnWidths: { ...project.excelLayout.columnWidths, action: 40 }
    }
    const blob = await buildGanttWorkbook({ project, schedule, rows, layout })
    expect(blob.size).toBeGreaterThan(5000)
    expect(excelFileName(project.name)).toBe('IVD 测试项目-gantt.xlsx')

    const file = new File([await blob.arrayBuffer()], 'gantt.xlsx')
    const result = await importGanttWorkbook(file)
    expect(result.success).toBe(true)
    expect(result.modules).toHaveLength(5)
    expect(result.timeConfig?.scaleMs).toBe(CONFIG.scaleMs)
    expect(result.excelLayout?.rowHeight).toBe(31)
    expect(result.excelLayout?.headerHeight).toBe(42)
    expect(result.excelLayout?.matrixCellWidth).toBe(6)
    expect(result.excelLayout?.columnWidths.action).toBe(40)

    const restored = result.modules!
    const restoredSchedule = computeSchedule(restored, result.timeConfig!)
    expect(restoredSchedule.byId.A.startMs).toBe(schedule.byId.A.startMs)
    expect(restoredSchedule.byId.B.startMs).toBe(schedule.byId.B.startMs)
    expect(restoredSchedule.byId.S.startMs).toBe(schedule.byId.S.startMs)
    expect(restoredSchedule.totalMs).toBe(schedule.totalMs)
    expect(restoredSchedule.byId.B.predecessorIds).toEqual(['A'])
    expect(restoredSchedule.byId.S.module.parentId).toBe('B')
    // Chart and table stay consistent after the round trip.
    const table = buildExcelRows(restoredSchedule, flattenTree(restoredSchedule))
    expect(table.every(r => r.startMs + r.durationMs === r.endMs)).toBe(true)
  })

  it('caps the time-bucket matrix to a printable number of columns', () => {
    const layout = { ...DEFAULT_EXCEL_LAYOUT }
    const step = matrixStep(600_000, CONFIG, layout)
    expect(step % CONFIG.scaleMs).toBe(0)
    expect(Math.ceil(600_000 / step)).toBeLessThanOrEqual(180)
  })
})
