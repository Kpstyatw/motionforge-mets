import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key
  })
}))

// Zustand's server snapshot is the store's *initial* state, which has no
// project. Point the hooks at the live state so SSR renders what the UI sees.
vi.mock('@/stores/useProjectStore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/stores/useProjectStore')>()
  const hook = ((selector?: (s: unknown) => unknown) => {
    const state = actual.useProjectStore.getState()
    return selector ? selector(state) : state
  }) as typeof actual.useProjectStore
  Object.assign(hook, actual.useProjectStore)
  return { ...actual, useProjectStore: hook }
})

import { GanttView } from '@/components/GanttView'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { ModuleData } from '@/types'

const props = {
  onEditTask: () => {},
  onOpenTimeScale: () => {},
  onOpenExcel: () => {},
  onAddChild: () => {},
  onManageResources: () => {}
}

function mk(id: string, kind: 'module' | 'action', parentId: string | null, start: number, dur: number, preds: unknown[] = []): ModuleData {
  return {
    id, code: id, kind, parentId, moduleName: '机构', actionDescription: id,
    startMs: start, anchorMs: start, durationMs: dur, endMs: start + dur, startMode: 'auto',
    predecessors: preds, startX: 0, calculatedStartX: 0, moveCount: 0, duration: 100, isSequentialAction: false
  } as ModuleData
}

function load(cycleConfig: { enabled: boolean; cycleMs: number; repeats: number }) {
  useProjectStore.getState().loadProject({
    name: 'cycle-layout',
    modules: [
      mk('M1', 'module', null, 0, 0),
      mk('A1', 'action', 'M1', 0, 100),
      mk('A2', 'action', 'M1', 100, 100, [{ id: 'd1', fromId: 'A1', type: 'FS', lagMs: 0 }])
    ],
    timeConfig: { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' },
    cycleConfig
  } as never)
  useUIStore.getState().setCollapsedTasks([])
}

const barIds = (html: string) =>
  [...html.matchAll(/data-task-id="([^"]+)"/g)].map(m => m[1])

describe('Gantt multi-cycle layout', () => {
  it('single cycle: one bar per template task', () => {
    load({ enabled: false, cycleMs: 1000, repeats: 3 })
    expect(barIds(renderToStaticMarkup(React.createElement(GanttView, props))))
      .toEqual(['M1', 'A1', 'A2'])
  })

  it('multi cycle: rows stay unique, cycles extend the time axis instead', () => {
    load({ enabled: true, cycleMs: 1000, repeats: 3 })
    const html = renderToStaticMarkup(React.createElement(GanttView, props))
    // Same three rows, three bars each — no @C2/@C3 rows appended below.
    expect(barIds(html)).toEqual([
      'M1@C1', 'M1@C2', 'M1@C3',
      'A1@C1', 'A1@C2', 'A1@C3',
      'A2@C1', 'A2@C2', 'A2@C3'
    ])
    expect(html).toContain('×3')
  })
})
