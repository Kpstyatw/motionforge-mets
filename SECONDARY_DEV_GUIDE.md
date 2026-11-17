# DYNMECH CycleView 二次开发说明：动作时序甘特图工具

> 基线项目：`Peter-Pon/motionforge-mets`（DynMech CycleView / 原 METS），Electron + React + TypeScript + Zustand + Canvas。
> 本次二次开发在**保留原有节拍网格、CSV 导入、PDF / MP4 / CSV 导出、播放控制、多语言**等核心能力的前提下，新增毫秒级时序模型、层级甘特图、依赖引擎与 Excel 双向转换。

---

## 1. 功能设计

| 需求 | 实现 |
| --- | --- |
| 可配置时间刻度与精度，最小到毫秒 | `TimeConfig` + `timeScale.ts`。刻度 1 ms ~ 1 h 可选，精度最小 **1 ms**；全局以**整数毫秒**为唯一真值，避免浮点累积误差 |
| 动作/子动作前任务的增、删、改 | `TaskEditorDialog` 的后置任务编辑器 + store 的 `addPredecessor / updatePredecessor / removePredecessor` |
| 直观查看依赖关系 | 甘特图绘制依赖箭头连线；侧栏显示层级与依赖链路；编辑器列出前置/后置任务并拦截循环依赖 |
| 前置任务时间变化 → 后置自动级联重算 | `dependencyEngine.computeSchedule` 拓扑排序 + 约束求解，任一前置的开始/时长/结束变化后全链路重排 |
| 甘特图 ⇄ Excel，单元格尺寸自定义 | `excelService` 三工作表工作簿（动作时序 / 甘特矩阵 / 设置与依赖），`ExcelDialog` 可编辑行列尺寸、导出并导回，附一致性校验 |
| 图表与表格数据一致 | 两者均由同一个 `computeSchedule` 结果取数；`verify()` 校验 `开始+持续=结束` 与依赖约束 |
| 层级 模块→机构→动作→子动作，子动作可无限嵌套、可折叠 | `TaskKind` 四类型 + `parentId` 树；`flattenTree(schedule, collapsedIds)` 支持逐节点/全部折叠隐藏 |

### 依赖语义
支持四种依赖类型 `FS / SS / FF / SF` 与整数毫秒延迟 `lagMs`：

- `FS`（Finish→Start）：后置开始 ≥ 前置结束 + lag
- `SS`（Start→Start）：后置开始 ≥ 前置开始 + lag
- `FF`（Finish→Finish）：后置结束 ≥ 前置结束 + lag（反推开始）
- `SF`（Start→Finish）：后置结束 ≥ 前置开始 + lag（反推开始）

每个任务有 `startMode`：`auto` 完全跟随依赖；`manual` 锁定用户锚点，但仍不早于依赖允许的最早时刻。`anchorMs` 保存用户原始锚点，与解析后的 `startMs` 分离，确保删除依赖、解锁后行为正确。

---

## 2. 数据结构调整

`src/types/index.ts` 核心变更（schemaVersion 1 → 2）：

```ts
type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'
interface Dependency { id; fromId; type: DependencyType; lagMs: number }
type StartMode = 'auto' | 'manual'
type TaskKind = 'module' | 'mechanism' | 'action' | 'subaction'

interface ModuleData {
  // 原有字段保留：id / code / moduleName / actionDescription / startX / moveCount / duration ...
  kind?: TaskKind                 // 新增：层级节点类型
  parentId?: string | null        // 新增：父节点，构成可无限嵌套的树
  startMs?: number                // 新增：解析后的绝对起始（整数 ms，真值）
  anchorMs?: number               // 新增：用户锚定起始，与 startMs 分离
  durationMs?: number             // 新增：时长（整数 ms）
  endMs?: number                  // 新增：结束（整数 ms）
  startMode?: StartMode           // 新增：起始方式
  predecessors?: Dependency[]     // 新增：入边；出边由全局扫描派生
}

interface TimeConfig {
  scaleMs: number        // 刻度：每格毫秒
  precisionMs: number    // 精度：吸附步长，最小 1
  displayUnit: 'ms' | 's'
}
interface ExcelLayoutConfig { rowHeight; headerHeight; fontSize; matrixCellWidth; matrixRowHeight; matrixStepMs; columnWidths }
interface GanttConfig { rowHeight; showDependencies; showSummaryBrackets }
```

**兼容旧数据**：`migrateProject()` / `normalizeModules()` 把上游 schema 1 项目与旧 CSV 行升级到 v2——补齐 `kind`（普通行默认 `action`）、整数毫秒字段、`startMode`、`predecessors`，并按原「格数×每格时长」换算为绝对毫秒。旧 CSV 的模块/机构/动作层级由 `csvImport.ts` 自动合成。

---

## 3. 模块修改清单

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/lib/timeScale.ts` | 时间基准：量化 `quantize`、格式化 `formatTime`、输入解析 `parseTimeInput`、刻度 `rulerTicks`、默认配置 |
| `src/lib/dependencyEngine.ts` | 核心排程：规范化、环检测 `findCycles/wouldCreateCycle`、拓扑排序、`computeSchedule` 级联求解、树扁平化 `flattenTree`、依赖序列化/反序列化、前后继集合 |
| `src/lib/excelModel.ts` | 纯数据层（无 ExcelJS）：Excel 行构造 `buildExcelRows`、列定义、矩阵跨度 `matrixStep`、文件名 |
| `src/services/excelService.ts` | ExcelJS 工作簿读写的**按需加载**模块：`buildGanttWorkbook` / `importGanttWorkbook` |
| `src/components/GanttView.tsx` | SVG 甘特图：四层级树行、时间刻度、依赖箭头、汇总括号、缩放/折叠、双击编辑 |
| `src/components/GanttSidePanel.tsx` | 左侧层级面板：树选择、增删节点、折叠控制 |
| `src/components/TaskEditorDialog.tsx` | 任务编辑：时序（支持 `1234 / 1234ms / 1.234s / 01:23.456`）、起始方式、前置/后置任务增删改、循环拦截 |
| `src/components/TimeScaleDialog.tsx` | 时间刻度/精度、行高、依赖线、汇总括号配置 |
| `src/components/ExcelDialog.tsx` | 单元格尺寸编辑、Excel 导出/导入、一致性校验报告 |
| `src/components/AddNodeDialog.tsx` | 新增模块/机构/动作/子动作节点 |
| `src/lib/dependencyEngine.test.ts` | 15 项单测：级联重算、四种依赖、环检测、层级折叠、毫秒精度 |
| `src/services/excelService.test.ts` | 3 项单测：表格取数一致、工作簿往返无损、矩阵列上限 |

### 改造

| 文件 | 变更 |
| --- | --- |
| `src/types/index.ts` | 见第 2 节数据结构 |
| `src/stores/useProjectStore.ts` | 新增 `setTimeConfig / setTaskTiming / setStartMode / addAction / deleteTask / addPredecessor / updatePredecessor / removePredecessor / setGanttConfig / recompute`；`commit()` 统一调用依赖引擎重算并把结果同步回旧字段（`syncLegacyFields`），保证网格/动画/导出一致 |
| `src/stores/useUIStore.ts` | 新增 `chartView`（gantt/grid）与 `collapsedTaskIds` 折叠集合 |
| `src/lib/timingModel.ts` | 时间计算改用整数毫秒模型，供网格与播放复用 |
| `src/lib/canvasRenderer.ts` | 渲染读取统一排程结果 |
| `src/services/csvImport.ts` | 自动合成 模块→机构→动作 层级；保留 `anchorMs` 列 |
| `src/services/exportService.ts` | CSV 导出补充层级、依赖、`anchorMs` 列 |
| `src/services/pdfExport.ts` / `videoExport.ts` | 报告表格与动画时长改用 `computeSchedule` / `computeTotalDurationMs`，与甘特图同源 |
| `src/components/Canvas/GridCanvas.tsx` | 兼容新层级行与排程结果 |
| `src/components/ExportDialog.tsx` | 增加「Excel 甘特表」入口，回调打开 ExcelDialog |
| `src/App.tsx` | 工具栏切换 甘特/网格 视图；接入 TimeScaleDialog、ExcelDialog、任务编辑器 |
| `src/locales/*/common.json` | 简中/繁中/英/日/韩 五语言补充 gantt / timeScale / excel 文案 |
| `package.json` | 新增 `exceljs`、`vitest`，脚本 `test` / `typecheck` |

---

## 4. 交互实现

- **视图切换**：工具栏按钮在「层级甘特图」与「原有节拍网格」间切换；两者共享同一份 `computeSchedule` 结果。
- **层级操作**：侧栏树单击选中、双击编辑；每个节点可「新增下级」（子动作的下级仍是子动作，层数不限）；逐节点折叠箭头 + 全部展开/折叠 + 隐藏所有子动作。汇总行（模块/机构）起止时间由后代自动卷算，不可直接编辑、不可挂前置任务。
- **依赖编辑**：任务编辑器「前置任务」区可新增（下拉选择候选任务 + 类型 + 延迟）、修改、删除；`wouldCreateCycle` 实时拦截会形成环的选择；甘特图以箭头展示依赖，点击可选中相关任务。
- **级联重算**：任何 `setTaskTiming`（开始/时长/结束）、`addPredecessor` 等操作提交后，`commit()` 调用依赖引擎重排全部任务并写回；后置起始自动同步，环或悬空依赖在界面给出警告。
- **Excel 往返**：ExcelDialog 中自定义行高/列宽/字号/矩阵跨度后导出三工作表工作簿；导入时按依赖重新排程并写回项目；「校验一致性」逐行检查 `开始+持续=结束` 与依赖约束并给出报告。

---

## 5. 验证与构建

```bash
npm install
npm run typecheck          # tsc --noEmit，通过
npm test                   # vitest，18 项全通过
npm run build:web          # Web 版（online 模式）
npm run build              # Electron 安装包
```

**按需加载**：ExcelJS 通过 ExcelDialog 中的动态 `import('@/services/excelService')` 单独打包。Web 主包约 **554 KB**（gzip 187 KB），Excel 工作簿模块约 **947 KB**（gzip 275 KB）仅在导出/导入时加载，首屏体积较拆分前（约 1.5 MB）显著下降。

**核心不变量**（由单测守护）：

1. 所有时刻为整数毫秒，`开始 + 持续 = 结束` 恒成立。
2. 任一前置任务的开始/时长/结束变化，所有后置任务的起始自动满足依赖约束。
3. 环依赖被检测且不产生有效排程；删除/解锁后锚点行为正确。
4. Excel 导出→导入往返后，时序、层级、依赖、单元格尺寸配置无损恢复。
