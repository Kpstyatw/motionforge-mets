/**
 * Generates a realistic worked example for the Gantt edition:
 * a chemiluminescence immunoassay analyser (CLIA, magnetic-bead method),
 * one compressed test cycle, millisecond timeline.
 *
 * The workbook is produced with the app's OWN exporter so it round-trips
 * into CycleView without losing a single millisecond.
 *
 *   npx vite-node --config vitest.config.ts scripts/generate-example.ts
 */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import {
  Dependency, DependencyType, ModuleData, ProjectData, Resource,
  ResourceAllocation, TimeConfig
} from '@/types'
import { computeSchedule, flattenTree } from '@/lib/dependencyEngine'
import { buildGanttWorkbook } from '@/services/excelService'
import {
  DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG
} from '@/lib/timeScale'

const OUT_DIR = resolve(process.cwd(), 'examples')
mkdirSync(OUT_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Time config: 100 ms ruler divisions, 1 ms precision.
// ---------------------------------------------------------------------------
const timeConfig: TimeConfig = { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' }
const SCALE = timeConfig.scaleMs

// ---------------------------------------------------------------------------
// Resources: the physical mechanisms / motors shared across flows.
// ---------------------------------------------------------------------------
const resources: Resource[] = [
  { id: 'RES-SAMPLE-NEEDLE', name: '样本针', type: 'needle', color: '#3b82f6', notes: '吸样/加样，Z轴电机 + 注射泵' },
  { id: 'RES-TUBE-GRIPPER', name: '管库抓手', type: 'gripper', color: '#8b5cf6', notes: '抓取/转运反应杯；加样流程与稀释分支共用' },
  { id: 'RES-REAGENT-NEEDLE-1', name: '试剂针1(磁珠)', type: 'needle', color: '#10b981', notes: '磁珠包被抗体试剂' },
  { id: 'RES-REAGENT-NEEDLE-2', name: '试剂针2(标记)', type: 'needle', color: '#14b8a6', notes: '吖啶酯标记抗体试剂' },
  { id: 'RES-INCUBATOR', name: '温育盘', type: 'motor', color: '#f59e0b', notes: '37°C 孵育转盘，步进电机' },
  { id: 'RES-MAG-SEP', name: '磁分离站', type: 'station', color: '#f97316', notes: '磁珠捕获 / 磁场分离' },
  { id: 'RES-WASH-NEEDLE', name: '洗涤针', type: 'needle', color: '#ec4899', notes: '加清洗液、吸废液' },
  { id: 'RES-WASTE-PUMP', name: '废液泵', type: 'pump', color: '#6366f1', notes: '排废液' },
  { id: 'RES-SUBSTRATE-NEEDLE', name: '底物针', type: 'needle', color: '#06b6d4', notes: '加预激发液/激发液' },
  { id: 'RES-PMT', name: 'PMT检测器', type: 'detector', color: '#ef4444', notes: '光电倍增管，采集化学发光信号' },
  { id: 'RES-LOADING-DOCK', name: '加样位载具', type: 'fixture', color: '#84cc16', notes: '承接样本加样的反应杯工位' }
]

// ---------------------------------------------------------------------------
// Hierarchy: 模块 → 机构 → 动作 → 子动作 (sub-actions nested one more level).
// id == code so dependency labels stay human-readable (S07:FS:+0).
// ---------------------------------------------------------------------------
let depSeq = 0
const dep = (fromId: string, type: DependencyType = 'FS', lagMs = 0): Dependency => ({
  id: `DEP-${++depSeq}`, fromId, type, lagMs
})

const modules: ModuleData[] = []
function add(
  code: string, kind: ModuleData['kind'], name: string,
  parentId: string | null, startMs: number, durationMs: number,
  color: string, predecessors: Dependency[] = [], stage?: string
) {
  modules.push({
    id: code,
    code,
    kind,
    parentId,
    moduleName: name,
    actionDescription: name,
    stage,
    color,
    startMs,
    anchorMs: startMs,
    durationMs: kind === 'module' || kind === 'mechanism' ? 0 : durationMs,
    endMs: startMs + (kind === 'module' || kind === 'mechanism' ? 0 : durationMs),
    startMode: 'auto',
    predecessors,
    startX: startMs / SCALE,
    calculatedStartX: startMs / SCALE,
    moveCount: durationMs / SCALE,
    duration: SCALE,
    isSequentialAction: false
  })
}

const C_BLUE = '#3b82f6', C_GREEN = '#10b981', C_ORANGE = '#f59e0b'
const C_CYAN = '#06b6d4', C_PURPLE = '#8b5cf6'

// ===== M1 样本处理模块 =====
add('M1', 'module', '样本处理模块', null, 0, 0, C_BLUE)
add('MECH-SAMPLE', 'mechanism', '样本针组件', 'M1', 0, 0, C_BLUE)
add('A-SAMPLE', 'action', '样本针吸样与加样', 'MECH-SAMPLE', 0, 2900, C_BLUE)
add('S01', 'subaction', '样本针下降至样本管', 'A-SAMPLE', 0, 800, C_BLUE)
add('S02', 'subaction', '吸取样本 30µL', 'A-SAMPLE', 800, 1500, C_BLUE, [dep('S01')])
add('S03', 'subaction', '样本针抬升并转位', 'A-SAMPLE', 2300, 600, C_BLUE, [dep('S02')])

add('MECH-GRIPPER', 'mechanism', '管库抓手组件', 'M1', 0, 0, C_PURPLE)
add('A-CUP', 'action', '抓取反应杯承接加样', 'MECH-GRIPPER', 0, 4500, C_PURPLE)
add('S04', 'subaction', '抓手移动至管库', 'A-CUP', 0, 1000, C_PURPLE)
add('S05', 'subaction', '抓取空反应杯', 'A-CUP', 1000, 700, C_PURPLE, [dep('S04')])
add('S06', 'subaction', '移送反应杯至加样位', 'A-CUP', 1700, 900, C_PURPLE, [dep('S05')])
add('S07', 'subaction', '保持承接(样本臂加样)', 'A-CUP', 2600, 1900, C_PURPLE, [dep('S06')])

add('MECH-BARCODE', 'mechanism', '扫码组件', 'M1', 0, 0, C_BLUE)
add('A-BARCODE', 'action', '样本条码识别', 'MECH-BARCODE', 0, 1200, C_BLUE)
add('S08', 'subaction', '样本管旋转扫码', 'A-BARCODE', 0, 1200, C_BLUE)

// ===== M2 反应温育模块 =====
add('M2', 'module', '反应温育模块', null, 4500, 0, C_GREEN)
add('MECH-REAGENT1', 'mechanism', '试剂针1组件', 'M2', 4500, 0, C_GREEN)
add('A-REAGENT1', 'action', '加磁珠包被抗体', 'MECH-REAGENT1', 4500, 3200, C_GREEN)
add('S09', 'subaction', '试剂针1吸取磁珠试剂', 'A-REAGENT1', 4500, 1500, C_GREEN, [dep('S07')])
add('S10', 'subaction', '试剂针1加入反应杯', 'A-REAGENT1', 6000, 900, C_GREEN, [dep('S09')])
add('S11', 'subaction', '试剂针1清洗', 'A-REAGENT1', 6900, 800, C_GREEN, [dep('S10')])

add('MECH-REAGENT2', 'mechanism', '试剂针2组件', 'M2', 7800, 0, C_GREEN)
add('A-REAGENT2', 'action', '加吖啶酯标记抗体', 'MECH-REAGENT2', 7800, 3100, C_GREEN)
add('S12', 'subaction', '试剂针2吸取标记试剂', 'A-REAGENT2', 7800, 1400, C_GREEN, [dep('S11', 'FS', 100)])
add('S13', 'subaction', '试剂针2加入反应杯', 'A-REAGENT2', 9200, 900, C_GREEN, [dep('S12')])
add('S14', 'subaction', '试剂针2清洗', 'A-REAGENT2', 10100, 800, C_GREEN, [dep('S13')])

add('MECH-INCUBATOR', 'mechanism', '温育盘组件', 'M2', 10900, 0, C_ORANGE)
add('A-INCUBATE', 'action', '37°C 温育孵育', 'MECH-INCUBATOR', 10900, 20000, C_ORANGE)
add('S15', 'subaction', '反应杯转入温育盘', 'A-INCUBATE', 10900, 1000, C_ORANGE, [dep('S14')])
add('S16', 'subaction', '温育孵育(演示压缩为20s)', 'A-INCUBATE', 11900, 20000, C_ORANGE, [dep('S15')])
add('S17', 'subaction', '温育盘间歇转动(每30s)', 'S16', 12900, 18000, C_ORANGE, [dep('S16', 'SS', 1000)])

// ===== M3 分离洗涤模块 =====
add('M3', 'module', '分离洗涤模块', null, 31900, 0, C_ORANGE)
add('MECH-MAGSEP', 'mechanism', '磁分离组件', 'M3', 31900, 0, C_ORANGE)
add('A-MAGSEP', 'action', '磁珠分离', 'MECH-MAGSEP', 31900, 3500, C_ORANGE)
add('S18', 'subaction', '反应杯转入磁分离位', 'A-MAGSEP', 31900, 1000, C_ORANGE, [dep('S16')])
add('S19', 'subaction', '磁场捕获磁珠复合物', 'A-MAGSEP', 32900, 2500, C_ORANGE, [dep('S18')])

add('MECH-WASH', 'mechanism', '洗涤组件', 'M3', 35400, 0, C_ORANGE)
add('A-WASH', 'action', '三阶磁珠洗涤', 'MECH-WASH', 35400, 4000, C_ORANGE)
add('S20', 'subaction', '洗涤针加清洗液', 'A-WASH', 35400, 1800, C_ORANGE, [dep('S19')])
add('S21', 'subaction', '磁分离静置吸废液', 'A-WASH', 37200, 2200, C_ORANGE, [dep('S20')])
add('S21A', 'subaction', '废液泵排液', 'S21', 37200, 2000, C_ORANGE, [dep('S21', 'SS', 0)])

// ===== M4 发光检测模块 =====
add('M4', 'module', '发光检测模块', null, 39400, 0, C_CYAN)
add('MECH-SUBSTRATE', 'mechanism', '底物针组件', 'M4', 39400, 0, C_CYAN)
add('A-TRIGGER', 'action', '加激发底物', 'MECH-SUBSTRATE', 39400, 2200, C_CYAN)
add('S22', 'subaction', '加预激发液(H₂O₂)', 'A-TRIGGER', 39400, 1200, C_CYAN, [dep('S21')])
add('S23', 'subaction', '加激发液(NaOH) 触发发光', 'A-TRIGGER', 40600, 1000, C_CYAN, [dep('S22')])

add('MECH-PMT', 'mechanism', 'PMT检测组件', 'M4', 41600, 0, C_CYAN)
add('A-DETECT', 'action', '发光信号检测与结果输出', 'MECH-PMT', 41600, 2800, C_CYAN)
add('S24', 'subaction', '反应杯送入检测暗室', 'A-DETECT', 41600, 900, C_CYAN, [dep('S23')])
add('S25', 'subaction', 'PMT采集发光强度(RLU)', 'A-DETECT', 42500, 400, C_CYAN, [dep('S24')])
add('S26', 'subaction', '浓度换算与结果上传', 'A-DETECT', 42900, 1500, C_CYAN, [dep('S25')])

// ===== M5 样本稀释模块（分支流程，复用管库抓手 → 制造冲突）=====
add('M5', 'module', '样本稀释模块(分支流程)', null, 2000, 0, C_PURPLE)
add('MECH-DILUTE', 'mechanism', '稀释抓手复用', 'M5', 2000, 0, C_PURPLE)
add('A-DISCARD', 'action', '丢弃稀释完成反应杯', 'MECH-DILUTE', 2000, 1600, C_PURPLE)
add('S27', 'subaction', '抓手丢弃稀释完成的反应管', 'A-DISCARD', 2000, 1600, C_PURPLE)

// ---------------------------------------------------------------------------
// Resource allocations: exact windows relative to each action's resolved start.
// S27 overlaps S06 [1700,2600) and S07 [2600,4500) on 管库抓手 → the conflict
// the resource-lane view is meant to surface.
// ---------------------------------------------------------------------------
let allocSeq = 0
const alloc = (taskCode: string, resourceId: string, offsetMs: number, durationMs: number, notes?: string): ResourceAllocation => ({
  id: `ALLOC-${++allocSeq}`, taskId: taskCode, resourceId, offsetMs, durationMs, notes
})
const allocations: ResourceAllocation[] = [
  alloc('S01', 'RES-SAMPLE-NEEDLE', 0, 800, '下降全程占用'),
  alloc('S02', 'RES-SAMPLE-NEEDLE', 200, 900, '仅吸液段占用(精确窗口 ≠ 动作全程)'),
  alloc('S03', 'RES-SAMPLE-NEEDLE', 0, 600),
  alloc('S04', 'RES-TUBE-GRIPPER', 0, 1000),
  alloc('S05', 'RES-TUBE-GRIPPER', 0, 700),
  alloc('S06', 'RES-TUBE-GRIPPER', 0, 900, '移送占用'),
  alloc('S07', 'RES-TUBE-GRIPPER', 0, 1900, '保持承接样本臂加样'),
  alloc('S07', 'RES-LOADING-DOCK', 0, 1900, '同一动作同时占用载具 → 多对多协同'),
  alloc('S08', 'RES-LOADING-DOCK', 0, 1200, '样本管识别工位'),
  alloc('S09', 'RES-REAGENT-NEEDLE-1', 0, 1500),
  alloc('S10', 'RES-REAGENT-NEEDLE-1', 0, 900),
  alloc('S11', 'RES-REAGENT-NEEDLE-1', 0, 800),
  alloc('S12', 'RES-REAGENT-NEEDLE-2', 0, 1400),
  alloc('S13', 'RES-REAGENT-NEEDLE-2', 0, 900),
  alloc('S14', 'RES-REAGENT-NEEDLE-2', 0, 800),
  alloc('S15', 'RES-INCUBATOR', 0, 1000),
  alloc('S16', 'RES-INCUBATOR', 0, 20000, '温育全程占用温育盘'),
  alloc('S18', 'RES-INCUBATOR', 0, 1000),
  alloc('S19', 'RES-MAG-SEP', 0, 2500),
  alloc('S20', 'RES-WASH-NEEDLE', 0, 1800),
  alloc('S21', 'RES-WASH-NEEDLE', 0, 2200),
  alloc('S21A', 'RES-WASTE-PUMP', 0, 2000),
  alloc('S22', 'RES-SUBSTRATE-NEEDLE', 0, 1200),
  alloc('S23', 'RES-SUBSTRATE-NEEDLE', 0, 1000),
  alloc('S25', 'RES-PMT', 0, 400),
  alloc('S27', 'RES-TUBE-GRIPPER', 0, 1600, '稀释分支复用抓手 → 与 S06/S07 冲突')
]

// `S08` also sits on the loading dock; to avoid a bogus overlap with S07
// (which holds the dock 2600-4500) S08's dock claim is earlier — no conflict.
// (S08 [0,1200) vs S07/S dock [2600,4500): no overlap.)

// ---------------------------------------------------------------------------
// Physical-module → abstract-resource mapping, rotary disc and active slots.
// A mechanism bound to a resource auto-claims it during its actions' windows;
// the 温育盘 is a rotary parent whose 8 holes are stable child slots.
// ---------------------------------------------------------------------------
const mechanismBindings: Record<string, string> = {
  'MECH-SAMPLE': 'RES-SAMPLE-NEEDLE',
  'MECH-GRIPPER': 'RES-TUBE-GRIPPER',
  'MECH-REAGENT1': 'RES-REAGENT-NEEDLE-1',
  'MECH-REAGENT2': 'RES-REAGENT-NEEDLE-2',
  'MECH-INCUBATOR': 'RES-INCUBATOR',
  'MECH-MAGSEP': 'RES-MAG-SEP',
  'MECH-PMT': 'RES-PMT',
  'MECH-SUBSTRATE': 'RES-SUBSTRATE-NEEDLE'
}
modules.forEach(m => {
  if (mechanismBindings[m.id]) m.resourceId = mechanismBindings[m.id]
})
const disc = resources.find(r => r.id === 'RES-INCUBATOR')!
disc.motion = { type: 'rotary', slots: 8, stepPerCycle: 1, startSlot: 0, stationOffset: 0 }
for (let i = 0; i < 8; i++) {
  resources.push({
    id: `RES-INCUBATOR-H${i + 1}`,
    name: `温育盘孔位 ${i + 1}`,
    type: 'slot',
    parentId: 'RES-INCUBATOR',
    slotIndex: i,
    color: disc.color
  })
}
// Demonstration: claim whichever hole the disc has rotated to this cycle.
allocations.push({
  id: 'ALLOC-ACTIVE-SLOT', taskId: 'S20', resourceId: 'RES-INCUBATOR',
  slotMode: 'activeSlot', offsetMs: 0, durationMs: 200,
  notes: '演示：当前周期选中的温育孔位'
})

// ---------------------------------------------------------------------------
// Build the project, run the real scheduler, export with the real exporter.
// ---------------------------------------------------------------------------
const now = new Date('2026-11-17T10:00:00.000Z')
const project: ProjectData = {
  name: '化学发光免疫分析仪-单次检测流程(示例)',
  modules,
  resources,
  allocations,
  canvasConfig: {
    cellWidth: 24, cellHeight: 22, showGrid: true, showRuler: true,
    gridColor: '#e5e7eb', backgroundColor: '#ffffff', defaultFillColor: '#3b82f6'
  },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  version: '2.1.0',
  schemaVersion: 2,
  timeConfig,
  excelLayout: { ...DEFAULT_EXCEL_LAYOUT },
  ganttConfig: { ...DEFAULT_GANTT_CONFIG }
}

const schedule = computeSchedule(modules, timeConfig)
const rows = flattenTree(schedule)
const blob = await buildGanttWorkbook({
  project, schedule, rows, includeHiddenRows: true, now
})
const buffer = Buffer.from(await blob.arrayBuffer())
const xlsxPath = resolve(OUT_DIR, '化学发光免疫分析仪-动作时序甘特.xlsx')
writeFileSync(xlsxPath, buffer)
writeFileSync(
  resolve(OUT_DIR, '化学发光免疫分析仪-项目数据.json'),
  JSON.stringify(project, null, 2)
)

console.log('OK')
console.log('xlsx:', xlsxPath, buffer.length, 'bytes')
console.log('modules:', modules.length, 'allocations:', allocations.length, 'rows:', rows.length)
console.log('totalMs:', schedule.totalMs)
console.log('warnings:', schedule.warnings)
