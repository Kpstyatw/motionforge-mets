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
| 甘特图 ⇄ Excel，单元格尺寸自定义 | `excelService` **五工作表**工作簿（动作时序 / 甘特矩阵 / 设置与依赖 / 资源 / 资源占用），`ExcelDialog` 可编辑行列尺寸、导出并导回，附一致性校验 |
| 图表与表格数据一致 | 两者均由同一个 `computeSchedule` 结果取数；`verify()` 校验 `开始+持续=结束` 与依赖约束 |
| 层级 模块→机构→动作→子动作，子动作可无限嵌套、可折叠 | `TaskKind` 四类型 + `parentId` 树；`flattenTree(schedule, collapsedIds)` 支持逐节点/全部折叠隐藏 |
| 流程视角 vs 资源视角的平衡 | `resources` 全局唯一 + `allocations` 精确窗口（相对动作的多对多关系）；甘特视图「流程/资源」切换只换分组不改数据 |
| 资源占用冲突提示 | `resourceScheduler.detectConflicts` 按资源检测精确窗口重叠，泳道红标 + 流程角标 + 点击跳转；**只提示不自动改时序** |
| 固定周期重复动作，单/多周期都能展示 | `CycleConfig` + `cycleEngine.expandCycles`：底层只存一份模板；单周期直接编辑模板，多周期按 `cycleMs × repeats` 投影只读实例；甘特工具栏一键切换，周期在时间轴横向延伸（不追加重复行）、周期分隔线与 C 编号、超周期提示；编辑任一周期回写模板 |

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

### 2.1 固定周期投影层（单周期 / 多周期）

节拍型设备（如化学发光免疫分析仪每 30 s 出一个结果）只维护**一份动作模板**；周期数不是复制出来的数据，而是视图参数：

```ts
interface CycleConfig { enabled: boolean; cycleMs: number; repeats: number }
// ProjectData 增补：cycleConfig?: CycleConfig
// ModuleData 增补（仅实例有）：cycleIndex?: number; cycleTemplateId?: string
```

`cycleEngine.ts` 的展开/折叠是纯函数：

- `expandCycles(modules, allocations, cycleConfig)`：每个实例 id/code 追加 `@C1…@Cn`，所有时刻平移 `(cycle-1)*cycleMs`，并复制层级 `parentId`、依赖边、资源占用窗口；`instanceId ↔ templateId` 双向映射供编辑回写与 Excel 折叠。
- `collapseCycleProjection()`：把工作簿里的 `@Cn` 行折叠回一份模板，Excel 导入后按 `cycleConfig` 重新展开。
- 超周期检测：模板任务 `endMs > cycleMs` 时给出警告；跨周期资源重叠由既有 `resourceScheduler` 在展开实例上直接检出（首尾相接不算冲突）。

**甘特视图布局**：多周期只扩展**时间轴**，不追加行。行始终按模板层级出现一次（`useCycleView.templateSchedule` → `flattenTree`），每个模板行再用 `templateToInstances` 取出 C1…Cn 实例，各自按绝对时刻画成同一行上的横向条形；依赖箭头、汇总括号、冲突角标同样以实例为数据源、以模板行为 Y 坐标。C2 及以后的条形略淡并带 `C2·` 前缀。资源泳道与 Excel 仍按实例逐条列出（导入折叠回模板）；经典节拍网格、PDF 与 MP4 仍按单周期模板输出，避免把 N 倍行塞进动画。

### 2.2 资源占用层（流程视角 vs 资源视角的平衡）

设备动作同时存在两个正交维度：**属于哪个流程**（模块→机构→动作树）与**占用哪个机构/电机**。若用一棵树同时表达，必然导致资源在多个流程里重复编辑，或看不出跨流程的资源争用。解法是把两者解耦：

```ts
interface Resource { id; name; type?; color?; notes? }              // 全局唯一资源表
interface ResourceAllocation {                                      // 多对多的"关系"实体
  id; taskId; resourceId
  offsetMs; durationMs   // 相对动作开始的精确窗口，绝对窗口 = task.startMs + offsetMs
}
// ProjectData 增补：resources: Resource[]; allocations: ResourceAllocation[]
```

- **不重复编辑**：管库抓手只定义一次，"加样流程抓管"与"稀释流程丢管"是两条 allocation 引用，改资源属性一处生效。
- **多对多**：一个动作可同时占用抓手+样本臂+加样针（多资源协同），一个资源可被多个流程的动作在不同时刻引用。
- **精确窗口**：占用不必等于动作全程——抓手 2.0–3.2s 抓管后释放，3.3s 即可服务另一流程，避免粗粒度 `resourceIds` 的误报。
- **级联自动**：offset 相对动作起点，依赖引擎顺延动作时占用窗口自动跟随。

**冲突检测**（`resourceScheduler.ts`）按资源分组、按绝对窗口排序，用半开区间 `[start, end)` 检测重叠（首尾相接不算冲突），生成 `Conflict`。当前版本**只提示不自动改时序**：资源泳道红标 + 流程视图任务条角标，点击可跳转源动作。

---

## 3. 模块修改清单

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/lib/timeScale.ts` | 时间基准：量化 `quantize`、格式化 `formatTime`、输入解析 `parseTimeInput`、刻度 `rulerTicks`、默认配置 |
| `src/lib/dependencyEngine.ts` | 核心排程：规范化、环检测 `findCycles/wouldCreateCycle`、拓扑排序、`computeSchedule` 级联求解、树扁平化 `flattenTree`、依赖序列化/反序列化、前后继集合 |
| `src/lib/resourceScheduler.ts` | 资源层：精确窗口换算 `placeAllocations`、按资源重叠检测 `detectConflicts`、泳道投影 `computeResourceSchedule`、忙碌时长 `resourceBusyMs`、窗口钳制 `clampAllocationWindow` |
| `src/lib/excelModel.ts` | 纯数据层（无 ExcelJS）：Excel 行构造 `buildExcelRows`、列定义、矩阵跨度 `matrixStep`、文件名 |
| `src/services/excelService.ts` | ExcelJS 工作簿读写的**按需加载**模块：`buildGanttWorkbook` / `importGanttWorkbook` |
| `src/lib/cycleEngine.ts` | **固定周期投影**：`normalizeCycleConfig` / `expandCycles` / `collapseCycleProjection` / 实例↔模板 id 映射 / 超周期检测；单周期是 `repeats=1` 的退化路径 |
| `src/hooks/useCycleView.ts` | 甘特 / 资源 / Excel 共用的派生视图：展开模板 → 排程 → 资源窗口，三处数据不可能不一致；额外提供 `templateSchedule` 供多周期甘特按模板行渲染 |
| `src/components/CycleDialog.tsx` | 周期时长/周期数设置、常用周期预设、超周期提示 |
| `src/components/GanttView.tsx` | SVG 甘特图：四层级树行、时间刻度、依赖箭头、汇总括号、缩放/折叠、双击编辑；流程/资源分组切换、资源冲突角标；**单/多周期切换、周期分隔线、实例 C 标记、编辑回写模板** |
| `src/components/ResourceLanes.tsx` | 资源泳道视图：每条资源一行、精确占用块、重叠红标（含跨周期重叠）、点击跳回流程动作 |
| `src/components/ResourceManagerDialog.tsx` | 全局资源表管理：增删改机构/电机、颜色、类型、引用计数 |
| `src/components/ResourceAllocationDialog.tsx` | 单动作的资源占用编辑：精确偏移/时长、钳制到动作时长内、快速新建资源 |
| `src/components/GanttSidePanel.tsx` | 左侧层级面板：树选择、增删节点、折叠控制 |
| `src/components/TaskEditorDialog.tsx` | 任务编辑：时序（支持 `1234 / 1234ms / 1.234s / 01:23.456`）、起始方式、前置/后置任务增删改、循环拦截；**资源占用入口** |
| `src/components/TimeScaleDialog.tsx` | 时间刻度/精度、行高、依赖线、汇总括号配置 |
| `src/hooks/useCSVImport.ts` | **统一文件导入入口**：按扩展名路由 `.csv` → CSV 导入 / `.xlsx/.xlsm` → 五工作表 Excel 导入；两种格式都能在无项目时创建项目，桌面走原生对话框、Web 走 `<input accept=".csv,.xlsx,.xlsm">`；ExcelJS 动态加载。**Electron 下 Excel 走 `readFileBinary` base64 字节通道**，避免 UTF-8 解码破坏 zip（`src/lib/binary.ts` 负责还原） |
| `src/components/AddNodeDialog.tsx` | 新增模块/机构/动作/子动作节点 |
| `src/lib/cycleEngine.test.ts` | 7 项单测：单周期退化、N 周期展开与平移、层级/依赖继承、资源窗口继承、折叠回模板、超周期告警、**跨周期冲突检出** |
| `src/lib/dependencyEngine.test.ts` | 15 项单测：级联重算、四种依赖、环检测、层级折叠、毫秒精度 |
| `src/lib/resourceScheduler.test.ts` | 8 项单测：精确窗口、级联跟随、跨流程冲突、边界相接不冲突、多对多、汇总/删除任务忽略、忙碌并集、窗口钳制 |
| `src/services/excelService.test.ts` | 6 项单测：表格取数一致、工作簿往返无损、base64 字节通道导入、多周期折叠回模板、资源/占用往返无损、矩阵列上限 |

### 改造

| 文件 | 变更 |
| --- | --- |
| `src/types/index.ts` | 见第 2 节数据结构 |
| `src/stores/useProjectStore.ts` | 新增 `setTimeConfig / setCycleConfig / setTaskTiming / setStartMode / addAction / deleteTask / addPredecessor / updatePredecessor / removePredecessor / setGanttConfig / recompute`；新增资源/占用 CRUD `addResource/updateResource/removeResource/addAllocation/updateAllocation/removeAllocation`，删任务时级联清理占用；`commit()` 统一调用依赖引擎重算并把结果同步回旧字段（`syncLegacyFields`），保证网格/动画/导出一致 |
| `src/stores/useUIStore.ts` | 新增 `chartView`（gantt/grid）与 `collapsedTaskIds` 折叠集合 |
| `src/lib/timingModel.ts` | 时间计算改用整数毫秒模型，供网格与播放复用 |
| `src/lib/canvasRenderer.ts` | 渲染读取统一排程结果 |
| `src/services/csvImport.ts` | 自动合成 模块→机构→动作 层级；保留 `anchorMs` 列 |
| `src/services/exportService.ts` | CSV 导出补充层级、依赖、`anchorMs` 列 |
| `src/services/excelService.ts` | 工作簿由三工作表扩为**五工作表**（动作时序 / 甘特矩阵 / 设置与依赖 / 资源 / 资源占用），占用以动作编号+资源ID导出、导入时映射回ID；**设置表记录 cycleEnabled/cycleMs/cycleRepeats，导入折叠实例回模板** |
| `src/components/ExcelDialog.tsx` | 单元格尺寸编辑、Excel 导出/导入、一致性校验报告；**空项目也可打开并导入**（此前 `!project` 时返回 null 导致无法以 Excel 起步），无项目时禁用导出；导出当前可见周期视图 |
| `src/services/pdfExport.ts` / `videoExport.ts` | 报告表格与动画时长改用 `computeSchedule` / `computeTotalDurationMs`，与甘特图同源 |
| `src/components/Canvas/GridCanvas.tsx` | 兼容新层级行与排程结果 |
| `src/components/ExportDialog.tsx` | 增加「Excel 甘特表」入口，回调打开 ExcelDialog |
| `src/App.tsx` | 工具栏切换 甘特/网格 视图；**导入按钮改用统一入口**（CSV/Excel 通吃，`toolbar.importFile` 文案）；接入 TimeScaleDialog、ExcelDialog、任务编辑器、资源管理与占用编辑器 |
| `electron/main.ts` | `dialog:openFile` 过滤器加入 `xlsx/xlsm`；新增 `fs:readFileBinary`（base64 字节通道），修复 Excel 被 UTF-8 解码损坏 |
| `electron/preload.ts` | 暴露 `readFileBinary` 给渲染进程（类型声明同步） |
| `src/locales/*/common.json` | 简中/繁中/英/日/韩 五语言补充 gantt / timeScale / excel / resource / cycle 文案 |
| `package.json` | 新增 `exceljs`、`vitest`，脚本 `test` / `typecheck` |

---

## 4. 交互实现

- **视图切换**：工具栏按钮在「层级甘特图」与「原有节拍网格」间切换；两者共享同一份 `computeSchedule` 结果。
- **层级操作**：侧栏树单击选中、双击编辑；每个节点可「新增下级」（子动作的下级仍是子动作，层数不限）；逐节点折叠箭头 + 全部展开/折叠 + 隐藏所有子动作。汇总行（模块/机构）起止时间由后代自动卷算，不可直接编辑、不可挂前置任务。
- **依赖编辑**：任务编辑器「前置任务」区可新增（下拉选择候选任务 + 类型 + 延迟）、修改、删除；`wouldCreateCycle` 实时拦截会形成环的选择；甘特图以箭头展示依赖，点击可选中相关任务。
- **级联重算**：任何 `setTaskTiming`（开始/时长/结束）、`addPredecessor` 等操作提交后，`commit()` 调用依赖引擎重排全部任务并写回；后置起始自动同步，环或悬空依赖在界面给出警告。
- **Excel 往返**：ExcelDialog 中自定义行高/列宽/字号/矩阵跨度后导出五工作表工作簿；导入时按依赖重新排程并写回项目（含资源与占用）；「校验一致性」逐行检查 `开始+持续=结束` 与依赖约束并给出报告。
- **流程 / 资源双视图**：甘特工具栏的「流程 / 资源」切换只改变分组维度，不改数据。流程视图看完整时序链，资源视图看各机构/电机的占用与冲突；任务编辑框的「资源占用」入口以精确偏移+时长声明占用，窗口随依赖级联自动跟随。冲突只以红标提示，不自动改时序（后续可加自动消解开关）。
- **单周期 / 多周期**：工具栏「单周期 / 多周期」一键切换 + 齿轮设置周期时长与数量。单周期直接编辑模板；多周期在**同一行的时间轴上向右延伸**出各周期条形（不再向下追加重复行），画紫色周期分隔线与 C1/C2 编号，表头「起止 (ms) ×N」提示每行含 N 个周期。双击任一周期的条形编辑的都是模板，全部周期同步。跨周期资源重叠在资源泳道标红。

---

## 5. 验证与构建

```bash
npm install
npm run typecheck          # tsc --noEmit，通过
npm test                   # vitest，36 项全通过
npm run build:web          # Web 版（online 模式）
npm run build              # Electron 安装包
```

**按需加载**：ExcelJS 通过 ExcelDialog 中的动态 `import('@/services/excelService')` 单独打包。Web 主包约 **580 KB**（gzip 195 KB），Excel 工作簿模块约 **950 KB**（gzip 276 KB）仅在导出/导入时加载，首屏体积较拆分前（约 1.5 MB）显著下降。

**核心不变量**（由单测守护）：

1. 所有时刻为整数毫秒，`开始 + 持续 = 结束` 恒成立。
2. 任一前置任务的开始/时长/结束变化，所有后置任务的起始自动满足依赖约束。
3. 环依赖被检测且不产生有效排程；删除/解锁后锚点行为正确。
4. Excel 导出→导入往返后，时序、层级、依赖、单元格尺寸、资源与占用配置无损恢复。
5. 资源占用窗口相对动作存储，动作被顺延时窗口同步跟随；同一资源窗口重叠被检出，首尾相接不算冲突。
6. 单/多周期共享一份模板：展开实例时间严格按周期平移；编辑实例回写模板；Excel 多周期导出后折叠回模板再展开，时序逐毫秒一致；跨周期占用重叠同样被检出。
