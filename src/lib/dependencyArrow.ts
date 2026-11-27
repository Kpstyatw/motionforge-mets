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

/**
 * Reserved dependency-arrow colour. Bars must never use it, otherwise an
 * arrow can disappear into a bar of the same colour. Kept here so the on-screen
 * Gantt, the PDF report and the canvas/MP4 renderer cannot drift apart.
 */
export const DEPENDENCY_ARROW_COLOR = '#000000'

/** True when a candidate bar colour collides with the reserved arrow colour. */
export function isArrowReservedColor(color: string | undefined | null): boolean {
  if (!color) return false
  const s = color.trim().toLowerCase()
  if (s === 'black' || s === 'rgb(0,0,0)' || s === 'rgb(0, 0, 0)') return true
  const digits = s.replace(/^#/, '')
  return /^0{3}(?:0{3})?$/.test(digits)
}

/** Fall back to a safe bar colour when the requested one is reserved. */
export function safeBarColor(color: string | undefined, fallback: string): string | undefined {
  return isArrowReservedColor(color) ? fallback : color
}

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

export type ArrowPoint = [number, number]

/** The polyline points, shared by the SVG path, PDF SVG and canvas renderers. */
export function dependencyArrowPoints(input: ArrowRouteInput): ArrowPoint[] {
  const { x1, y1, x2, y2, barH, leaveRight, enterLeft } = input
  const departX = leaveRight ? x1 + STUB : x1 - STUB
  const approachX = enterLeft ? x2 - STUB : x2 + STUB

  // Plain FS edge with real space between the bars: compact elbow, vertical
  // leg in the middle of the gap. Both horizontal legs point forward.
  if (leaveRight && enterLeft && x2 - x1 >= MIN_SIMPLE_GAP) {
    const legX = x1 + (x2 - x1) / 2
    return [[x1, y1], [legX, y1], [legX, y2], [x2, y2]]
  }

  // Gutter route. Leave on the outward side, run along a lane just outside the
  // source row, then drop in on the target's entry side. The approach column
  // stays outside the target bar, so the last hop never crosses it.
  const dir = y2 >= y1 ? 1 : -1
  const gutterY = y1 + dir * (barH / 2 + GUTTER)
  return [
    [x1, y1],
    [departX, y1],
    [departX, gutterY],
    [approachX, gutterY],
    [approachX, y2],
    [x2, y2]
  ]
}

/** SVG path string for the on-screen Gantt (marker handles the arrow head). */
export function routeDependencyArrow(input: ArrowRouteInput): string {
  return dependencyArrowPoints(input)
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${r(x)} ${r(y)}`)
    .join(' ')
}

/**
 * Arrow-head wings at the end of a polyline, for renderers that draw the head
 * themselves (PDF SVG / canvas). `size` is the head length.
 */
export function arrowHead(points: ArrowPoint[], size = 6): [ArrowPoint, ArrowPoint] {
  const end = points[points.length - 1]
  const prev = points[points.length - 2] ?? [end[0] - size, end[1]]
  let dx = end[0] - prev[0]
  let dy = end[1] - prev[1]
  const len = Math.hypot(dx, dy) || 1
  dx /= len
  dy /= len
  const half = size * 0.5
  // Two wings behind the tip, perpendicular to the final approach direction.
  return [
    [end[0] - dx * size - dy * half, end[1] - dy * size + dx * half],
    [end[0] - dx * size + dy * half, end[1] - dy * size - dx * half]
  ]
}
