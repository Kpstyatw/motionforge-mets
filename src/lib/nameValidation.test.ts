import { describe, expect, it } from 'vitest'
import { ProjectData, Resource, TaskKind } from '@/types'
import {
  checkNewName, findNameIssues, formatNameIssues, isNameAvailable,
  nameIssueKey, uniqueName
} from './nameValidation'

function node(id: string, name: string, kind: TaskKind = 'action') {
  return { id, moduleName: name, actionDescription: name, kind } as ProjectData['modules'][number]
}

function resource(id: string, name: string, parentId?: string): Resource {
  return { id, name, parentId }
}

function project(modules: ProjectData['modules'], resources: Resource[] = []): ProjectData {
  return {
    name: 't',
    modules,
    resources,
    allocations: [],
    canvasConfig: {} as ProjectData['canvasConfig'],
    createdAt: '',
    updatedAt: '',
    version: '2.0.0',
    schemaVersion: 2,
    timeConfig: { scaleMs: 1, precisionMs: 1, displayUnit: 'ms' },
    cycleConfig: {} as ProjectData['cycleConfig'],
    excelLayout: {} as ProjectData['excelLayout'],
    ganttConfig: {} as ProjectData['ganttConfig']
  }
}

describe('name uniqueness', () => {
  it('flags duplicate physical module/mechanism names but not repeated action labels', () => {
    const p = project([
      node('m1', '进样模块', 'module'),
      node('k1', '抓手', 'mechanism'),
      node('k2', '抓手', 'mechanism'),
      node('a1', '抓取'),
      node('a2', '抓取'),
      node('a3', '进样模块', 'subaction')
    ])
    const issues = findNameIssues(p)
    expect(issues.filter(i => i.scope === 'node').map(i => i.id)).toEqual(['k1', 'k2'])
    expect(issues.every(i => i.kind !== 'action' && i.kind !== 'subaction')).toBe(true)
  })

  it('treats module names case-insensitively and ignores surrounding space', () => {
    const p = project([node('m1', 'Feeder', 'module'), node('m2', ' feeder ', 'mechanism')])
    expect(findNameIssues(p)).toHaveLength(2)
    expect(isNameAvailable(p, 'node', 'FEEDER', 'm2')).toBe(false)
    expect(isNameAvailable(p, 'node', 'FEEDER', 'm1')).toBe(false)
    expect(isNameAvailable(p, 'node', 'Feeder 2')).toBe(true)
  })

  it('flags duplicate resources including child slots, but allows mechanism/resource same name', () => {
    const p = project(
      [node('k1', '管库抓手', 'mechanism')],
      [resource('r1', '管库抓手'), resource('r2', '清洗盘'), resource('r3', '清洗盘', 'r2')]
    )
    expect(findNameIssues(p).map(i => i.scope)).toEqual(['resource', 'resource'])
    expect(findNameIssues(p).map(i => i.id)).toEqual(['r2', 'r3'])
    expect(checkNewName(p, 'resource', '清洗盘').reason).toBe('duplicate')
  })

  it('reports empty names and matches them to the right i18n key', () => {
    const p = project([node('m1', '', 'module')], [resource('r1', '   ')])
    const issues = findNameIssues(p)
    expect(issues).toHaveLength(2)
    expect(issues.map(nameIssueKey)).toEqual(['nameIssue.emptyNode', 'nameIssue.emptyResource'])
    expect(formatNameIssues(p)).toEqual(['模块/机构名称不能为空', '资源名称不能为空'])
  })

  it('generates a unique default without colliding with an existing name', () => {
    const p = project(
      [node('m1', '整机循环', 'module')],
      [resource('r1', '新资源'), resource('r2', '新资源 (2)')]
    )
    expect(uniqueName(p, 'node', '整机循环')).toBe('整机循环 (2)')
    expect(uniqueName(p, 'resource', '新资源')).toBe('新资源 (3)')
    expect(uniqueName(p, 'resource', '抓手')).toBe('抓手')
    expect(uniqueName(p, 'node', '整机循环', 'm1')).toBe('整机循环')
  })
})
