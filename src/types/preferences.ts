// Preferences configuration types
import { GanttConfig, ProjectFileFormat, TimeConfig } from '@/types'

export interface GridPreferences {
  cellWidth: number
  cellHeight: number
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
}

export interface AnimationPreferences {
  coloringMode: 'gradual' | 'instant' // 'gradual' = 逐漸著色, 'instant' = 瞬間著色然後等待
}

export interface UIPreferences {
  crosshairEnabled: boolean
  canvasTextDisplay: 'module' | 'stage' | 'action'
  panEnabled: boolean
}

export interface FilePreferences {
  /** Format used by Save As and by the first save of a new project. */
  defaultFormat: ProjectFileFormat
}

/** Time-scale dialog values, remembered across sessions and new projects. */
export interface TimeScalePreferences {
  timeConfig: TimeConfig
  ganttConfig: GanttConfig
}

export interface Preferences {
  grid: GridPreferences
  animation: AnimationPreferences
  ui: UIPreferences
  file: FilePreferences
  timeScale: TimeScalePreferences
}

export const DEFAULT_PREFERENCES: Preferences = {
  grid: {
    cellWidth: 20,
    cellHeight: 26,
    minWidth: 5,
    maxWidth: 50,
    minHeight: 12, // Minimum font height
    maxHeight: 60
  },
  animation: {
    coloringMode: 'gradual'
  },
  ui: {
    crosshairEnabled: false,
    canvasTextDisplay: 'action',
    panEnabled: true
  },
  file: {
    // JSON is the recommended default: plain text and the full project model.
    defaultFormat: 'json'
  },
  timeScale: {
    timeConfig: { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' },
    ganttConfig: {
      pxPerMs: 0.35,
      rowHeight: 34,
      showDependencies: true,
      showSummaries: true,
      showModuleSummaryBars: true
    }
  }
}