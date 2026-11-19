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
  /**
   * When this row is a mechanism summary, the global resource it represents.
   * Its descendant actions then automatically claim that resource for their
   * own execution windows — no manual ResourceAllocation required.
   */
  resourceId?: string
  /** Incoming dependency edges. Outgoing edges are derived by scanning all rows. */
  predecessors?: Dependency[]

  // ---- cycle instance projection (derived, never authored) ----
  /** 1..N when this row is a generated cycle instance; absent on the template. */
  cycleIndex?: number
  /** Template row id when this row is a generated cycle instance. */
  cycleTemplateId?: string

  // ---- legacy fields, kept for CSV + classic grid compatibility ----
  startX: number
  calculatedStartX?: number
  moveCount: number
  duration: number
  stage?: string
  color?: string
  isSequentialAction?: boolean
}

/**
 * A physical resource shared across flows: a mechanism / motor / actuator such
 * as 管库抓手, 样本臂, 加样针. Resources live in a global table — they are NOT
 * nodes in the flow hierarchy — so one resource is defined once and referenced
 * by many actions in many flows. This is what removes the duplicate-editing
 * problem of a resource-centric tree.
 */
/** Rotary kinematics for a parent resource whose child slots orbit a fixed station. */
export interface RotaryMotion {
  type: 'rotary'
  /** Number of child slots around the disc (e.g. 8 holes on a wash plate). */
  slots: number
  /** Slot index advanced per cycle; negative reverses direction, 0 = no rotation. */
  stepPerCycle: number
  /** Slot index aligned to the station in cycle 1 (0-based). Default 0. */
  startSlot?: number
  /** Angular offset of an extra fixed station, in slot steps. Default 0. */
  stationOffset?: number
}

export interface Resource {
  id: string
  name: string
  /** Free-form category: gripper / arm / needle / motor / incubator ... */
  type?: string
  color?: string
  notes?: string
  /** Parent resource id; children form a tree (wash plate → holes). */
  parentId?: string
  /** 0-based slot identity on a rotary parent; stable while the disc spins. */
  slotIndex?: number
  /** Present on a rotary parent; children inherit its phase. */
  motion?: RotaryMotion
}

/**
 * A claim by one action on one resource, with an exact time window.
 * `offsetMs` is relative to the owning action's resolved start, and `durationMs`
 * is the length of the claim — so when the dependency engine cascades the
 * action to a new start, every claim on it moves with it automatically.
 * Absolute window = [task.startMs + offsetMs, task.startMs + offsetMs + durationMs).
 *
 * This is the "关系" entity of the many-to-many relation: one action may hold
 * several allocations (gripper + arm + needle cooperating), and one resource
 * may be claimed by many actions across different flows.
 */
export interface ResourceAllocation {
  id: string
  taskId: string
  resourceId: string
  /** Offset from the owning action's start, integer ms, >= 0. */
  offsetMs: number
  /** Length of the claim, integer ms, >= 0. */
  durationMs: number
  /**
   * fixed  — claim the resourceId itself (default, legacy behaviour).
   * activeSlot — when resourceId is a rotary parent, resolve to the child slot
   * selected by the phase function for the owning action's cycle, then claim
   * that slot id. Falls back to the parent when no child matches.
   */
  slotMode?: 'fixed' | 'activeSlot'
  /**
   * Where the claim originates. Authored claims omit this (= 'manual');
   * derived claims are synthesised in the view layer, never stored back:
   *   mechanism — from a mechanism node's resourceId binding
   *   material  — future phase: from material in/out state changes
   */
  source?: 'manual' | 'mechanism' | 'material'
  notes?: string
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

/** Fixed-period repetition. The template is authored once and projected N times. */
export interface CycleConfig {
  /** false / repeats=1 → single-cycle view; true → multi-cycle projection. */
  enabled: boolean
  /** Length of one cycle in integer milliseconds. */
  cycleMs: number
  /** Number of cycles to project, 1..50. */
  repeats: number
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
  /** Merge every N time-tick columns in the matrix header into one labelled cell; 0 = no merge. */
  matrixLabelEvery: number
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

/** Full-project file formats supported by Save / Save As. */
export type ProjectFileFormat = 'json' | 'xlsx' | 'csv'

// Project data
export interface ProjectData {
  name: string
  modules: ModuleData[]
  /** Global resource catalogue (mechanisms / motors / actuators). */
  resources: Resource[]
  /** Exact-window claims linking actions to resources. */
  allocations: ResourceAllocation[]
  canvasConfig: CanvasConfig
  createdAt: string
  updatedAt: string
  version: string
  /** 2 = Gantt edition schema. Missing on projects imported from upstream. */
  schemaVersion?: number
  timeConfig: TimeConfig
  /** Fixed-cycle repetition; absent means single-cycle (legacy projects). */
  cycleConfig?: CycleConfig
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
