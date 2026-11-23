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
  onAddChild: () => {},
  onManageResources: () => {},
  onEditResource: () => {}
}

function mk(id: string, kind: 'module' | 'mechanism' | 'action' | 'subaction', parentId: string | null, start: number, dur: number, preds: unknown[] = []): ModuleData {
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

  it('keeps the time ruler sticky so vertical scroll does not move it', () => {
    load({ enabled: false, cycleMs: 1000, repeats: 1 })
    const html = renderToStaticMarkup(React.createElement(GanttView, props))
    // The ruler <svg> (height === HEADER_HEIGHT, before the body svg) must be sticky at top.
    const rulerMatch = html.match(/<svg[^>]*height="46"[^>]*>/)
    expect(rulerMatch).toBeTruthy()
    expect(rulerMatch![0]).toMatch(/position:sticky/)
    expect(rulerMatch![0]).toMatch(/top:0/)
    // The label-column header is sticky too, so labels and time axis stay aligned.
    expect(html).toMatch(/position:sticky;top:0/)
  })

  it('time-cell width (pxPerMs) drives the drawn bar width', () => {
    load({ enabled: false, cycleMs: 1000, repeats: 3 })
    const barWidth = (html: string) => {
      const seg = html.slice(html.indexOf('data-task-id="A1"'))
      const m = seg.match(/<rect[^>]*?\swidth="([\d.]+)"/)
      return Number(m?.[1] ?? 0)
    }
    useProjectStore.getState().setGanttConfig({ pxPerMs: 0.35 })
    const narrow = barWidth(renderToStaticMarkup(React.createElement(GanttView, props)))
    // Dialog "apply" writes cellWidth/scale = 70/100 = 0.7 px/ms.
    useProjectStore.getState().setGanttConfig({ pxPerMs: 0.7 })
    const wide = barWidth(renderToStaticMarkup(React.createElement(GanttView, props)))
    expect(narrow).toBe(35)
    expect(wide).toBe(70)
  })
})

describe('Gantt conflict markers', () => {
  it('marks both bars of a mechanism conflict that starts at 0ms (badge stays visible)', () => {
    useProjectStore.getState().loadProject({
      name: 'conflict-at-zero',
      modules: [
        mk('M1', 'module', null, 0, 0),
        mk('K1', 'mechanism', 'M1', 0, 0),
        // Two leaves under one mechanism, both starting at 0ms and overlapping.
        mk('A1', 'action', 'K1', 0, 1000),
        mk('A2', 'action', 'K1', 0, 1000)
      ],
      timeConfig: { scaleMs: 1000, precisionMs: 100, displayUnit: 'ms' },
      cycleConfig: { enabled: false, cycleMs: 30000, repeats: 1 }
    } as never)
    useUIStore.getState().setCollapsedTasks([])
    const html = renderToStaticMarkup(React.createElement(GanttView, props))

    // Both conflicting actions render with an amber outline (SSR emits <rect ...></rect>).
    const amberRects = [...html.matchAll(/<rect[^>]*?stroke="#f59e0b"[^>]*?>/g)]
    expect(amberRects.length).toBeGreaterThanOrEqual(2)

    // The amber "M" badge for a bar at x=0 must be clamped into view (x >= 0).
    const mTexts = [...html.matchAll(/<text[^>]*?x="([\d.]+)"[^>]*?>M<\/text>/g)]
    expect(mTexts.length).toBeGreaterThanOrEqual(2)
    for (const m of mTexts) expect(Number(m[1])).toBeGreaterThanOrEqual(0)
  })
})

describe('Gantt readability', () => {
  it('shades alternate chart rows and mounts the crosshair overlay', () => {
    load({ enabled: false, cycleMs: 1000, repeats: 1 })
    const html = renderToStaticMarkup(React.createElement(GanttView, props))
    // Three template rows → exactly the odd row gets the label column's zebra.
    expect([...html.matchAll(/data-row-shade="stripe"/g)]).toHaveLength(1)
    expect(html).toContain('data-cursor-line')
    expect(html).toContain('data-cursor-label')
  })

  it('caps the auto label column so a long name cannot swallow the chart', () => {
    const long = mk('LONG', 'action', 'M1', 0, 100)
    long.actionDescription = '很长很长的动作名称'.repeat(30)
    useProjectStore.getState().loadProject({
      name: 'long-label',
      modules: [mk('M1', 'module', null, 0, 0), long],
      timeConfig: { scaleMs: 100, precisionMs: 1, displayUnit: 'ms' },
      cycleConfig: { enabled: false, cycleMs: 1000, repeats: 1 }
    } as never)
    useUIStore.getState().setCollapsedTasks([])
    const html = renderToStaticMarkup(React.createElement(GanttView, props))
    const match = html.match(/style="width:(\d+)px;position:sticky;left:0"/)
    expect(match).toBeTruthy()
    // Node SSR viewport fallback is 1400 px → 35% = 490 px, floor 320 px.
    expect(Number(match![1])).toBeLessThanOrEqual(490)
    expect(Number(match![1])).toBeGreaterThanOrEqual(320)
    // The full name stays available on hover.
    expect(html).toContain('title="很长很长的动作名称')
  })

  it('paints the conflict overlap window on the rows that collide', () => {
    useProjectStore.getState().loadProject({
      name: 'conflict-band',
      modules: [
        mk('M1', 'module', null, 0, 0),
        mk('K1', 'mechanism', 'M1', 0, 0),
        mk('A1', 'action', 'K1', 0, 1000),
        mk('A2', 'action', 'K1', 0, 1000)
      ],
      timeConfig: { scaleMs: 1000, precisionMs: 100, displayUnit: 'ms' },
      cycleConfig: { enabled: false, cycleMs: 30000, repeats: 1 }
    } as never)
    useUIStore.getState().setCollapsedTasks([])
    const html = renderToStaticMarkup(React.createElement(GanttView, props))
    const bands = [...html.matchAll(/data-conflict-band="([^"]+)"[^>]*?x="([\d.]+)"[^>]*?width="([\d.]+)"/g)]
    // Two leaves share one 1000 ms overlap; both rows get the amber band.
    expect(bands).toHaveLength(2)
    expect(bands.every(m => m[1] === 'mechanism')).toBe(true)
    expect(Number(bands[0][2])).toBe(0)
    expect(Number(bands[0][3])).toBeCloseTo(350, 0) // 1000 ms × 0.35 px/ms
  })
})
