import { ModuleData, ProjectData, Resource, TaskKind } from '@/types'

/**
 * Name uniqueness rules for authored entities.
 *
 * There are two independent namespaces:
 *   - physical nodes: 模块 / 机构 (kind === 'module' | 'mechanism')
 *   - abstract resources: the resource catalogue, including child slots
 *
 * A mechanism and the resource it maps to MAY share a name — one is a physical
 * part of the instrument, the other is an abstract claimable unit derived from
 * it. Action/sub-action names are intentionally excluded: the same action label
 * recurring across cycles or mechanisms is normal in instrument flows.
 */

export type NameScope = 'node' | 'resource'
export type NameIssueReason = 'duplicate' | 'empty'

export interface NameIssue {
  scope: NameScope
  id: string
  /** Displayed value as authored (not lower-cased). */
  name: string
  reason: NameIssueReason
  kind?: TaskKind
}

/** The name that Excel / the hierarchy view treats as a node's identity. */
export function nodeDisplayName(module: ModuleData): string {
  return (module.moduleName || module.actionDescription || '').trim()
}

export function isPhysicalNode(module: ModuleData): boolean {
  return module.kind === 'module' || module.kind === 'mechanism'
}

/** Case-insensitive, whitespace-trimmed comparison — "Feeder" == " feeder ". */
function keyOf(name: string): string {
  return name.trim().toLocaleLowerCase()
}

interface Candidate extends NameIssue {
  key: string
}

function nodeCandidates(project: ProjectData | null): Candidate[] {
  if (!project) return []
  return project.modules
    .filter(isPhysicalNode)
    .map(m => {
      const name = nodeDisplayName(m)
      return {
        scope: 'node' as const,
        id: m.id,
        name,
        key: keyOf(name),
        reason: name ? ('duplicate' as const) : ('empty' as const),
        kind: m.kind
      }
    })
}

function resourceCandidates(project: ProjectData | null): Candidate[] {
  if (!project) return []
  return project.resources.map(r => {
    const name = (r.name || '').trim()
    return {
      scope: 'resource' as const,
      id: r.id,
      name,
      key: keyOf(name),
      reason: name ? ('duplicate' as const) : ('empty' as const)
    }
  })
}

/** All offending entities, one entry per occurrence so every row can be marked. */
export function findNameIssues(project: ProjectData | null): NameIssue[] {
  const candidates = [...nodeCandidates(project), ...resourceCandidates(project)]
  const counts = new Map<string, number>()
  candidates.forEach(c => {
    if (!c.key) return
    const k = `${c.scope}\u0000${c.key}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  })
  return candidates
    .filter(c => c.reason === 'empty' || (counts.get(`${c.scope}\u0000${c.key}`) ?? 0) > 1)
    .map(({ scope, id, name, reason, kind }) => ({ scope, id, name, reason, kind }))
}

/** Whether `name` can be used by `excludeId` inside the given namespace. */
export function isNameAvailable(
  project: ProjectData | null,
  scope: NameScope,
  name: string,
  excludeId?: string
): boolean {
  const key = keyOf(name)
  if (!key) return false
  const pool = scope === 'node' ? nodeCandidates(project) : resourceCandidates(project)
  return !pool.some(c => c.id !== excludeId && c.key === key)
}

/** Produce a non-colliding name for defaults and auto-created ancestors. */
export function uniqueName(
  project: ProjectData | null,
  scope: NameScope,
  base: string,
  excludeId?: string
): string {
  const stem = base.trim() || (scope === 'node' ? '未命名' : '新资源')
  if (isNameAvailable(project, scope, stem, excludeId)) return stem
  let n = 2
  while (!isNameAvailable(project, scope, `${stem} (${n})`, excludeId)) n += 1
  return `${stem} (${n})`
}

/** Short plain-language diagnostics for store warnings (no i18n dependency). */
export function formatNameIssue(issue: NameIssue): string {
  if (issue.reason === 'empty') {
    return issue.scope === 'node' ? '模块/机构名称不能为空' : '资源名称不能为空'
  }
  return issue.scope === 'node'
    ? `模块/机构名称重复：${issue.name || '(空)'}`
    : `资源名称重复：${issue.name || '(空)'}`
}

export function formatNameIssues(project: ProjectData | null): string[] {
  return findNameIssues(project).map(formatNameIssue)
}

/** i18n keys used by dialogs and the warning banner. */
export function nameIssueKey(issue: NameIssue): string {
  if (issue.reason === 'empty') {
    return issue.scope === 'node' ? 'nameIssue.emptyNode' : 'nameIssue.emptyResource'
  }
  return issue.scope === 'node' ? 'nameIssue.duplicateNode' : 'nameIssue.duplicateResource'
}

export function nameIssueParams(issue: NameIssue): { name: string } {
  return { name: issue.name || '(空)' }
}

/** Shared i18n rendering for dialogs and the warning banner. */
export function translateNameIssue(
  issue: NameIssue,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return t(nameIssueKey(issue), nameIssueParams(issue))
}

/** Convenience for dialogs: same check as isNameAvailable with a clear verdict. */
export function checkNewName(
  project: ProjectData | null,
  scope: NameScope,
  name: string,
  excludeId?: string
): { ok: boolean; reason?: NameIssueReason } {
  if (!name.trim()) return { ok: false, reason: 'empty' }
  return isNameAvailable(project, scope, name, excludeId)
    ? { ok: true }
    : { ok: false, reason: 'duplicate' }
}

export function isNamedResource(resource: Resource): boolean {
  return Boolean((resource.name || '').trim())
}
