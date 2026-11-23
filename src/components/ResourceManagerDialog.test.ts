import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? ''
  })
}))

// Zustand's server snapshot has no project; use the live state like the
// existing GanttView tests so the markup matches what the UI renders.
vi.mock('@/stores/useProjectStore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/stores/useProjectStore')>()
  const hook = ((selector?: (s: unknown) => unknown) => {
    const state = actual.useProjectStore.getState()
    return selector ? selector(state) : state
  }) as typeof actual.useProjectStore
  Object.assign(hook, actual.useProjectStore)
  return { ...actual, useProjectStore: hook }
})

import { ResourceManagerDialog } from './ResourceManagerDialog'
import { useProjectStore } from '@/stores/useProjectStore'

function loadCatalogue() {
  useProjectStore.getState().loadProject({
    name: 'resource-dialog',
    modules: [],
    resources: [
      { id: 'R1', name: '取血抓手', type: 'gripper' },
      { id: 'R2', name: '清洗盘', type: 'plate' }
    ],
    allocations: []
  } as never)
}

const render = (focusResourceId?: string) => renderToStaticMarkup(
  React.createElement(ResourceManagerDialog, {
    isOpen: true, onClose: () => {}, focusResourceId
  })
)

describe('ResourceManagerDialog catalogue visibility', () => {
  it('hides existing resources by default on the add-resource entry', () => {
    loadCatalogue()
    const html = render()
    expect(html).not.toContain('取血抓手')
    expect(html).not.toContain('清洗盘')
    // The collapsed entry point and the new-resource form stay visible.
    expect(html).toContain('已有资源')
    expect(html).toContain('新建一个资源')
  })

  it('shows only the focused resource when opened from a lane pencil', () => {
    loadCatalogue()
    const html = render('R1')
    expect(html).toContain('取血抓手')
    expect(html).not.toContain('清洗盘')
    expect(html).not.toContain('已有资源')
  })
})
