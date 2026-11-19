import { describe, expect, it } from 'vitest'
import { ModuleData, TaskKind } from '@/types'
import { computeSchedule } from './dependencyEngine'
import { DEFAULT_TIME_CONFIG } from './timeScale'
import { detectMechanismConflicts, ownerBoundaryOf } from './mechanismConflict'

const CONFIG = { ...DEFAULT_TIME_CONFIG }

function node(
  id: string, kind: TaskKind, parentId: string | null,
  startMs: number, durationMs: number
): ModuleData {
  return {
    id, code: id, kind, parentId,
    moduleName: kind === 'mechanism' ? `机构${id}` : kind === 'module' ? `模块${id}` : '',
    actionDescription: kind === 'action' || kind === 'subaction' ? `动作${id}` : '',
    startMs, anchorMs: startMs, durationMs,
    endMs: startMs + durationMs, startMode: 'manual',
    startX: 0, calculatedStartX: 0, moveCount: 0, duration: 0
  }
}

describe('mechanism concurrency conflict', () => {
  it('detects two overlapping leaf actions under the same mechanism', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 800),  // [1000, 1800)
      node('B', 'action', 'K', 1500, 600)   // [1500, 2100) → overlap 300
    ]
    const schedule = computeSchedule(modules, CONFIG)
    const result = detectMechanismConflicts(schedule)
    expect(result.conflicts).toHaveLength(1)
    const c = result.conflicts[0]
    expect(c.ownerId).toBe('K')
    expect(c.overlapStartMs).toBe(1500)
    expect(c.overlapEndMs).toBe(1800)
    expect(c.overlapMs).toBe(300)
    expect(result.conflictedTaskIds.has('A')).toBe(true)
    expect(result.conflictedTaskIds.has('B')).toBe(true)
  })

  it('treats back-to-back windows as non-conflicting (half-open interval)', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 500), // [1000, 1500)
      node('B', 'action', 'K', 1500, 500)  // [1500, 2000)
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    expect(result.conflicts).toHaveLength(0)
  })

  it('does not conflict across different mechanisms', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K1', 'mechanism', 'M', 0, 0),
      node('K2', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K1', 1000, 800),
      node('B', 'action', 'K2', 1200, 800)
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    expect(result.conflicts).toHaveLength(0)
  })

  it('does not conflict between a parent action and its sub-action (same motion, two granularities)', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 1000),       // parent, has a child
      node('A1', 'subaction', 'A', 1000, 400),    // finest leaf
      node('A2', 'subaction', 'A', 1500, 400)     // finest leaf
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    // A is not a leaf (has children) so it is excluded entirely; A1/A2 are back-to-back.
    expect(result.conflicts).toHaveLength(0)
  })

  it('detects overlap between sub-actions of different actions under one mechanism', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 0, 1000),
      node('A1', 'subaction', 'A', 100, 500),   // [100, 600)
      node('B', 'action', 'K', 1000, 1000),
      node('B1', 'subaction', 'B', 500, 400)    // [500, 900) → overlap with A1 = 100
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].overlapMs).toBe(100)
    expect(new Set([result.conflicts[0].a.id, result.conflicts[0].b.id])).toEqual(new Set(['A1', 'B1']))
  })

  it('falls back to the module boundary when no mechanism ancestor exists', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('A', 'action', 'M', 1000, 800),
      node('B', 'action', 'M', 1200, 800)
    ]
    const schedule = computeSchedule(modules, CONFIG)
    expect(ownerBoundaryOf(schedule, 'A')?.id).toBe('M')
    const result = detectMechanismConflicts(schedule)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].ownerId).toBe('M')
  })

  it('ignores actions with no module/mechanism boundary', () => {
    const modules = [
      node('A', 'action', null, 1000, 800),
      node('B', 'action', null, 1200, 800)
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    expect(result.conflicts).toHaveLength(0)
  })

  it('reports all pairwise overlaps within a mechanism, keyed by owner', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 900), // [1000,1900)
      node('B', 'action', 'K', 1100, 900), // [1100,2000) overlaps A
      node('C', 'action', 'K', 2500, 300)  // separate
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    expect(result.conflicts).toHaveLength(1)
    expect(result.byOwner['K']).toHaveLength(1)
  })

  it('skips zero-duration leaves', () => {
    const modules = [
      node('M', 'module', null, 0, 0),
      node('K', 'mechanism', 'M', 0, 0),
      node('A', 'action', 'K', 1000, 0),
      node('B', 'action', 'K', 1000, 500)
    ]
    const result = detectMechanismConflicts(computeSchedule(modules, CONFIG))
    expect(result.conflicts).toHaveLength(0)
  })
})
