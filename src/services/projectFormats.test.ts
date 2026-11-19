import { describe, expect, it } from 'vitest'
import { ModuleData, ProjectData, TaskKind } from '@/types'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG } from '@/lib/timeScale'
import { buildProjectJson, parseProjectJson, PROJECT_META_COLUMN } from './jsonProject'
import { buildProjectCSV } from './exportService'
import { parseProjectCSVText } from './csvImport'
import { buildGanttWorkbook, importGanttWorkbook } from './excelService'

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
  return {
    name: '格式一致性测试',
    modules: [
      node('M', 'T01', 'module', null, 0, 0),
      { ...node('K', 'T02', 'mechanism', 'M', 0, 0), resourceId: 'PLATE' },
      node('A', 'T03', 'action', 'K', 200, 800),
      node('B', 'T04', 'action', 'K', 0, 300, [{ id: 'e1', fromId: 'A', type: 'FS', lagMs: 125 }])
    ],
    resources: [
      { id: 'R1', name: '抓手', type: 'motor', color: '#ff0000', notes: '资源说明' },
      {
        id: 'PLATE', name: '清洗盘',
        motion: { type: 'rotary', slots: 4, stepPerCycle: 1, startSlot: 0, stationOffset: 0 }
      },
      { id: 'H0', name: '孔1', parentId: 'PLATE', slotIndex: 0 }
    ],
    allocations: [
      { id: 'AL1', taskId: 'A', resourceId: 'R1', offsetMs: 10, durationMs: 100, notes: '占用说明' },
      { id: 'AL2', taskId: 'A', resourceId: 'PLATE', slotMode: 'activeSlot', offsetMs: 0, durationMs: 50 }
    ],
    canvasConfig: {
      cellWidth: 24, cellHeight: 32, showGrid: true, showRuler: true,
      gridColor: '#112233', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6'
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: '2.0.0',
    schemaVersion: 2,
    timeConfig: { ...CONFIG },
    cycleConfig: { enabled: true, cycleMs: 30_000, repeats: 3 },
    excelLayout: {
      ...DEFAULT_EXCEL_LAYOUT,
      matrixLabelEvery: 4,
      columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths, action: 40 }
    },
    ganttConfig: { ...DEFAULT_GANTT_CONFIG, pxPerMs: 0.8, rowHeight: 42 }
  }
}

function expectSameAuthoringData(actual: ProjectData, expected: ProjectData) {
  expect(actual.name).toBe(expected.name)
  expect(actual.modules.map(m => m.id)).toEqual(expected.modules.map(m => m.id))
  expect(actual.modules.find(m => m.id === 'B')?.predecessors?.[0]).toMatchObject({
    fromId: 'A', type: 'FS', lagMs: 125
  })
  expect(actual.resources).toEqual(expected.resources.map(r => ({
    ...r,
    type: r.type, color: r.color, notes: r.notes, parentId: r.parentId,
    slotIndex: r.slotIndex,
    motion: r.motion ? {
      type: 'rotary' as const, slots: r.motion.slots, stepPerCycle: r.motion.stepPerCycle,
      startSlot: r.motion.startSlot ?? 0, stationOffset: r.motion.stationOffset ?? 0
    } : undefined
  })))
  expect(actual.allocations).toEqual(expected.allocations.map(a => ({
    ...a, slotMode: a.slotMode, source: a.source
  })))
  expect(actual.cycleConfig).toEqual(expected.cycleConfig)
  expect(actual.excelLayout.matrixLabelEvery).toBe(expected.excelLayout.matrixLabelEvery)
  expect(actual.excelLayout.columnWidths.action).toBe(40)
  expect(actual.ganttConfig).toEqual(expected.ganttConfig)
  expect(actual.canvasConfig).toEqual(expected.canvasConfig)
  expect(actual.createdAt).toBe(expected.createdAt)
  expect(actual.version).toBe(expected.version)
}

describe('CSV / JSON / Excel project file consistency', () => {
  it('round-trips the full authoring model through JSON', () => {
    const project = fixture()
    const parsed = parseProjectJson(buildProjectJson(project))
    expect(parsed.success).toBe(true)
    expectSameAuthoringData(parsed.project!, project)
  })

  it('embeds the same JSON snapshot in the CSV metadata column', async () => {
    const project = fixture()
    const csv = buildProjectCSV(
      project.modules,
      { format: 'csv', includeCalculatedPositions: true },
      project.timeConfig,
      project
    )
    expect(csv).toContain(PROJECT_META_COLUMN)

    const result = await parseProjectCSVText(csv)
    expect(result.success).toBe(true)
    expect(result.data?.length).toBe(project.modules.length)
    expectSameAuthoringData(result.projectMeta!, project)
  })

  it('restores Gantt/canvas config from the Excel workbook', async () => {
    const project = fixture()
    const schedule = computeSchedule(project.modules, project.timeConfig)
    const rows = flattenTree(schedule)
    const blob = await buildGanttWorkbook({ project, schedule, rows, layout: project.excelLayout })
    const result = await importGanttWorkbook(new File([await blob.arrayBuffer()], 'project.xlsx'))

    expect(result.success).toBe(true)
    expect(result.ganttConfig).toEqual(project.ganttConfig)
    expect(result.canvasConfig).toEqual(project.canvasConfig)
    expect(result.cycleConfig).toEqual(project.cycleConfig)
    expect(result.excelLayout?.matrixLabelEvery).toBe(4)
  })
})
