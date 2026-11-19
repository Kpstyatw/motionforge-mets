import { describe, expect, it } from 'vitest'
import { ProjectData, ModuleData, TaskKind } from '@/types'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG } from '@/lib/timeScale'
import { base64ToBytes } from '@/lib/binary'
import { expandCycles } from '@/lib/cycleEngine'
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
    resources: [],
    allocations: [],
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
  it('matrix sheet shows hierarchy columns and sparse time labels', async () => {
    const project = fixture()
    const schedule = computeSchedule(project.modules, CONFIG)
    const rows = flattenTree(schedule)
    const blob = await buildGanttWorkbook({ project, schedule, rows })

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const matrix = wb.getWorksheet('甘特矩阵')!
    const header = matrix.getRow(1)

    // Three left columns describe the hierarchy, with an explicit type column.
    expect(header.getCell(1).value).toBe('编号')
    expect(header.getCell(2).value).toBe('类型')
    expect(header.getCell(3).value).toBe('模块 / 机构 / 动作')

    // First data row is the 模块 summary: type cell reads 模块.
    expect(matrix.getCell(2, 2).value).toBe('模块')
    // The 子动作 row is indented (module row has 0 / no indent written).
    const subRow = 6
    expect(matrix.getCell(subRow, 2).value).toBe('子动作')
    expect(matrix.getCell(subRow, 3).alignment?.indent ?? 0).toBeGreaterThan(
      matrix.getCell(2, 3).alignment?.indent ?? 0
    )

    // Time labels are sparse: not every bucket column carries a label.
    const timeHeaders: string[] = []
    for (let c = 4; c <= header.cellCount; c++) {
      timeHeaders.push(String(header.getCell(c).value ?? ''))
    }
    const labelled = timeHeaders.filter(v => v.length > 0).length
    expect(labelled).toBeGreaterThan(0)
    expect(labelled).toBeLessThan(timeHeaders.length) // not one label per column
  })

  it('merges matrix header time cells into N-tick spans without merging data rows', async () => {
    const project = fixture()
    const schedule = computeSchedule(project.modules, CONFIG)
    const rows = flattenTree(schedule)
    const layout = {
      ...project.excelLayout,
      columnWidths: { ...project.excelLayout.columnWidths },
      matrixLabelEvery: 4
    }
    const blob = await buildGanttWorkbook({ project, schedule, rows, layout })

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const matrix = wb.getWorksheet('甘特矩阵')!
    const header = matrix.getRow(1)

    // The merge list must contain only header-row horizontal spans (row 1).
    const merges: string[] = (matrix.model.merges as string[]) ?? []
    expect(merges.length).toBeGreaterThan(0)
    merges.forEach(m => {
      const [from, to] = m.split(':')
      expect(from).toMatch(/^([A-Z]+)1$/)
      expect(to).toMatch(/^([A-Z]+)1$/)
    })
    // Each merged header shows the span, e.g. "0ms–400ms".
    const spanLabels = Array.from({ length: header.cellCount }, (_, i) =>
      String(header.getCell(i + 1).value ?? '')
    ).filter(v => v.includes('–'))
    expect(spanLabels.length).toBeGreaterThan(0)
    expect(spanLabels[0]).toMatch(/^.*–.*ms$/)

    // No data-row merges: action bars stay one cell per tick.
    expect(merges.every(m => /1$/.test(m.split(':')[0]))).toBe(true)

    // The setting round-trips through the workbook.
    const result = await importGanttWorkbook(new File([await blob.arrayBuffer()], 'merged.xlsx'))
    expect(result.success).toBe(true)
    expect(result.excelLayout?.matrixLabelEvery).toBe(4)
  })

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
    // The editable colour column must survive the round trip.
    expect(result.modules!.find(m => m.id === 'A')?.color).toBe('#3b82f6')

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

  it('imports a workbook transferred through the Electron base64 bridge', async () => {
    const project = fixture()
    const schedule = computeSchedule(project.modules, CONFIG)
    const blob = await buildGanttWorkbook({ project, schedule, rows: flattenTree(schedule) })
    // Exactly what main + preload do: read bytes, encode base64, decode in renderer.
    const raw = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    raw.forEach(byte => { binary += String.fromCharCode(byte) })
    const bytes = base64ToBytes(btoa(binary))

    const result = await importGanttWorkbook(new File([bytes], 'bridge.xlsx'))
    expect(result.success).toBe(true)
    expect(result.modules).toHaveLength(project.modules.length)
    expect(computeSchedule(result.modules!, CONFIG).byId.B.startMs).toBe(schedule.byId.B.startMs)
  })

  it('round-trips a multi-cycle workbook back to one template', async () => {
    const project = fixture()
    project.resources = [{ id: 'GRIP', name: '管库抓手' }]
    project.allocations = [{ id: 'al1', taskId: 'A', resourceId: 'GRIP', offsetMs: 50, durationMs: 100 }]
    const cycleConfig = { enabled: true, cycleMs: 2000, repeats: 3 }
    const view = expandCycles(project.modules, project.allocations, cycleConfig)
    const schedule = computeSchedule(view.modules, CONFIG)
    expect(view.modules).toHaveLength(project.modules.length * 3)

    const blob = await buildGanttWorkbook({
      project: { ...project, cycleConfig, allocations: view.allocations },
      schedule,
      rows: flattenTree(schedule)
    })
    const result = await importGanttWorkbook(new File([await blob.arrayBuffer()], 'cycles.xlsx'))
    expect(result.success).toBe(true)
    expect(result.cycleConfig).toMatchObject(cycleConfig)
    expect(result.modules).toHaveLength(project.modules.length)
    expect(result.allocations).toHaveLength(1)
    expect(result.modules!.find(m => m.id === 'B')?.predecessors?.[0].fromId).toBe('A')
    expect(result.modules!.find(m => m.id === 'B')?.parentId).toBe('K')

    const rebuilt = expandCycles(result.modules!, result.allocations!, result.cycleConfig!)
    const rescheduled = computeSchedule(rebuilt.modules, CONFIG)
    expect(rescheduled.totalMs).toBe(schedule.totalMs)
    expect(rescheduled.byId['A@C3'].startMs).toBe(schedule.byId['A@C3'].startMs)
  })

  it('round-trips resources and exact-window allocations losslessly', async () => {
    const project = fixture()
    project.resources = [
      { id: 'GRIP', name: '管库抓手', type: 'gripper', color: '#3b82f6' },
      { id: 'ARM', name: '样本臂', type: 'arm', color: '#10b981' }
    ]
    project.allocations = [
      { id: 'al1', taskId: 'A', resourceId: 'GRIP', offsetMs: 0, durationMs: 300 },
      { id: 'al2', taskId: 'A', resourceId: 'ARM', offsetMs: 200, durationMs: 400 },
      { id: 'al3', taskId: 'B', resourceId: 'GRIP', offsetMs: 50, durationMs: 100 }
    ]
    const schedule = computeSchedule(project.modules, CONFIG)
    const rows = flattenTree(schedule)
    const blob = await buildGanttWorkbook({ project, schedule, rows, layout: project.excelLayout })
    const result = await importGanttWorkbook(new File([await blob.arrayBuffer()], 'gantt.xlsx'))
    expect(result.success).toBe(true)
    expect(result.resources).toHaveLength(2)
    expect(result.resources!.find(r => r.id === 'GRIP')!.name).toBe('管库抓手')
    expect(result.allocations).toHaveLength(3)
    const a2 = result.allocations!.find(a => a.id === 'al2')!
    expect(a2.taskId).toBe('A')
    expect(a2.resourceId).toBe('ARM')
    expect(a2.offsetMs).toBe(200)
    expect(a2.durationMs).toBe(400)
  })

  it('round-trips resource tree, rotary motion and activeSlot claims', async () => {
    const project = fixture()
    project.modules[1] = { ...project.modules[1], resourceId: 'PLATE' }
    project.resources = [
      { id: 'PLATE', name: '清洗盘', motion: { type: 'rotary', slots: 4, stepPerCycle: 1, startSlot: 0, stationOffset: 0 } },
      { id: 'H0', name: '孔1', parentId: 'PLATE', slotIndex: 0 },
      { id: 'H1', name: '孔2', parentId: 'PLATE', slotIndex: 1 }
    ]
    project.allocations = [
      { id: 'slotClaim', taskId: 'A', resourceId: 'PLATE', slotMode: 'activeSlot', offsetMs: 10, durationMs: 100 }
    ]
    const schedule = computeSchedule(project.modules, CONFIG)
    const rows = flattenTree(schedule)
    const blob = await buildGanttWorkbook({ project, schedule, rows, layout: project.excelLayout })
    const result = await importGanttWorkbook(new File([await blob.arrayBuffer()], 'tree.xlsx'))
    expect(result.success).toBe(true)
    const plate = result.resources!.find(r => r.id === 'PLATE')!
    expect(plate.motion).toEqual({ type: 'rotary', slots: 4, stepPerCycle: 1, startSlot: 0, stationOffset: 0 })
    expect(result.resources!.find(r => r.id === 'H1')!.parentId).toBe('PLATE')
    expect(result.resources!.find(r => r.id === 'H1')!.slotIndex).toBe(1)
    expect(result.allocations!.find(a => a.id === 'slotClaim')!.slotMode).toBe('activeSlot')
    expect(result.modules!.find(m => m.id === 'K')!.resourceId).toBe('PLATE')
  })

  it('caps the time-bucket matrix to a printable number of columns', () => {
    const layout = { ...DEFAULT_EXCEL_LAYOUT }
    const step = matrixStep(600_000, CONFIG, layout)
    expect(step % CONFIG.scaleMs).toBe(0)
    expect(Math.ceil(600_000 / step)).toBeLessThanOrEqual(180)
  })
})
