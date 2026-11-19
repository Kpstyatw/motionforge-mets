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
| 默认项目文件类型，便于二次开发 | 偏好设置可选 **JSON / Excel / CSV**，默认 JSON；三种格式都由同一份规范化 `ProjectData` 生成，模块、依赖、资源、周期、Excel/Gantt/Canvas 配置一致 |
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
| `src/lib/dependencyEngine.ts` | 核心排程：规范化、环检测 `findCycles/wouldCreateCycle`、拓扑排序、`computeSchedule` 级联求解、树扁平化 `flattenTree`、依赖序列化/反序列化、前后继集合；`renumberHierarchyCodes` 按当前树生成 `01.01.01` 层级编号 |
| `src/lib/resourceScheduler.ts` | 资源层：窗口换算 `placeAllocations`（按 `activeSlot` 解析落点）、资源树冲突 `detectConflicts`（祖先×后代，同任务/兄弟不判）、层级泳道投影 `computeResourceSchedule`（父先子后 + depth）、忙碌时长 `resourceBusyMs`、窗口钳制 `clampAllocationWindow` |
| `src/lib/resourceTree.ts` | 资源树/相位纯函数：祖先链 `resourceChain/isResourceAncestor`、相位 `selectedSlotIndex`、落点 `resolveClaimResourceId`、归属反查 `buildResourceOwnerIndex`、冲突域 `claimsShareDomain` |
| `src/lib/excelModel.ts` | 纯数据层（无 ExcelJS）：Excel 行构造 `buildExcelRows`、列定义、矩阵跨度 `matrixStep`、文件名 |
| `src/services/excelService.ts` | ExcelJS 工作簿读写的**按需加载**模块：`buildGanttWorkbook` / `importGanttWorkbook`；甘特矩阵表头按 `matrixLabelEvery` 合并时间列并显示时间段；设置表保存/恢复 `ganttConfig`、`canvasConfig` 与项目版本/时间戳 |
| `src/services/jsonProject.ts` | JSON 项目文件：`buildProjectJson` / `parseProjectJson`，统一走 `migrateProject`，并定义 CSV 元数据列 `__project_json` |
| `src/services/saveProject.ts` | 统一保存：`saveProjectFile` 按 JSON / Excel / CSV 生成同一份规范化项目快照；桌面按关联格式写回，新项目/另存为使用偏好设置默认格式 |
| `src/lib/cycleEngine.ts` | **固定周期投影**：`normalizeCycleConfig` / `expandCycles` / `collapseCycleProjection` / 实例↔模板 id 映射 / 超周期检测；单周期是 `repeats=1` 的退化路径 |
| `src/hooks/useCycleView.ts` | 甘特 / 资源 / Excel 共用的派生视图：展开模板 → 排程 → 资源窗口，三处数据不可能不一致；额外提供 `templateSchedule` 供多周期甘特按模板行渲染 |
| `src/components/CycleDialog.tsx` | 周期时长/周期数设置、常用周期预设、超周期提示 |
| `src/components/GanttView.tsx` | SVG 甘特图：四层级树行、时间刻度、依赖箭头、汇总括号、缩放/折叠、双击编辑；流程/资源分组切换、资源冲突角标；**单/多周期切换、周期分隔线、实例 C 标记、编辑回写模板** |
| `src/components/ResourceLanes.tsx` | 资源泳道视图：每条资源一行、精确占用块、重叠红标（含跨周期重叠）、点击跳回流程动作 |
| `src/components/ResourceManagerDialog.tsx` | 全局资源表管理：增删改机构/电机、颜色、类型、引用计数 |
| `src/components/ResourceAllocationDialog.tsx` | 单动作的资源占用编辑：精确偏移/时长、钳制到动作时长内、快速新建资源 |
| `src/components/GanttSidePanel.tsx` | 左侧层级面板：树选择、增删节点、折叠控制 |
| `src/components/TaskEditorDialog.tsx` | 任务编辑：时序（支持 `1234 / 1234ms / 1.234s / 01:23.456`）、起始方式、前置/后置任务增删改、循环拦截；**资源占用入口** |
| `src/components/TimeScaleDialog.tsx` | 时间刻度/精度、行高、**时间格宽**、依赖线、汇总括号配置；格宽写入 `ganttConfig.pxPerMs`（= 格宽 ÷ 刻度），只在对话框打开时快照配置，避免编辑中被外部更新覆盖 |
| `src/hooks/useCSVImport.ts` | **两个文件入口**：`handleOpen` 仅 `.json`（完整项目快照，Ctrl+O），`handleImport` 仅 `.csv/.xlsx/.xlsm`（CSV 行 + `__project_json` 元数据 / 五工作表 Excel，Ctrl+I）；桌面原生对话框按入口设置过滤器，Web `<input accept>` 同步收窄；两者都能在无项目时创建项目，ExcelJS 动态加载。**Electron 下 Excel 走 `readFileBinary` base64 字节通道**，避免 UTF-8 解码破坏 zip（`src/lib/binary.ts` 负责还原） |
| `src/components/AddNodeDialog.tsx` | 新增模块/机构/动作/子动作节点 |
| `src/lib/cycleEngine.test.ts` | 7 项单测：单周期退化、N 周期展开与平移、层级/依赖继承、资源窗口继承、折叠回模板、超周期告警、**跨周期冲突检出** |
| `src/lib/dependencyEngine.test.ts` | 15 项单测：级联重算、四种依赖、环检测、层级折叠、毫秒精度 |
| `src/lib/resourceScheduler.test.ts` | 8 项单测：精确窗口、级联跟随、跨流程冲突、边界相接不冲突、多对多、汇总/删除任务忽略、忙碌并集、窗口钳制 |
| `src/services/excelService.test.ts` | 8 项单测：矩阵层级列+稀疏时间标签、表头 N 刻度合并单元格、表格取数一致、工作簿往返无损、base64 字节通道导入、多周期折叠回模板、资源/占用往返无损、矩阵列上限 |
| `src/services/projectFormats.test.ts` | 3 项单测：JSON 完整项目往返、CSV 元数据列与 JSON 快照一致、Excel 恢复 Gantt/Canvas 配置，确保三种保存格式信息一致 |

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
| `electron/main.ts` | `dialog:openFile(kind)` 按 `project`（JSON）/ `data`（CSV/Excel）切换过滤器，旧的无参调用仍显示全部格式；新增 `fs:readFileBinary`（base64 字节通道），修复 Excel 被 UTF-8 解码损坏 |
| `electron/preload.ts` | 暴露 `readFileBinary`、`openFile(kind)` 给渲染进程（类型声明同步） |
| `src/locales/*/common.json` | 简中/繁中/英/日/韩 五语言补充 gantt / timeScale / excel / resource / cycle 文案 |
| `package.json` | 新增 `exceljs`、`vitest`，脚本 `test` / `typecheck` |

---

## 4. 交互实现

- **视图切换**：工具栏按钮在「层级甘特图」与「原有节拍网格」间切换；两者共享同一份 `computeSchedule` 结果。为避免同一功能出现两次，甘特视图只显示甘特自己的「时间刻度」与「缩小/放大/适应窗口」，网格视图才显示顶部全局「时间刻度与精度」与画布缩放。
- **尺寸可调**：「时间刻度」对话框除刻度/精度/行高外，还可设「时间格宽」（每格时间刻度的像素数，4–400 px，换算为 `pxPerMs` = 格宽 ÷ 刻度，与甘特工具栏缩放等效），随项目持久化。左侧第一列是模块/机构层级信息列，宽度固定、不随时间格变化。
- **层级编号**：编号按当前树自动生成层级路径，例如 `01` → `01.01` → `01.01.01` → `01.01.01.01`；父节点编号始终是子节点编号的前缀，模块/机构/动作/子动作及任意深度的子动作都能从编号直接看出包含关系。内部依赖仍使用稳定 `id`，新增、删除、调整顺序后编号自动重排，不会破坏前置关系。Excel「编号」「上级编号」「前置任务」列使用同一套层级编号。
- **节点颜色**：任务编辑器「颜色」区提供系统取色器 + 10 个预设色，可按节点单独修改；勾选「同步到所有下级」则整棵子树统一换色。颜色同步到甘特条、资源泳道、Excel「颜色」列与 PDF；Excel 导入时颜色列也会写回。
- **层级操作**：侧栏树单击选中、双击编辑；每个节点可「新增下级」（子动作的下级仍是子动作，层数不限）。逐节点折叠箭头保留在侧栏与甘特标签列；「全部展开 / 隐藏所有子动作 / 全部折叠」只在甘特工具栏出现一次。汇总行（模块/机构）起止时间由后代自动卷算，不可直接编辑、不可挂前置任务。
- **依赖编辑**：任务编辑器「前置任务」区可新增（下拉选择候选任务 + 类型 + 延迟）、修改、删除；`wouldCreateCycle` 实时拦截会形成环的选择；甘特图以箭头展示依赖，点击可选中相关任务。
- **级联重算**：任何 `setTaskTiming`（开始/时长/结束）、`addPredecessor` 等操作提交后，`commit()` 调用依赖引擎重排全部任务并写回；后置起始自动同步，环或悬空依赖在界面给出警告。
- **Excel 往返**：顶部「甘特图 ⇄ Excel」是唯一工作台入口；导出弹窗中的按钮改为「打开 Excel 工作台」，避免误以为会直接生成文件。ExcelDialog 中自定义行高/列宽/字号/矩阵跨度后导出五工作表工作簿；导入时按依赖重新排程并写回项目（含资源与占用），「导入 Excel（含布局回写）」会同时恢复工作簿中的布局设置；「校验一致性」逐行检查 `开始+持续=结束` 与依赖约束并给出报告。右上角 `×` 与底部「保存设置并关闭」行为一致，都会保存布局。
  - **甘特矩阵表头时间合并**：「表头时间合并 (刻度数)」设为 N 时，第 2 页甘特矩阵的表头每 N 个刻度列**合并成一个单元格**，显示该段时间段（如 `0ms–400ms`），解决窄列里时间标签竖排拥挤的问题；0 = 不合并（退回按列宽自动稀疏标注）。仅合并表头行，数据行的条形始终按单刻度绘制以保持时间精度。该设置写入「设置与依赖」表，导出→导入无损往返。
- **打开 / 导入 / 保存**：顶部工具栏三个入口语义分离——「打开」(文件夹图标，`Ctrl+O`) 只选 `.json` 完整项目文件；「导入」(上传图标，`Ctrl+I`) 只选 `.csv/.xlsx/.xlsm` 表格数据；「保存」(`Ctrl+S`) 按关联格式写回。两种入口的文件对话框过滤器与 Web `<input accept>` 均已收窄，误选格式会给出明确提示。
- **默认项目文件类型**：「偏好设置 → 默认文件类型」可选 JSON / Excel / CSV，默认 **JSON**。新项目和「另存为」使用默认格式；已关联文件按原格式写回，避免把共享的 `.xlsx` 悄悄改成 `.json`。三种格式均由同一份 `ProjectData` 规范化快照生成：JSON 是可读完整项目文件；CSV 在最右侧写入 `__project_json` 元数据列保存资源/周期/布局等普通表格无法表达的信息；Excel 在「设置与依赖」表恢复 `ganttConfig` 与 `canvasConfig`。导入任一格式都会得到一致的项目状态。
- **流程 / 资源双视图**：甘特工具栏的「流程 / 资源」切换只改变分组维度，不改数据。流程视图看完整时序链，资源视图看各机构/电机的占用与冲突；任务编辑框的「资源占用」入口以精确偏移+时长声明占用，窗口随依赖级联自动跟随。冲突只以红标提示，不自动改时序（后续可加自动消解开关）。
- **单周期 / 多周期**：工具栏「单周期 / 多周期」一键切换 + 齿轮设置周期时长与数量。单周期直接编辑模板；多周期在**同一行的时间轴上向右延伸**出各周期条形（不再向下追加重复行），画紫色周期分隔线与 C1/C2 编号，表头「起止 (ms) ×N」提示每行含 N 个周期。双击任一周期的条形编辑的都是模板，全部周期同步。跨周期资源重叠在资源泳道标红。
- **快捷键与帮助**：「打开」`Ctrl+O` 与「导入」`Ctrl+I` 分离；「速度设置」改用 `Ctrl+Alt+S`，不再与「另存为」`Ctrl+Shift+S` 冲突；右下悬浮键盘按钮直接打开完整快捷键说明弹窗，界面上不再保留第二套精简快捷键面板。

---

## 5. 资源 / 机构统一模型

> 状态：**阶段 1 已实施完成**（2026-11-19）。数据模型、资源树/相位引擎、派生接线、三处 UI、Excel/三格式往返、示例数据与单测均已落地；64 项测试全通过。阶段 2（物料状态推导）待后续。本节同时是阶段 2 的实施依据。

### 5.1 问题背景

**概念界定（必须先厘清）**：模块 / 机构（`ModuleData`，`kind='module'|'mechanism'`）是仪器里真实存在的**物理模块**，属于流程树，用来描述设备结构与动作归属；资源（`Resource`）是在**物理模块和流程基础上抽象**出来的可占用单元，服务于冲突检测与调度。资源不等同于物理模块——它可以对应一个机构（抓手），也可以是机构的一部分（清洗盘孔位），或是多个模块协同形成的抽象能力。两者是「物理实体 → 抽象资源」的**映射**，不是同一对象的两份数据，也不要求一对一绑定。当前的问题是二者**没有任何关联字段**：流程里“调用了某机构”不会转化为对抽象资源的占用，资源名与机构名也无法对应维护。

同时资源表是**扁平**的，无法表达“清洗盘包含孔位”“一个孔位上有管即被占用”这类组合结构；冲突检测也只在显式 `ResourceAllocation` 之间进行，因此表达不出“一个流程在用抓手，另一个流程不能同时用”。

还有一层**运动学关系**未被表达：清洗盘旋转时，盘上每个孔位跟着一起转（孔位身份不变、空间位置随盘变），而外部工位（加样位/读数位）空间固定。于是“每个周期选中哪个孔位”是旋转相位的函数，不是用户逐周期手填的数据。

### 5.2 目标模型（四条规则）

1. **物理机构映射到抽象资源是层级归属，不产生占用。** 流程节点（模块/机构）可选择一个抽象资源作为归属（`ModuleData.resourceId`，可选）——这是“物理模块 → 抽象资源”的显式映射，仅用于把资源泳道分组到对应模块/机构下，让两个视图的层级保持一致。**归属绝不意味着该节点下的流程动作占用该资源**：一个动作是否占用、占用多久，完全由流程甘特图里为该动作 authored 的 `ResourceAllocation`（`offsetMs + durationMs`）决定。映射基数由数据决定，可一对一、一对多、多对一；资源可在流程图编辑器或资源视图中新增，占用时间在流程图编辑器中设置并实时同步到资源视图。
2. **资源有组成层级。** `Resource` 增加 `parentId`，形成资源树：清洗盘（父）→ 孔位 1..N（子）。占用某个子资源不排斥其他子资源；占用父资源则向下传播，与所有子资源的占用窗口互斥。父资源的忙碌度显示“部分占用 / 全部占用”。
3. **子资源位置绑定父资源相位。** 父资源可声明旋转模型，子槽位随父旋转；槽位身份（孔 1、孔 2…）稳定，空间位置只是派生量。外部工位空间固定，“当前周期对准工位的槽位”由相位函数推导，不逐周期手填。详见 5.2.1。
4. **冲突检测在资源树上做，按身份不按位置。** 沿用半开区间 `[start, end)` 和整数毫秒。冲突判定：同资源重叠、祖先占用与后代占用重叠；兄弟槽位之间不冲突；盘转到何处不改变槽位身份，因此不产生额外的跨槽位冲突。冲突仍只提示、不自动改时序。

**两类独立的冲突都要体现（缺一不可）：**

| 冲突维度 | 检测对象 | 颜色标记 | 实现模块 |
|---|---|---|---|
| 资源占用冲突 | 多个动作声明占用同一（或祖先/后代）资源，时间重叠 | 红色 `!` | `resourceScheduler.ts` |
| 机构并发冲突 | 同一机构（无机构则回退到模块）下多个**最细叶子动作**执行窗口重叠——一个物理机构同一时刻只能做一件事 | 橙色 `M` | `mechanismConflict.ts` |

机构并发冲突刻意只比较最细叶子（无子节点的 action/subaction）：父动作与其子动作是同一动作的两个粒度，天然重叠不算冲突；不同机构互不干扰；无机构/模块归属的动作跳过；半开区间首尾相接不算冲突；零时长忽略。两类冲突都只提示、不改时序。流程甘特图动作条可同时显示两种标记，工具栏分别汇总数量。

占用只有一种来源 —— 流程甘特图里为动作声明的 `ResourceAllocation`，相对动作开始的 `offsetMs + durationMs`，随依赖级联移动。它同时服务所有场景（抓手、样本针、孔位、多资源协作）。资源归属（模块/机构 → 资源）只决定泳道分组，不生成任何占用；历史文件里若残留 `source: 'mechanism'` 的占用仍可显示，但新数据不再产生。

| 来源 | 生成方式 | 典型场景 |
|---|---|---|
| 显式占用（唯一） | `ResourceAllocation`，相对动作的 `offsetMs + durationMs`，随依赖级联移动 | 抓手、样本针、孔位、多资源协作等全部场景 |
| 槽位占用（占用落到的具体槽位） | 占用解析到某槽位后，挂在**该槽位 id** 上 | “孔上有管即占用”、逐周期选孔 |

#### 5.2.1 旋转相位与“当前选中孔位”

- **父资源声明旋转**：`Resource.motion?: { type: 'rotary'; slots: number; stepPerCycle: number; startSlot?: number }`。`slots` 为槽位数，`stepPerCycle` 为每周期步进格数（可为负表示反转），`startSlot` 为周期 1 对准工位的槽位序号，默认 0。
- **子槽位带稳定索引**：子资源 `slotIndex?: number`（0..slots-1），是身份而非坐标；孔 1 在任何周期始终是孔 1。
- **选中函数是派生的**：`selectedSlotAt(cycle) = (startSlot + (cycle - 1) * stepPerCycle) mod slots`。周期 1 选中孔 1，周期 2 选中孔 2（图见本节对话附图），无需用户逐周期录入。
- **工位是空间固定的外部参照**：加样位/读数位不进资源树（或作为不旋转的独立资源）；它们是“选中函数”的观测点，说明为什么每周期选中的槽位不同。
- **占用落点**：当动作绑定盘资源但语义是“操作当前选中孔位”时，调度器用动作所属实例的周期索引调用 `selectedSlotAt`，把占用落到具体槽位 id，再进入 5.2 规则 4 的冲突判定。占用窗口内盘持续旋转不影响槽位身份，所以占用不随旋转漂移。
- **冲突示例**：周期 1 选中孔 1 放入管 → 孔 1 占用；周期 2 盘转 1 格选中孔 2，孔 1 仍占用但已转离工位；直到孔 1 再次对准工位的周期，任何对“当前选中孔位”的操作若与孔 1 的占用窗口重叠才报冲突——判定始终按孔 1 身份，而非屏幕上它转到哪。
- **多工位扩展**：若存在多个固定工位且角度不同，用 `stationOffset` 区分；同一周期不同工位选中不同槽位，仍按槽位身份判重。`stepPerCycle = 0` 表示盘不转、每周期选中同一孔位。

### 5.3 分阶段实施

**阶段 1 — 显式声明 + 结构层（先做）**

- `Resource` 增加 `parentId?: string`、`motion?: RotaryMotion`、`slotIndex?: number`；`ModuleData` 增加 `resourceId?: string`（仅机构节点有意义）。
- `resourceScheduler.ts` 扩展为资源树投影：扁平化 `byResource` 改为带祖先链的 `resolveAncestors`，冲突检测新增“祖先 × 后代”判定，兄弟不判冲突。
- 新增 `selectedSlotAt(resource, cycle)` 相位推导（纯函数，单测覆盖）；占用落点解析：动作绑定盘且语义为“当前选中孔位”时按实例周期解析到槽位 id。5.2.1 的旋转模型纳入阶段 1，因为它决定占用的落点，缺了它冲突判定会指错槽位。
- `ResourceManagerDialog` 支持树形展示、从资源一键创建子资源、机构节点下拉绑定资源；旋转盘可设槽位数、步进格数、起始槽位，子槽位显示索引。
- 资源泳道按资源树分组：盘为父泳道，可展开孔位子泳道；每个周期在盘泳道标注当前选中槽位（由相位函数得出，非手填），占用条始终画在其槽位子泳道上。
- Excel 五工作表的「资源」表增加 `上级资源` / `槽位索引` / `旋转槽位数` / `每周期步进` / `起始槽位` 列；JSON/CSV（`__project_json`）自动兼容新增字段，旧文件缺失时按 `undefined` 处理，`motion` 缺失按“不旋转”处理（每周期选中同一槽位）。
- 现有 11 机构 / 11 资源的示例数据补齐“物理模块 → 抽象资源”的映射关系（按语义对应，不强行一一绑定），并为清洗盘补旋转配置与孔位索引；机构名（物理）与资源名（抽象）允许不同，显示各自名称，靠 `resourceId` 关联。
- 补充单测：父子占用冲突、兄弟占用不冲突、首尾相接不冲突、归属绑定本身不产生任何占用（仅显式声明才产生）、显式占用随依赖级联移动、旋转相位选中槽位正确、占用在盘旋转后仍绑定原槽位、选中槽位占用与孔位既有占用重叠时报冲突。

**阶段 2 — 物料状态推导（后做）**

- 新增物料实体（如“管”），记录其当前所在资源 id。
- 由“放入孔位 / 从孔位取出”这类状态变更动作推导占用窗口：物料在孔中的驻留期 = 该孔资源的占用期。
- 状态变更仍需可视化地对应到动作甘特条，避免引入独立于时序的隐藏排程。
- 与阶段 1 的显式占用并存：物料推导出的占用标记来源为 `material`，UI 上可区分显示。

### 5.4 与现有设计的边界

- **视图不合并**：流程视图仍按模块/机构/动作分组，资源视图仍按资源树分组；两者通过 `resourceId` 联动高亮。模型统一不等于视图统一。
- **汇总节点仍不排程**：机构/模块节点依然是汇总行，本身既不排程也不产生占用窗口；资源占用只来自流程里为动作显式声明的窗口，机构归属资源只用于层级分组。
- **旋转只改位置、不改身份**：盘的子槽位随盘旋转，但占用、冲突、统计全部按槽位 id；相位函数只决定“当前选中哪个槽位”，不复制或迁移占用记录。多工位用 `stationOffset` 区分，仍落到具体槽位判重。
- **多周期**：实例占用沿用 `templateIdOf` 折叠规则；跨周期同资源重叠继续在资源泳道标红；旋转选孔按实例周期索引推导，与多周期横向投影共用同一个 cycle 编号。
- **三个保存格式**：新增字段全部进入同一份规范化 `ProjectData` 快照，JSON / CSV / Excel 保持信息一致；读取旧文件时新字段缺省，不破坏历史项目。

---

## 6. 验证与构建

```bash
npm install
npm run typecheck          # tsc --noEmit，通过
npm test                   # vitest，55 项全通过
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
