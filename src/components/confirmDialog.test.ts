import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('no native confirm dialogs', () => {
  it('TaskEditorDialog does not use window.confirm (kills Electron keyboard focus)', () => {
    const src = readFileSync(resolve(__dirname, 'TaskEditorDialog.tsx'), 'utf8')
    expect(src).not.toMatch(/window\.confirm/)
    expect(src).toContain('ConfirmDialog')
  })

})
