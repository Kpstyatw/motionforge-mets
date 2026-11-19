import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { v4 as uuidv4 } from 'uuid'
import {
  CanvasConfig, CycleConfig, Dependency, DependencyType, ExcelLayoutConfig,
  GanttConfig, ModuleData, ProjectData, ProjectFileFormat, Resource, ResourceAllocation,
  RotaryMotion, StartMode, TaskKind, TimeConfig
} from '@/types'
import { useHistoryStore } from './useHistoryStore'
import {
  collectDescendantIds, computeSchedule, normalizeModules,
  renumberHierarchyCodes, syncLegacyFields, wouldCreateCycle
} from '@/lib/dependencyEngine'
import {
  DEFAULT_EXCEL_LAYOUT, DEFAULT_GANTT_CONFIG, DEFAULT_TIME_CONFIG,
  normalizeTimeConfig, quantize
} from '@/lib/timeScale'
import { DEFAULT_CYCLE_CONFIG, expandCycles, normalizeCycleConfig } from '@/lib/cycleEngine'
import {
  checkNewName, formatNameIssue, formatNameIssues, isPhysicalNode,
  NameIssueReason, NameScope, uniqueName
} from '@/lib/nameValidation'
import { canBeParentOf, refreshSubtreeLabels } from '@/lib/hierarchy'

/**
 * Project store — the only writer of resolved timing.
 *
 * Every mutation funnels through `commit()`, which normalises the rows, runs
 * the dependency scheduler, and writes the resolved canonical times (plus the
 * legacy grid mirrors) back onto the modules. That is the invariant which makes
 * "change a predecessor -> every successor moves" work everywhere at once.
 */

export const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  cellWidth: 20,
  cellHeight: 30,
  showGrid: true,
  showRuler: true,
  gridColor: '#e5e5e5',
  backgroundColor: '#ffffff',
  defaultFillColor: '#3b82f6'
}

export const MODULE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#14b8a6', '#f97316', '#ec4899', '#6366f1', '#84cc16'
]

function freshProject(): ProjectData {
  const now = new Date().toISOString()
  return {
    name: 'Untitled Project',
    modules: [],
    resources: [],
    allocations: [],
    canvasConfig: { ...DEFAULT_CANVAS_CONFIG },
    createdAt: now,
    updatedAt: now,
    version: '2.0.0',
    schemaVersion: 2,
    timeConfig: { ...DEFAULT_TIME_CONFIG },
    cycleConfig: { ...DEFAULT_CYCLE_CONFIG },
    excelLayout: { ...DEFAULT_EXCEL_LAYOUT, columnWidths: { ...DEFAULT_EXCEL_LAYOUT.columnWidths } },
    ganttConfig: { ...DEFAULT_GANTT_CONFIG }
  }
}

/** Normalise rotary kinematics: clamp slots, snap step/start, tolerate legacy data. */
export function normalizeRotaryMotion(input: Partial<RotaryMotion> | null | undefined): RotaryMotion | undefined {
  if (!input || input.type !== 'rotary') return undefined
  const slots = Math.min(360, Math.max(1, Math.round(Number(input.slots) || 1)))
  return {
    type: 'rotary',
    slots,
    stepPerCycle: Math.round(Number(input.stepPerCycle) || 0),
    startSlot: Math.max(0, Math.round(Number(input.startSlot) || 0)),
    stationOffset: Math.round(Number(input.stationOffset) || 0)
  }
}

/** Bring an upstream (schema 1) project or CSV-derived data up to schema 2. */
export function migrateProject(input: Partial<ProjectData> & { modules?: ModuleData[] }): ProjectData {
  const base = freshProject()
  const timeConfig = normalizeTimeConfig(input.timeConfig)
  // Recompute display codes from the tree, so legacy T01/T02 projects and
  // imported workbooks immediately gain hierarchy-aware numbering.
  const modules = renumberHierarchyCodes(normalizeModules(input.modules ?? [], timeConfig))
  return {
    ...base,
    ...input,
    version: input.version ?? base.version,
    schemaVersion: 2,
    canvasConfig: { ...base.canvasConfig, ...(input.canvasConfig ?? {}) },
    timeConfig,
    cycleConfig: normalizeCycleConfig(input.cycleConfig),
    excelLayout: {
      ...base.excelLayout,
      ...(input.excelLayout ?? {}),
      columnWidths: { ...base.excelLayout.columnWidths, ...(input.excelLayout?.columnWidths ?? {}) }
    },
    ganttConfig: { ...base.ganttConfig, ...(input.ganttConfig ?? {}) },
    resources: (input.resources ?? []).map(r => ({
      id: r.id || uuidv4(),
      name: r.name || '资源',
      type: r.type,
      color: r.color,
      notes: r.notes,
      parentId: r.parentId,
      slotIndex: r.slotIndex === undefined ? undefined : Math.max(0, Math.round(r.slotIndex)),
      motion: r.motion ? normalizeRotaryMotion(r.motion) : undefined
    })),
    allocations: (input.allocations ?? []).map(a => ({
      id: a.id || uuidv4(),
      taskId: a.taskId,
      resourceId: a.resourceId,
      offsetMs: Math.max(0, Math.round(a.offsetMs || 0)),
      durationMs: Math.max(0, Math.round(a.durationMs || 0)),
      slotMode: (a.slotMode === 'activeSlot' ? 'activeSlot' : a.slotMode) as ResourceAllocation['slotMode'],
      source: a.source,
      notes: a.notes
    })).filter(a => a.taskId && a.resourceId),
    modules: syncLegacyFields(modules, computeSchedule(modules, timeConfig), timeConfig)
  }
}

function nextCode(modules: ModuleData[]): string {
  const used = new Set(modules.map(m => m.code).filter(Boolean))
  let i = 1
  while (used.has(`T${String(i).padStart(2, '0')}`)) i += 1
  return `T${String(i).padStart(2, '0')}`
}

interface TimingPatch {
  startMs?: number
  durationMs?: number
  endMs?: number
}

/** Where the current project came from, so Ctrl+S can write back to it. */
export interface SourceFile {
  /** Absolute path on disk (desktop only); absent for web imports. */
  path?: string
  /** Display name, e.g. "plan.xlsx". */
  name: string
  kind: ProjectFileFormat
}

interface ProjectState {
  project: ProjectData | null
  unsavedChanges: boolean
  /** Diagnostics from the last dependency pass (cycles, dangling edges). */
  scheduleWarnings: string[]
  /** Source workbook/CSV for one-click save-back; cleared on new project. */
  sourceFile: SourceFile | null

  setSourceFile: (source: SourceFile | null) => void
  createNewProject: () => void
  loadProject: (project: Partial<ProjectData>) => void
  updateModules: (modules: ModuleData[], skipHistory?: boolean) => void
  updateModule: (id: string, data: Partial<ModuleData>) => void
  addModule: (module: ModuleData) => void
  removeModule: (id: string) => void
  updateCanvasConfig: (config: Partial<CanvasConfig>) => void
  setUnsavedChanges: (value: boolean) => void
  clearProject: () => void

  // ---- Gantt edition ----
  setTimeConfig: (config: Partial<TimeConfig>) => void
  setCycleConfig: (config: Partial<CycleConfig>) => void
  setExcelLayout: (config: Partial<ExcelLayoutConfig>) => void
  setGanttConfig: (config: Partial<GanttConfig>) => void
  setTaskTiming: (id: string, patch: TimingPatch) => void
  setStartMode: (id: string, mode: StartMode) => void
  addPredecessor: (taskId: string, fromId: string, type?: DependencyType, lagMs?: number) => boolean
  updatePredecessor: (taskId: string, depId: string, patch: Partial<Dependency>) => boolean
  removePredecessor: (taskId: string, depId: string) => void
  addAction: (options?: { parentId?: string | null; kind?: TaskKind; moduleName?: string; actionDescription?: string; durationMs?: number; startMs?: number }) => string | null
  deleteTask: (id: string) => void
  /** Returns false when a name change was rejected (duplicate or empty). */
  setTaskField: (id: string, field: 'moduleName' | 'actionDescription' | 'stage' | 'color', value: string) => boolean
  /** Move a node in the 模块→机构→动作 tree; null makes a top-level module. */
  setTaskParent: (id: string, parentId: string | null) => boolean
  /** Set a node's colour; optionally push it to every descendant node. */
  setTaskColor: (id: string, color: string, applyToDescendants?: boolean) => void
  recompute: () => void

  // ---- Resource allocation edition ----
  /** Returns '' when the requested name is empty or already taken. */
  addResource: (resource?: Partial<Resource>) => string
  /** Returns false when the new name is empty or already taken. */
  updateResource: (id: string, patch: Partial<Resource>) => boolean
  removeResource: (id: string) => void
  /** Map a physical mechanism node to an abstract resource ('' clears it). */
  linkMechanismResource: (moduleId: string, resourceId: string | null) => void
  /** Set rotary kinematics on a parent resource; null removes them. */
  setResourceMotion: (resourceId: string, motion: Partial<RotaryMotion> | null) => void
  /** Add a child slot resource under a parent (e.g. a wash-plate hole). */
  addChildResource: (parentId: string, name?: string, slotIndex?: number) => string | null
  addAllocation: (allocation: Omit<ResourceAllocation, 'id'>) => string | null
  updateAllocation: (id: string, patch: Partial<ResourceAllocation>) => void
  removeAllocation: (id: string) => void
}

interface CommitState {
  project: ProjectData | null
  unsavedChanges: boolean
  scheduleWarnings: string[]
}

/** A rejected name edit must say why — silent no-ops read like a broken UI. */
function nameWarning(scope: NameScope, name: string, reason: NameIssueReason): string {
  return formatNameIssue({ scope, id: '', name, reason })
}

/** Recompute the whole schedule and write the resolved values back. */
function resolveProject(project: ProjectData): string[] {
  const timeConfig = normalizeTimeConfig(project.timeConfig)
  // Codes are a presentation of the current tree, not a stable identity;
  // dependencies use ids. Renumber on every commit so add/delete/insert
  // keeps the visible path consistent with parentCode and Excel references.
  const normalized = normalizeModules(renumberHierarchyCodes(project.modules), timeConfig)
  const schedule = computeSchedule(normalized, timeConfig)
  project.modules = syncLegacyFields(normalized, schedule, timeConfig) as typeof project.modules
  project.timeConfig = timeConfig
  project.cycleConfig = normalizeCycleConfig(project.cycleConfig)
  project.cycleConfig.cycleMs = Math.max(timeConfig.precisionMs, project.cycleConfig.cycleMs)
  const cycleWarnings = expandCycles(
    project.modules, project.allocations, project.cycleConfig, timeConfig.precisionMs
  ).warnings
  project.updatedAt = new Date().toISOString()
  return [...schedule.warnings, ...cycleWarnings, ...formatNameIssues(project)]
}

/** Commit a new module list with history + full cascade recompute. */
function commit(
  state: CommitState,
  modules: ModuleData[],
  skipHistory = false
) {
  if (!state.project) return
  const before = state.project.modules
  if (!skipHistory) {
    const history = useHistoryStore.getState()
    if (history.history.length === 0) history.pushState(before as ModuleData[])
  }
  state.project.modules = modules as typeof state.project.modules
  state.scheduleWarnings = resolveProject(state.project)
  state.unsavedChanges = true
  if (!skipHistory) {
    useHistoryStore.getState().pushState(state.project.modules as ModuleData[])
  }
}

export const useProjectStore = create<ProjectState>()(
  immer((set, get) => ({
  project: null,
  unsavedChanges: false,
  scheduleWarnings: [],
  sourceFile: null,

  setSourceFile: source => set(state => { state.sourceFile = source }),

  createNewProject: () => set(state => {
    state.project = freshProject()
    state.unsavedChanges = false
    state.scheduleWarnings = []
    state.sourceFile = null
    useHistoryStore.getState().clearHistory()
  }),

  loadProject: project => set(state => {
    const migrated = migrateProject(project)
    state.project = migrated
    state.unsavedChanges = false
    // Imported duplicates stay visible and editable, but save() will refuse
    // the project until they are resolved.
    state.scheduleWarnings = formatNameIssues(migrated)
    // sourceFile is owned by the import/save flow, not by project data, so a
    // reload (e.g. Excel import) keeps the association until explicitly changed.
    useHistoryStore.getState().clearHistory()
  }),

    updateModules: (modules, skipHistory = false) => set(state => {
      commit(state, modules, skipHistory)
    }),

    updateModule: (id, data) => set(state => {
      if (!state.project) return
      const next = state.project.modules.map(m => (m.id === id ? { ...m, ...data } : m))
      commit(state, next)
    }),

    addModule: module => set(state => {
      if (!state.project) return
      commit(state, [...state.project.modules, module])
    }),

    removeModule: id => set(state => {
      if (!state.project) return
      commit(state, state.project.modules.filter(m => m.id !== id))
    }),

    updateCanvasConfig: config => set(state => {
      if (!state.project) return
      Object.assign(state.project.canvasConfig, config)
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    setUnsavedChanges: value => set(state => { state.unsavedChanges = value }),

    clearProject: () => set(state => {
      state.project = null
      state.unsavedChanges = false
      state.scheduleWarnings = []
      state.sourceFile = null
    }),

    setTimeConfig: config => set(state => {
      if (!state.project) return
      state.project.timeConfig = normalizeTimeConfig({ ...state.project.timeConfig, ...config })
      state.scheduleWarnings = resolveProject(state.project)
      state.unsavedChanges = true
    }),

    setCycleConfig: config => set(state => {
      if (!state.project) return
      state.project.cycleConfig = normalizeCycleConfig({ ...state.project.cycleConfig, ...config })
      state.scheduleWarnings = resolveProject(state.project)
      state.unsavedChanges = true
    }),

    setExcelLayout: config => set(state => {
      if (!state.project) return
      Object.assign(state.project.excelLayout, config)
      if (config.columnWidths) {
        state.project.excelLayout.columnWidths = {
          ...state.project.excelLayout.columnWidths,
          ...config.columnWidths
        }
      }
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    setGanttConfig: config => set(state => {
      if (!state.project) return
      Object.assign(state.project.ganttConfig, config)
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    setTaskTiming: (id, patch) => set(state => {
      if (!state.project) return
      const cfg = normalizeTimeConfig(state.project.timeConfig)
      const current = state.project.modules.find(m => m.id === id)
      if (!current) return
      const start = current.startMs ?? 0
      let durationMs = current.durationMs ?? current.moveCount * current.duration
      if (patch.durationMs !== undefined) {
        durationMs = Math.max(0, quantize(patch.durationMs, cfg.precisionMs, 'round'))
      } else if (patch.endMs !== undefined) {
        durationMs = Math.max(0, quantize(patch.endMs - start, cfg.precisionMs, 'round'))
      }
      const hasPredecessors = (current.predecessors?.length ?? 0) > 0
      const startMode: StartMode = patch.startMs !== undefined && hasPredecessors
        ? 'manual'
        : (current.startMode ?? 'auto')
      const startMs = patch.startMs !== undefined
        ? Math.max(0, quantize(patch.startMs, cfg.precisionMs, 'round'))
        : start
      const next = state.project.modules.map(m => m.id === id
        ? {
            ...m,
            startMs,
            anchorMs: patch.startMs !== undefined ? startMs : (m.anchorMs ?? m.startMs),
            durationMs,
            startMode
          }
        : m)
      commit(state, next)
    }),

    setStartMode: (id, mode) => set(state => {
      if (!state.project) return
      const next = state.project.modules.map(m => m.id === id ? { ...m, startMode: mode } : m)
      commit(state, next)
    }),

    addPredecessor: (taskId, fromId, type = 'FS', lagMs = 0) => {
      const project = get().project
      if (!project) return false
      const target = project.modules.find(m => m.id === taskId)
      if (!target || target.predecessors?.some(d => d.fromId === fromId)) return false
      if (wouldCreateCycle(project.modules, taskId, fromId)) {
        set(state => { state.scheduleWarnings = ['添加前置任务会形成循环依赖，已阻止'] })
        return false
      }
      set(state => {
        if (!state.project) return
        const next = state.project.modules.map(m => m.id === taskId
          ? {
              ...m,
              // Adding a predecessor is an explicit request to let dependencies
              // drive this task's start. A previously pinned (manual) start
              // would silently swallow every dependency change, which reads as
              // "editing the predecessor did nothing". Restore auto-follow.
              startMode: 'auto' as StartMode,
              predecessors: [
                ...(m.predecessors ?? []),
                { id: uuidv4(), fromId, type, lagMs: Math.round(lagMs) }
              ]
            }
          : m)
        commit(state, next as ModuleData[])
      })
      return true
    },

    updatePredecessor: (taskId, depId, patch) => {
      const project = get().project
      if (!project) return false
      if (patch.fromId && wouldCreateCycle(project.modules, taskId, patch.fromId)) {
        set(state => { state.scheduleWarnings = ['修改前置任务会形成循环依赖，已阻止'] })
        return false
      }
      set(state => {
        if (!state.project) return
        const next = state.project.modules.map(m => m.id === taskId
          ? {
              ...m,
              // Editing a dependency (type / lag) must take effect on the
              // successor's start time. A pinned manual anchor would hide it.
              startMode: 'auto' as StartMode,
              predecessors: (m.predecessors ?? []).map(d =>
                d.id === depId ? { ...d, ...patch, lagMs: patch.lagMs !== undefined ? Math.round(patch.lagMs) : d.lagMs } : d)
            }
          : m)
        commit(state, next as ModuleData[])
      })
      return true
    },

    removePredecessor: (taskId, depId) => set(state => {
      if (!state.project) return
      const next = state.project.modules.map(m => m.id === taskId
        ? { ...m, predecessors: (m.predecessors ?? []).filter(d => d.id !== depId) }
        : m)
      commit(state, next as ModuleData[])
    }),

    addAction: options => {
      const project = get().project
      if (!project) return null
      const cfg = normalizeTimeConfig(project.timeConfig)
      const kind = options?.kind ?? 'action'
      const isSummary = kind === 'module' || kind === 'mechanism'
      const working = [...project.modules]

      // Auto-create the required ancestors so a brand new project always has
      // a valid 模块 → 机构 → 动作 chain.
      let parentId = options?.parentId ?? null
      const newNode = (k: TaskKind, name: string, parent: string | null): ModuleData => ({
        id: uuidv4(),
        code: nextCode(working),
        kind: k,
        parentId: parent,
        moduleName: name,
        actionDescription: name,
        stage: undefined,
        color: MODULE_COLORS[new Set(working.map(m => m.moduleName)).size % MODULE_COLORS.length],
        startMs: 0,
        anchorMs: 0,
        durationMs: 0,
        endMs: 0,
        startMode: 'auto',
        predecessors: [],
        startX: 0,
        calculatedStartX: 0,
        moveCount: 0,
        duration: cfg.scaleMs,
        isSequentialAction: false
      })
      const push = (node: ModuleData) => {
        const at = node.parentId
          ? (() => {
              const descendants = collectDescendantIds(working, node.parentId!)
              const indices = [working.findIndex(m => m.id === node.parentId),
                ...descendants.map(id => working.findIndex(m => m.id === id))]
              return Math.max(...indices) + 1
            })()
          : working.length
        working.splice(at, 0, node)
        return node.id
      }
      if (kind === 'mechanism' && !working.some(m => m.id === parentId && m.kind === 'module')) {
        const existing = working.find(m => m.kind === 'module')
        parentId = existing?.id ?? push(newNode(
          'module', uniqueName({ ...project, modules: working }, 'node', '整机循环'), null
        ))
      }
      if ((kind === 'action' || kind === 'subaction') && !parentId) {
        const module = working.find(m => m.kind === 'module')
        const moduleId = module?.id ?? push(newNode(
          'module', uniqueName({ ...project, modules: working }, 'node', '整机循环'), null
        ))
        const mechanism = working.find(m => m.kind === 'mechanism' && m.parentId === moduleId)
        const mechanismId = mechanism?.id ?? push(newNode(
          'mechanism', uniqueName({ ...project, modules: working }, 'node', '机构 1'), moduleId
        ))
        parentId = mechanismId
      }

      const parent = parentId ? working.find(m => m.id === parentId) : undefined
      // Nearest mechanism ancestor gives the display group + colour, and the
      // nearest module ancestor gives the stage label.
      let mechanismName = parent?.moduleName ?? options?.moduleName ?? 'New Module'
      let stage: string | undefined
      let color = parent?.color
      let cursor = parent
      const guard = new Set<string>()
      while (cursor && !guard.has(cursor.id)) {
        guard.add(cursor.id)
        if (cursor.kind === 'mechanism') { mechanismName = cursor.moduleName; color = cursor.color }
        if (cursor.kind === 'module') stage = cursor.moduleName
        const nextId = cursor.parentId
        cursor = nextId ? working.find(m => m.id === nextId) : undefined
      }
      color = color ?? MODULE_COLORS[new Set(working.map(m => m.moduleName)).size % MODULE_COLORS.length]

      const startMs = Math.max(0, quantize(options?.startMs ?? parent?.startMs ?? 0, cfg.precisionMs, 'round'))
      const durationMs = isSummary ? 0 : quantize(options?.durationMs ?? cfg.scaleMs * 10, cfg.precisionMs, 'ceil')
      const displayName = options?.actionDescription
        ?? (kind === 'module' ? '新模块' : kind === 'mechanism' ? '新机构' : kind === 'subaction' ? '新子动作' : '新动作')
      // A module/mechanism name is an identity, not a label: reject clashes
      // instead of creating two nodes that Excel / resources cannot tell apart.
      const explicitName = options?.moduleName?.trim() || options?.actionDescription?.trim()
      const authoredName = explicitName
        ?? (isSummary ? uniqueName({ ...project, modules: working }, 'node', displayName) : displayName)
      if (isSummary) {
        const verdict = checkNewName({ ...project, modules: working }, 'node', authoredName)
        if (!verdict.ok) {
          set(state => {
            state.scheduleWarnings = [nameWarning('node', authoredName, verdict.reason ?? 'duplicate')]
          })
          return null
        }
      }
      const created: ModuleData = {
        id: uuidv4(),
        code: nextCode(working),
        kind,
        parentId,
        moduleName: isSummary ? authoredName : mechanismName,
        actionDescription: isSummary ? authoredName : displayName,
        stage,
        color,
        startMs,
        anchorMs: startMs,
        durationMs,
        endMs: startMs + durationMs,
        startMode: 'auto',
        predecessors: [],
        startX: startMs / cfg.scaleMs,
        calculatedStartX: startMs / cfg.scaleMs,
        moveCount: durationMs / cfg.scaleMs,
        duration: cfg.scaleMs,
        isSequentialAction: false
      }
      const descendants = parentId ? collectDescendantIds(working, parentId) : []
      const lastIndex = parentId
        ? Math.max(working.findIndex(m => m.id === parentId),
            ...descendants.map(id => working.findIndex(m => m.id === id)))
        : -1
      const insertAt = lastIndex < 0 ? working.length : lastIndex + 1
      working.splice(insertAt, 0, created)
      set(state => { commit(state, working) })
      return created.id
    },

    deleteTask: id => set(state => {
      if (!state.project) return
      const removed = new Set([id, ...collectDescendantIds(state.project.modules, id)])
      const next = state.project.modules
        .filter(m => !removed.has(m.id))
        .map(m => ({
          ...m,
          parentId: m.parentId && removed.has(m.parentId) ? null : m.parentId,
          predecessors: (m.predecessors ?? []).filter(d => !removed.has(d.fromId))
        }))
      commit(state, next as ModuleData[])
      // Drop every allocation that referenced a deleted action/subaction.
      state.project.allocations = state.project.allocations.filter(a => !removed.has(a.taskId))
      state.unsavedChanges = true
    }),

    setTaskField: (id, field, value) => {
      const project = get().project
      if (!project) return false
      const node = project.modules.find(m => m.id === id)
      if (!node) return false
      const trimmed = value.trim()
      const isNameField = field === 'actionDescription' || field === 'moduleName'
      if (isNameField && isPhysicalNode(node)) {
        const verdict = checkNewName(project, 'node', trimmed, id)
        if (!verdict.ok) {
          set(state => {
            state.scheduleWarnings = [nameWarning('node', trimmed, verdict.reason ?? 'duplicate')]
          })
          return false
        }
      }
      set(state => {
        if (!state.project) return
        const next = state.project.modules.map(m => {
          if (m.id !== id) return m
          // A summary node's visible name and its Excel 模块/机构 column are
          // two mirrors of one physical name; keep them in lockstep.
          if (isNameField && isPhysicalNode(m)) {
            return { ...m, moduleName: trimmed, actionDescription: trimmed }
          }
          return { ...m, [field]: value }
        })
        commit(state, next as ModuleData[])
      })
      return true
    },

    setTaskParent: (id, parentId) => {
      const project = get().project
      if (!project) return false
      const node = project.modules.find(m => m.id === id)
      if (!node) return false
      const parent = parentId ? project.modules.find(m => m.id === parentId) : undefined
      if (parentId && !parent) return false
      const reject = (message: string) => {
        set(state => { state.scheduleWarnings = [message] })
        return false
      }
      if (parentId === id || collectDescendantIds(project.modules, id).includes(parentId ?? '')) {
        return reject('不能把节点移动到自己的下级')
      }
      if (!canBeParentOf(node.kind, parent?.kind)) {
        return reject('该节点不能作为此任务的上级')
      }
      if ((node.parentId ?? null) === (parentId ?? null)) return true
      set(state => {
        if (!state.project) return
        const moved = state.project.modules.map(m =>
          m.id === id ? { ...m, parentId: parentId ?? null } : m
        )
        commit(state, refreshSubtreeLabels(moved as ModuleData[], id) as ModuleData[])
      })
      return true
    },

    setTaskColor: (id, color, applyToDescendants = false) => set(state => {
      if (!state.project) return
      // Accept native picker values and the 6-digit form used by Excel.
      const normalized = color.startsWith('#') ? color : `#${color.replace(/^#/, '')}`
      const targets = new Set([id, ...(applyToDescendants ? collectDescendantIds(state.project.modules, id) : [])])
      const next = state.project.modules.map(m => targets.has(m.id) ? { ...m, color: normalized } : m)
      commit(state, next)
    }),

    recompute: () => set(state => {
      if (!state.project) return
      state.scheduleWarnings = resolveProject(state.project)
    }),

    addResource: (resource) => {
      const project = get().project
      if (!project) return ''
      const explicit = resource?.name?.trim()
      if (explicit) {
        const verdict = checkNewName(project, 'resource', explicit)
        if (!verdict.ok) {
          set(state => {
            state.scheduleWarnings = [nameWarning('resource', explicit, verdict.reason ?? 'duplicate')]
          })
          return ''
        }
      }
      const id = uuidv4()
      set(state => {
        if (!state.project) return
        state.project.resources.push({
          id,
          name: explicit ?? uniqueName(project, 'resource', '新资源'),
          type: resource?.type,
          color: resource?.color,
          notes: resource?.notes,
          parentId: resource?.parentId,
          slotIndex: resource?.slotIndex,
          motion: resource?.motion ? normalizeRotaryMotion(resource.motion) : undefined
        })
        state.project.updatedAt = new Date().toISOString()
        state.unsavedChanges = true
      })
      return id
    },

    updateResource: (id, patch) => {
      const project = get().project
      if (!project) return false
      const r = project.resources.find(x => x.id === id)
      if (!r) return false
      let nextPatch = patch
      if (patch.name !== undefined) {
        const trimmed = patch.name.trim()
        const verdict = checkNewName(project, 'resource', trimmed, id)
        if (!verdict.ok) {
          set(state => {
            state.scheduleWarnings = [nameWarning('resource', trimmed, verdict.reason ?? 'duplicate')]
          })
          return false
        }
        nextPatch = { ...patch, name: trimmed }
      }
      set(state => {
        if (!state.project) return
        const target = state.project.resources.find(x => x.id === id)
        if (!target) return
        Object.assign(target, nextPatch)
        state.project.updatedAt = new Date().toISOString()
        state.unsavedChanges = true
      })
      return true
    },

    removeResource: id => set(state => {
      if (!state.project) return
      const childIds = new Set(state.project.resources.filter(r => r.parentId === id).map(r => r.id))
      state.project.resources = state.project.resources.filter(r => r.id !== id && !childIds.has(r.id))
      state.project.allocations = state.project.allocations.filter(
        a => a.resourceId !== id && !childIds.has(a.resourceId)
      )
      // Unmap any mechanism that pointed at the removed resource (or its slots).
      state.project.modules.forEach(m => {
        if (m.resourceId && (m.resourceId === id || childIds.has(m.resourceId))) m.resourceId = undefined
      })
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    linkMechanismResource: (moduleId, resourceId) => set(state => {
      if (!state.project) return
      const node = state.project.modules.find(m => m.id === moduleId)
      if (!node || node.kind !== 'mechanism') return
      node.resourceId = resourceId ?? undefined
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    setResourceMotion: (resourceId, motion) => set(state => {
      if (!state.project) return
      const r = state.project.resources.find(x => x.id === resourceId)
      if (!r) return
      r.motion = motion ? normalizeRotaryMotion(motion) : undefined
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    addChildResource: (parentId, name, slotIndex) => {
      const project = get().project
      if (!project) return null
      const parent = project.resources.find(r => r.id === parentId)
      if (!parent) return null
      const id = uuidv4()
      const used = new Set(project.resources.filter(r => r.parentId === parentId).map(r => r.slotIndex))
      let index = slotIndex
      if (index === undefined) {
        index = 0
        while (used.has(index)) index++
      }
      set(state => {
        if (!state.project) return
        state.project.resources.push({
          id,
          name: uniqueName(project, 'resource', name?.trim() || `${parent.name} · 槽${index + 1}`),
          type: parent.type ? `${parent.type}-slot` : 'slot',
          color: parent.color,
          parentId,
          slotIndex: index
        })
        state.project.updatedAt = new Date().toISOString()
        state.unsavedChanges = true
      })
      return id
    },

    addAllocation: allocation => {
      const project = get().project
      if (!project) return null
      if (allocation.durationMs <= 0) return null
      if (!project.modules.some(m => m.id === allocation.taskId)) return null
      if (!project.resources.some(r => r.id === allocation.resourceId)) return null
      const id = uuidv4()
      set(state => {
        if (!state.project) return
        const cfg = normalizeTimeConfig(state.project.timeConfig)
        state.project.allocations.push({
          ...allocation,
          id,
          offsetMs: Math.max(0, quantize(allocation.offsetMs, cfg.precisionMs, 'round')),
          durationMs: Math.max(0, quantize(allocation.durationMs, cfg.precisionMs, 'round'))
        })
        state.project.updatedAt = new Date().toISOString()
        state.unsavedChanges = true
      })
      return id
    },

    updateAllocation: (id, patch) => set(state => {
      if (!state.project) return
      const a = state.project.allocations.find(x => x.id === id)
      if (!a) return
      const cfg = normalizeTimeConfig(state.project.timeConfig)
      if (patch.offsetMs !== undefined) a.offsetMs = Math.max(0, quantize(patch.offsetMs, cfg.precisionMs, 'round'))
      if (patch.durationMs !== undefined) a.durationMs = Math.max(0, quantize(patch.durationMs, cfg.precisionMs, 'round'))
      if (patch.resourceId !== undefined) a.resourceId = patch.resourceId
      if (patch.notes !== undefined) a.notes = patch.notes
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    removeAllocation: id => set(state => {
      if (!state.project) return
      state.project.allocations = state.project.allocations.filter(a => a.id !== id)
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    })
  }))
)
