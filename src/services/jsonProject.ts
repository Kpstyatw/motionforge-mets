import { ProjectData } from '@/types'
import { migrateProject } from '@/stores/useProjectStore'

/**
 * JSON project-file support.
 *
 * The JSON file is the full authoring snapshot: modules, dependencies,
 * resources, allocations, time/cycle settings, Excel and Gantt layouts and
 * canvas config. It is intentionally a plain, pretty-printed envelope so it is
 * easy to inspect or generate from another tool.
 */

export const JSON_PROJECT_FORMAT = 'cycleview-project'
export const JSON_PROJECT_VERSION = 1
/** Extra CSV column carrying the same full snapshot as a .json project file. */
export const PROJECT_META_COLUMN = '__project_json'

export interface JsonProjectFile {
  format: 'cycleview-project'
  formatVersion: number
  exportedAt: string
  project: ProjectData
}

/** Normalise through the same migration path used by in-memory project loads. */
export function normalizeProjectSnapshot(project: ProjectData): ProjectData {
  return migrateProject(project)
}

export function buildProjectJson(project: ProjectData): string {
  const payload: JsonProjectFile = {
    format: JSON_PROJECT_FORMAT,
    formatVersion: JSON_PROJECT_VERSION,
    exportedAt: new Date().toISOString(),
    project: normalizeProjectSnapshot(project)
  }
  return JSON.stringify(payload, null, 2)
}

export interface ParseProjectJsonResult {
  success: boolean
  project?: ProjectData
  error?: string
}

/** Accept both the envelope written by this app and a bare ProjectData object. */
export function parseProjectJson(text: string): ParseProjectJsonResult {
  try {
    const raw = JSON.parse(text) as Partial<JsonProjectFile> & Partial<ProjectData>
    if (!raw || typeof raw !== 'object') {
      return { success: false, error: 'JSON 文件内容不是对象' }
    }
    if (raw.format && raw.format !== JSON_PROJECT_FORMAT) {
      return { success: false, error: `不支持的项目格式：${raw.format}` }
    }
    const candidate = (raw.project ?? raw) as ProjectData
    if (!candidate || !Array.isArray(candidate.modules)) {
      return { success: false, error: 'JSON 缺少 modules 数组' }
    }
    return { success: true, project: normalizeProjectSnapshot(candidate) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
