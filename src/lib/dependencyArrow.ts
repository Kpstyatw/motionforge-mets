/**
 * Dependency-arrow routing for the Gantt chart.
 *
 * The old elbow (`max(x1+10, x2-14)`) drew a leftward horizontal leg whenever
 * the target anchor sat close to or before the source anchor (lag 0, negative
 * lag, or a container rollup). That leg ran back through the target bar, which
 * is exactly the "arrow goes left through the columns" artifact.
 *
 * Two cases now:
 *  - a plain FS edge with room between the bars keeps the compact 4-segment
 *    elbow, with the vertical leg centred in the gap;
 *  - every other case (SS/FF/SF, tight or inverted anchors) leaves the source
 *    on its outward side, travels along a gutter just outside the source row,
 *    then comes down on the target's entry side. The final short hop always
 *    points AT the anchor, never back across a bar.
 */

export interface ArrowRouteInput {
  /** source anchor (x) */
  x1: number
  /** source row centre (y) */
  y1: number
  /** target anchor (x) */
  x2: number
  /** target row centre (y) */
  y2: number
  /** bar height, used to keep the gutter clear of the bar */
  barH: number
  /** source anchor is its right edge (FS/FF); otherwise its left edge (SS/SF) */
  leaveRight: boolean
  /** target anchor is its left edge (FS/SS); otherwise its right edge (FF/SF) */
  enterLeft: boolean
}

const STUB = 12
const GUTTER = 8
/** Minimum gap for the compact elbow; below this the gutter route is used. */
const MIN_SIMPLE_GAP = 28

const r = (v: number) => Math.round(v * 10) / 10

export function routeDependencyArrow(input: ArrowRouteInput): string {
  const { x1, y1, x2, y2, barH, leaveRight, enterLeft } = input
  const departX = leaveRight ? x1 + STUB : x1 - STUB
  const approachX = enterLeft ? x2 - STUB : x2 + STUB

  // Plain FS edge with real space between the bars: compact elbow, vertical
  // leg in the middle of the gap. Both horizontal legs point forward.
  if (leaveRight && enterLeft && x2 - x1 >= MIN_SIMPLE_GAP) {
    const legX = x1 + (x2 - x1) / 2
    return `M ${r(x1)} ${r(y1)} L ${r(legX)} ${r(y1)} L ${r(legX)} ${r(y2)} L ${r(x2)} ${r(y2)}`
  }

  // Gutter route. Leave on the outward side, run along a lane just outside the
  // source row, then drop in on the target's entry side. The approach column
  // stays outside the target bar, so the last hop never crosses it.
  const dir = y2 >= y1 ? 1 : -1
  const gutterY = y1 + dir * (barH / 2 + GUTTER)
  const points: Array<[number, number]> = [
    [x1, y1],
    [departX, y1],
    [departX, gutterY],
    [approachX, gutterY],
    [approachX, y2],
    [x2, y2]
  ]
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${r(x)} ${r(y)}`)
    .join(' ')
}
