import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from './shortcuts'

describe('shortcut registry', () => {
  it('keeps Open and Import on distinct accelerators and bindings', () => {
    const open = SHORTCUTS.find(s => s.command === 'open-project')
    const importData = SHORTCUTS.find(s => s.command === 'import-csv')

    expect(open?.accelerator).toBe('CmdOrCtrl+O')
    expect(open?.bindings).toEqual([{ key: 'o', ctrl: true }])
    expect(importData?.accelerator).toBe('CmdOrCtrl+I')
    expect(importData?.bindings).toEqual([{ key: 'i', ctrl: true }])
  })

  it('never binds two commands to the same accelerator', () => {
    const accelerators = SHORTCUTS.map(s => s.accelerator).filter((a): a is string => !!a)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })
})
