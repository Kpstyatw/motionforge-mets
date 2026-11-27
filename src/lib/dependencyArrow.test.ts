import { describe, expect, it } from 'vitest'
import { routeDependencyArrow } from './dependencyArrow'

/** Parse an SVG path into its point list (only M/L commands are emitted). */
const points = (d: string): Array<[number, number]> =>
  [...d.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m => [Number(m[1]), Number(m[2])])

describe('dependency arrow routing', () => {
  it('uses a compact forward elbow for a normal FS edge with room', () => {
    const d = routeDependencyArrow({
      x1: 100, y1: 40, x2: 300, y2: 80, barH: 14,
      leaveRight: true, enterLeft: true
    })
    const pts = points(d)
    expect(pts).toHaveLength(4)
    // Vertical leg sits between the two anchors; the last leg moves right.
    expect(pts[1][0]).toBeGreaterThan(100)
    expect(pts[1][0]).toBeLessThan(300)
    expect(pts[3]).toEqual([300, 80])
    expect(pts[2][0]).toBeLessThanOrEqual(pts[3][0])
  })

  it('never draws a leftward leg across the target bar for a tight FS edge', () => {
    // Target starts at the exact source end (lag 0) — the old elbow produced
    // elbow = x1+10 > x2, i.e. a line running back to the left through the bar.
    const d = routeDependencyArrow({
      x1: 200, y1: 40, x2: 200, y2: 80, barH: 14,
      leaveRight: true, enterLeft: true
    })
    const pts = points(d)
    const last = pts[pts.length - 1]
    const before = pts[pts.length - 2]
    // Final hop approaches the left edge from its left, i.e. points right.
    expect(last).toEqual([200, 80])
    expect(before[0]).toBeLessThan(200)
    // The gutter sits in the empty lane below the source bar and above the
    // target bar — it never runs through either bar.
    const gutter = pts[2][1]
    expect(gutter).toBeGreaterThan(40 + 14 / 2) // below source bar's lower edge
    expect(gutter).toBeLessThan(80 - 14 / 2)     // above target bar's upper edge
  })

  it('routes an inverted dependency around the bars instead of back left', () => {
    // Target anchor sits before the source anchor (negative lag / rollup).
    const d = routeDependencyArrow({
      x1: 400, y1: 40, x2: 150, y2: 80, barH: 14,
      leaveRight: true, enterLeft: true
    })
    const pts = points(d)
    const last = pts[pts.length - 1]
    const before = pts[pts.length - 2]
    expect(last).toEqual([150, 80])
    expect(before[0]).toBeLessThan(150) // approach from the left, never from x>x2
    // Departs source to the right (148? no: x1+12 = 412), never left through it.
    expect(pts[1][0]).toBeGreaterThan(400)
  })

  it('enters the RIGHT edge from the right for FF / SF edges', () => {
    for (const leaveRight of [true, false]) {
      const d = routeDependencyArrow({
        x1: 100, y1: 40, x2: 200, y2: 80, barH: 14,
        leaveRight, enterLeft: false
      })
      const pts = points(d)
      const last = pts[pts.length - 1]
      const before = pts[pts.length - 2]
      expect(last).toEqual([200, 80])
      // Approach column sits right of the target, so the final hop points left.
      expect(before[0]).toBeGreaterThan(200)
      // Source departs on its own outward side.
      expect(pts[1][0]).toBe(leaveRight ? 112 : 88)
    }
  })

  it('keeps the gutter on the target-facing side when the target is above', () => {
    const d = routeDependencyArrow({
      x1: 100, y1: 120, x2: 100, y2: 40, barH: 14,
      leaveRight: true, enterLeft: true
    })
    const pts = points(d)
    const gutter = pts[2][1]
    // Target above -> gutter runs in the lane ABOVE the source bar.
    expect(gutter).toBeLessThan(120 - 14 / 2)
  })
})
