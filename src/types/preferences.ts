// Preferences configuration types
import { ProjectFileFormat } from '@/types'

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

export interface Preferences {
  grid: GridPreferences
  animation: AnimationPreferences
  ui: UIPreferences
  file: FilePreferences
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
  }
}