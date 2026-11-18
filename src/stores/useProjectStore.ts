import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { v4 as uuidv4 } from 'uuid'
import {
  CanvasConfig, CycleConfig, Dependency, DependencyType, ExcelLayoutConfig,
  GanttConfig, ModuleData, ProjectData, Resource, ResourceAllocation,
  StartMode, TaskKind, TimeConfig
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

/**
 * Project store — the only writer of resolved timing.
 *
 * Every mutation funnels through `commit()`, which normalises the rows, runs
 * the dependency scheduler, and writes the resolved canonical times (plus the
 * legacy grid mirrors) back onto the modules. That is the invariant which makes
 * "change a predecessor -> every successor moves" work everywhere at once.
 */

const defaultCanvasConfig: CanvasConfig = {
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
    canvasConfig: { ...defaultCanvasConfig },
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
      notes: r.notes
    })),
    allocations: (input.allocations ?? []).map(a => ({
      id: a.id || uuidv4(),
      taskId: a.taskId,
      resourceId: a.resourceId,
      offsetMs: Math.max(0, Math.round(a.offsetMs || 0)),
      durationMs: Math.max(0, Math.round(a.durationMs || 0)),
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

interface ProjectState {
  project: ProjectData | null
  unsavedChanges: boolean
  /** Diagnostics from the last dependency pass (cycles, dangling edges). */
  scheduleWarnings: string[]

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
  setTaskField: (id: string, field: 'moduleName' | 'actionDescription' | 'stage' | 'color', value: string) => void
  /** Set a node's colour; optionally push it to every descendant node. */
  setTaskColor: (id: string, color: string, applyToDescendants?: boolean) => void
  recompute: () => void

  // ---- Resource allocation edition ----
  addResource: (resource?: Partial<Resource>) => string
  updateResource: (id: string, patch: Partial<Resource>) => void
  removeResource: (id: string) => void
  addAllocation: (allocation: Omit<ResourceAllocation, 'id'>) => string | null
  updateAllocation: (id: string, patch: Partial<ResourceAllocation>) => void
  removeAllocation: (id: string) => void
}

interface CommitState {
  project: ProjectData | null
  unsavedChanges: boolean
  scheduleWarnings: string[]
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
  return [...schedule.warnings, ...cycleWarnings]
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

    createNewProject: () => set(state => {
      state.project = freshProject()
      state.unsavedChanges = false
      state.scheduleWarnings = []
      useHistoryStore.getState().clearHistory()
    }),

    loadProject: project => set(state => {
      state.project = migrateProject(project)
      state.unsavedChanges = false
      state.scheduleWarnings = []
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
        parentId = existing?.id ?? push(newNode('module', '整机循环', null))
      }
      if ((kind === 'action' || kind === 'subaction') && !parentId) {
        const module = working.find(m => m.kind === 'module')
        const moduleId = module?.id ?? push(newNode('module', '整机循环', null))
        const mechanism = working.find(m => m.kind === 'mechanism' && m.parentId === moduleId)
        const mechanismId = mechanism?.id ?? push(newNode('mechanism', '机构 1', moduleId))
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
      const created: ModuleData = {
        id: uuidv4(),
        code: nextCode(working),
        kind,
        parentId,
        moduleName: isSummary ? (options?.moduleName ?? displayName) : mechanismName,
        actionDescription: displayName,
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

    setTaskField: (id, field, value) => set(state => {
      if (!state.project) return
      const next = state.project.modules.map(m => m.id === id ? { ...m, [field]: value } : m)
      commit(state, next)
    }),

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
      const id = uuidv4()
      set(state => {
        if (!state.project) return
        state.project.resources.push({
          id,
          name: resource?.name ?? '新资源',
          type: resource?.type,
          color: resource?.color,
          notes: resource?.notes
        })
        state.project.updatedAt = new Date().toISOString()
        state.unsavedChanges = true
      })
      return id
    },

    updateResource: (id, patch) => set(state => {
      if (!state.project) return
      const r = state.project.resources.find(x => x.id === id)
      if (!r) return
      Object.assign(r, patch)
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

    removeResource: id => set(state => {
      if (!state.project) return
      state.project.resources = state.project.resources.filter(r => r.id !== id)
      state.project.allocations = state.project.allocations.filter(a => a.resourceId !== id)
      state.project.updatedAt = new Date().toISOString()
      state.unsavedChanges = true
    }),

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
