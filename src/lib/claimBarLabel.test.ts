import { describe, expect, it } from 'vitest'
import { claimBarLabel, measureTextWidth } from './labelWidth'

describe('claimBarLabel — resource claim bars always show the action NAME', () => {
  const name = '取血抓手夹管动作'

  it('shows the full name when the bar is wide enough', () => {
    expect(claimBarLabel(name, '', 200)).toBe(name)
  })

  it('truncates the name with an ellipsis when the bar is narrow', () => {
    const label = claimBarLabel(name, '', 60)
    expect(label).not.toBe(name)
    expect(label.endsWith('…')).toBe(true)
    // The truncated label fits inside the bar's available pixel width.
    expect(measureTextWidth(label, 10)).toBeLessThanOrEqual(60 - 12)
  })

  it('never falls back to a numeric code, whatever the width', () => {
    for (const width of [24, 46, 80, 118, 200, 400]) {
      const label = claimBarLabel(name, '', width)
      expect(label).not.toContain('03.')
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('keeps the cycle tag in front and truncates the name after it', () => {
    const label = claimBarLabel(name, 'C2·', 60)
    expect(label.startsWith('C2·')).toBe(true)
    expect(label).not.toBe(name)
    expect(measureTextWidth(label, 10)).toBeLessThanOrEqual(60 - 12)
  })

  it('keeps a short name intact even on a medium bar', () => {
    expect(claimBarLabel('夹管', '', 60)).toBe('夹管')
  })
})
