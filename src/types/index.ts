/**
 * CycleView Gantt Edition — data model.
 *
 * The upstream model measured time in "grid cells x ms per cell". The Gantt
 * edition keeps those fields (so old CSVs, the animation and the exporters keep
 * working) but makes **integer milliseconds the single source of truth**:
 *
 *   startMs / durationMs  -> canonical, always integers in ms
 *   startX / moveCount / duration -> derived mirrors for the legacy grid / CSV
 *
 * `recomputeProject` in stores/useProjectStore.ts is the only writer of the
 * derived fields. Everything else reads.
 */

/** Finish-to-start, start-to-start, finish-to-finish, start-to-finish. */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

/** One "predecessor" edge. `fromId` points at another ModuleData.id. */
export interface Dependency {
  id: string
  fromId: string
  type: DependencyType
  /** Positive = wait longer, negative = overlap. Integer milliseconds. */
  lagMs: number
}

/** How a task's start is decided when it has predecessors. */
export type StartMode = 'auto' | 'manual'

/**
 * Four-level hierarchy, with sub-actions nestable to any depth:
 *   模块 module → 机构 mechanism → 动作 action → 子动作 subaction → ...
 * `module` / `mechanism` rows are summaries: their start/end roll up from all
 * descendants and they are not schedulable themselves. `action` / `subaction`
 * rows are real tasks with their own timing and predecessor edges.
 */
export type TaskKind = 'module' | 'mechanism' | 'action' | 'subaction'

export interface ModuleData {
  id: string
  /** Stable human-readable code used in Excel and dependency labels (T01, T02...). */
  code?: string
  moduleName: string
  actionDescription: string

  // ---- canonical timing (ms, integers) ----
  /** Resolved absolute start measured from the cycle origin (ms). */
  startMs?: number
  /**
   * The user's own start anchor (ms). Kept separately from the resolved
   * `startMs` so removing a dependency or unpinning a task restores the
   * original position instead of freezing the last computed value.
   */
  anchorMs?: number
  /** Length of the action. Always >= 0. */
  durationMs?: number
  /** Derived cache: startMs + durationMs. Written by recomputeProject. */
  endMs?: number
  /**
   * auto   — start is derived from predecessors (or held at the manual anchor
   *          when there are none). Changes upstream cascade here.
   * manual — the user pinned a start; the scheduler still enforces it cannot
   *          begin before its predecessors allow (`max(anchor, constraint)`).
   */
  startMode?: StartMode
  /** Hierarchy parent. Sub-actions may be nested to any depth. */
  parentId?: string | null
  kind?: TaskKind
  /** Incoming dependency edges. Outgoing edges are derived by scanning all rows. */
  predecessors?: Dependency[]

  // ---- legacy fields, kept for CSV + classic grid compatibility ----
  startX: number
  calculatedStartX?: number
  moveCount: number
  duration: number
  stage?: string
  color?: string
  isSequentialAction?: boolean
}

/** Configurable time scale / precision. Stored with the project. */
export interface TimeConfig {
  /**
   * Milliseconds represented by one grid division / ruler tick ("时间刻度").
   * 1 is allowed — that is the millisecond-accurate scale.
   */
  scaleMs: number
  /**
   * Smallest editable and displayable unit ("时间精度"), integer >= 1 ms.
   * All canonical times are snapped to a multiple of this value.
   */
  precisionMs: number
  /** How ruler labels are rendered. */
  displayUnit: 'ms' | 's' | 'min'
}

/** Cell geometry for the Excel sheets ("单元格尺寸可自定义"). */
export interface ExcelLayoutConfig {
  /** Row height in points for the action table. */
  rowHeight: number
  /** Header row height in points. */
  headerHeight: number
  /** Width in characters for each table column, keyed by column key. */
  columnWidths: Record<string, number>
  /** Width in characters of one time-bucket column in the Gantt matrix sheet. */
  matrixCellWidth: number
  /** Row height in points in the Gantt matrix sheet. */
  matrixRowHeight: number
  /** Time span of one matrix column in ms; 0 = derive from scale + column cap. */
  matrixStepMs: number
  /** Font size in points. */
  fontSize: number
}

export interface GanttConfig {
  /** Pixels per millisecond at zoom 1 for the Gantt view. */
  pxPerMs: number
  /** Row height in pixels. */
  rowHeight: number
  /** Show dependency arrows. */
  showDependencies: boolean
  /** Show summary bars for actions that own sub-actions. */
  showSummaries: boolean
}

// Canvas configuration
export interface CanvasConfig {
  cellWidth: number
  cellHeight: number
  showGrid: boolean
  showRuler: boolean
  gridColor: string
  backgroundColor: string
  defaultFillColor: string
}

// Animation state
export interface AnimationState {
  isPlaying: boolean
  currentFrame: number
  speed: number
  totalFrames: number
  loop: boolean
}

// Project data
export interface ProjectData {
  name: string
  modules: ModuleData[]
  canvasConfig: CanvasConfig
  createdAt: string
  updatedAt: string
  version: string
  /** 2 = Gantt edition schema. Missing on projects imported from upstream. */
  schemaVersion?: number
  timeConfig: TimeConfig
  excelLayout: ExcelLayoutConfig
  ganttConfig: GanttConfig
}

// Application state
export interface AppState {
  project: ProjectData | null
  animation: AnimationState
  ui: {
    sidebarCollapsed: boolean
    zoom: number
    language: string
    theme: 'light' | 'dark' | 'auto'
  }
  unsavedChanges: boolean
}
