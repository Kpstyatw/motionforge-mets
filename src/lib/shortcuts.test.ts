import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from './shortcuts'
import zhTW from '../locales/zh-TW/common.json'
import zhCN from '../locales/zh-CN/common.json'
import en from '../locales/en/common.json'
import ja from '../locales/ja/common.json'
import ko from '../locales/ko/common.json'

describe('shortcut registry', () => {
  it('binds New Project to Ctrl+N', () => {
    const create = SHORTCUTS.find(s => s.command === 'new-project')
    expect(create?.accelerator).toBe('CmdOrCtrl+N')
    expect(create?.bindings).toEqual([{ key: 'n', ctrl: true }])
    expect(create?.labelKey).toBe('menu.file.new')
  })

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

  it('ships the new-project labels in every locale', () => {
    for (const locale of [zhTW, zhCN, en, ja, ko]) {
      expect(locale.menu.file.new).toBeTruthy()
      expect(locale.toolbar.newProject).toBeTruthy()
      for (const key of ['unsavedTitle', 'unsavedDescription', 'saveAndNew', 'discardAndNew', 'created']) {
        expect(locale.newProject[key as keyof typeof locale.newProject]).toBeTruthy()
      }
    }
  })
})
