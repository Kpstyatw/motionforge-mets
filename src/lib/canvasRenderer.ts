import { ModuleData, TimeConfig } from '@/types'
import { computeActionStartTimes, startMsOf, durationMsOf } from './timingModel'
import { CanvasSurface, DrawSurface, SvgSurface } from './drawSurface'
import { formatTime, normalizeTimeConfig, rulerTicks } from './timeScale'
import { arrowHead, dependencyArrowPoints, DEPENDENCY_ARROW_COLOR } from './dependencyArrow'

/**
 * Timing chart renderer — every pixel of the chart is drawn here.
 *
 * Drawing goes through DrawSurface, so the same code produces the on-screen
 * canvas, the frames handed to the MP4 encoder, and the vector chart embedded
 * in the PDF report.
 *
 * Gantt edition: geometry is now **millisecond-based**. `cellWidth` is the
 * width of one `scaleMs` division, so `pxPerMs = cellWidth / scaleMs`. Bars are
 * drawn from the canonical `startMs` / `durationMs` written by the scheduling
 * engine; the grid lines are just ruler ticks. This is what makes a 1 ms
 * action visible at the 1 ms scale and keeps screen, video, PDF and Excel in
 * agreement.
 */

/** Height reserved for the ruler, matching the parameter table's header. */
export const HEADER_HEIGHT = 40

/** Width of the row-number ruler down the right edge. */
const RULER_WIDTH = 30
const RULER_FONT_FAMILY = 'monospace'
const RULER_FONT_SIZE = 10

const LABEL_FONT_FAMILY =
  '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK SC", "Noto Sans CJK KR", system-ui, sans-serif'
const LABEL_INK = '#12161B'
const LABEL_HALO = 'rgba(255, 255, 255, 0.92)'
const LABEL_HALO_WIDTH = 3
const MIN_LABEL_FONT_SIZE = 6
const LINK_COLOR = DEPENDENCY_ARROW_COLOR

function labelFontSize(cellHeight: number): number {
  return Math.round(Math.min(22, cellHeight * 0.42))
}

export interface RenderConfig {
  /** Pixel width of one `scaleMs` division. */
  cellWidth: number
  cellHeight: number
  gridColor: string
  backgroundColor: string
  defaultFillColor: string
  textDisplay: 'module' | 'stage' | 'action'
  /** Milliseconds per grid division. Defaults to 100 for legacy callers. */
  scaleMs?: number
  precisionMs?: number
  displayUnit?: TimeConfig['displayUnit']
  /** Paint dependency arrows in the classic grid as well as the Gantt view. */
  showDependencies?: boolean
}

export const DEFAULT_RENDER_CONFIG: Omit<RenderConfig, 'cellWidth' | 'cellHeight'> = {
  gridColor: '#e5e5e5',
  backgroundColor: '#ffffff',
  defaultFillColor: '#3b82f6',
  textDisplay: 'action',
  scaleMs: 100,
  precisionMs: 1,
  displayUnit: 'ms',
  showDependencies: true
}

function pxPerMsOf(config: RenderConfig): number {
  return config.cellWidth / Math.max(1, config.scaleMs ?? 100)
}

function timeConfigOf(config: RenderConfig): TimeConfig {
  return normalizeTimeConfig({
    scaleMs: config.scaleMs,
    precisionMs: config.precisionMs,
    displayUnit: config.displayUnit
  })
}

/** Natural size of the chart for a given module set. */
export function computeCanvasSize(
  modules: ModuleData[],
  cellWidth: number,
  cellHeight: number,
  scaleMs = 100
): { width: number; height: number } {
  const config = { cellWidth, cellHeight, scaleMs } as RenderConfig
  const px = pxPerMsOf(config)
  const step = Math.max(1, scaleMs)
  if (!modules.length) return { width: 800, height: 600 }
  const maxEndMs = Math.max(...modules.map(m => startMsOf(m) + durationMsOf(m)))
  return {
    width: Math.max(800, (maxEndMs + step * 2) * px + RULER_WIDTH),
    height: Math.max(600, HEADER_HEIGHT + modules.length * cellHeight + 100)
  }
}

/** Tight size for print/export: no 800x600 floor and only a little padding. */
export function computeContentSize(
  modules: ModuleData[],
  cellWidth: number,
  cellHeight: number,
  scaleMs = 100
): { width: number; height: number } {
  const config = { cellWidth, cellHeight, scaleMs } as RenderConfig
  const px = pxPerMsOf(config)
  const step = Math.max(1, scaleMs)
  if (!modules.length) return { width: 800, height: 600 }
  const maxEndMs = Math.max(...modules.map(m => startMsOf(m) + durationMsOf(m)))
  return {
    width: (maxEndMs + step * 2) * px + RULER_WIDTH,
    height: HEADER_HEIGHT + (modules.length + 1) * cellHeight
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (result) {
    const r = parseInt(result[1], 16)
    const g = parseInt(result[2], 16)
    const b = parseInt(result[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return hex
}

export function drawGrid(
  surface: DrawSurface,
  width: number,
  height: number,
  config: RenderConfig,
  headerHeight: number
) {
  for (let x = 0; x <= width; x += config.cellWidth) {
    surface.line(x + 0.5, 0, x + 0.5, height, config.gridColor, 0.5)
  }
  surface.line(0, headerHeight + 0.5, width, headerHeight + 0.5, config.gridColor, 0.5)
  for (let y = headerHeight; y <= height; y += config.cellHeight) {
    surface.line(0, y + 0.5, width, y + 0.5, config.gridColor, 0.5)
  }
}

export function drawRuler(
  surface: DrawSurface,
  width: number,
  height: number,
  config: RenderConfig,
  headerHeight: number
) {
  surface.rect(0, 0, width, headerHeight, { fill: '#f3f4f6' })
  surface.rect(width - RULER_WIDTH, 0, RULER_WIDTH, height, { fill: '#f3f4f6' })

  const rulerText = {
    fill: '#6b7280',
    fontSize: RULER_FONT_SIZE,
    fontFamily: RULER_FONT_FAMILY,
    align: 'center' as const
  }
  // Use the very same tick selection as the on-screen Gantt (rulerTicks):
  // a whole number of scale divisions, thinned to a 74px minimum spacing.
  // A separate ceil(46/cellWidth) rule here made the PDF/MP4 ruler mark
  // different instants from the chart the user saw on screen.
  const time = timeConfigOf(config)
  const px = pxPerMsOf(config)
  const plotWidth = Math.max(0, width - RULER_WIDTH)
  for (const tickMs of rulerTicks(plotWidth / Math.max(px, 0.000001), time.scaleMs, px, 74)) {
    const x = tickMs * px
    if (x > plotWidth + 0.5) break
    surface.text(formatTime(tickMs, time), x + 2, headerHeight / 2, {
      ...rulerText,
      align: 'left'
    })
  }

  const rowStep = Math.max(1, Math.ceil(RULER_FONT_SIZE / config.cellHeight))
  let rowIndex = 0
  for (let y = headerHeight + config.cellHeight; y < height; y += config.cellHeight) {
    if (rowIndex % rowStep === 0) {
      surface.text(String(rowIndex + 1), width - RULER_WIDTH / 2, y - config.cellHeight / 2, rulerText)
    }
    rowIndex++
  }
}

/** Label shown inside a module's track, per the user's text-display preference. */
export function moduleLabel(module: ModuleData, textDisplay: RenderConfig['textDisplay']): string {
  switch (textDisplay) {
    case 'module': return module.moduleName
    case 'stage': return module.stage || ''
    case 'action':
    default: return module.actionDescription
  }
}

/** The static track for every module: the exact ms interval it will occupy. */
export function drawModuleTracksAligned(
  surface: DrawSurface,
  modules: ModuleData[],
  config: RenderConfig,
  headerHeight: number
) {
  const px = pxPerMsOf(config)
  const step = Math.max(1, config.scaleMs ?? 100)
  modules.forEach((module, row) => {
    const start = startMsOf(module)
    const end = start + durationMsOf(module)
    if (end <= start) return
    const x = start * px
    const y = headerHeight + row * config.cellHeight
    const w = (end - start) * px
    const color = module.color || config.defaultFillColor

    surface.rect(x, y, w, config.cellHeight, { fill: hexToRgba(color, 0.2) })
    surface.rect(x + 0.5, y + 0.5, w - 1, config.cellHeight - 1, { stroke: color, lineWidth: 0.5 })
    // Cell separators inside the bar keep the original "beat grid" look.
    const first = Math.ceil(start / step) * step
    for (let t = first; t < end - 0.0001; t += step) {
      const lx = t * px
      surface.line(lx + 0.5, y, lx + 0.5, y + config.cellHeight, color, 0.5)
    }
  })
}

/**
 * Dependency arrows. Drawn with the tiny DrawSurface API (lines only), so the
 * same arrows appear on screen, in MP4 frames and in the vector PDF.
 */
export function drawDependencyLinks(
  surface: DrawSurface,
  modules: ModuleData[],
  config: RenderConfig,
  headerHeight: number
) {
  const px = pxPerMsOf(config)
  const rowOf = new Map(modules.map((m, i) => [m.id, i]))
  const byId = new Map(modules.map(m => [m.id, m]))

  modules.forEach(succ => {
    const succRow = rowOf.get(succ.id) ?? 0
    const succStart = startMsOf(succ)
    const succEnd = succStart + durationMsOf(succ)
    ;(succ.predecessors ?? []).forEach(dep => {
      const pred = byId.get(dep.fromId)
      if (!pred) return
      const predRow = rowOf.get(pred.id) ?? 0
      const predStart = startMsOf(pred)
      const predEnd = predStart + durationMsOf(pred)
      const startFromEnd = dep.type === 'FS' || dep.type === 'FF'
      const endAtFinish = dep.type === 'FF' || dep.type === 'SF'
      const fromX = (startFromEnd ? predEnd : predStart) * px
      const toX = (endAtFinish ? succEnd : succStart) * px
      const fromY = headerHeight + predRow * config.cellHeight + config.cellHeight / 2
      const toY = headerHeight + succRow * config.cellHeight + config.cellHeight / 2

      // Same router as the Gantt/PDF charts — no leftward leg through a bar.
      const pts = dependencyArrowPoints({
        x1: fromX, y1: fromY, x2: toX, y2: toY,
        barH: config.cellHeight * 0.56,
        leaveRight: startFromEnd,
        enterLeft: !endAtFinish
      })
      for (let i = 1; i < pts.length; i++) {
        surface.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], LINK_COLOR, 1)
      }
      const [w1, w2] = arrowHead(pts)
      surface.line(toX, toY, w1[0], w1[1], LINK_COLOR, 1)
      surface.line(toX, toY, w2[0], w2[1], LINK_COLOR, 1)
    })
  })
}

/** Track labels, painted last so they sit on top of the animation fill. */
export function drawModuleLabels(
  surface: DrawSurface,
  modules: ModuleData[],
  config: RenderConfig,
  headerHeight: number
) {
  const fontSize = labelFontSize(config.cellHeight)
  if (fontSize < MIN_LABEL_FONT_SIZE) return
  const px = pxPerMsOf(config)
  modules.forEach((module, rowIndex) => {
    const label = moduleLabel(module, config.textDisplay)
    if (!label) return
    const textX = startMsOf(module) * px + 4
    const textY = headerHeight + rowIndex * config.cellHeight + config.cellHeight / 2
    surface.text(label, textX, textY, {
      fill: LABEL_INK,
      fontSize,
      fontFamily: LABEL_FONT_FAMILY,
      halo: LABEL_HALO,
      haloWidth: LABEL_HALO_WIDTH
    })
  })
}

/** The animated fill: how far each module has progressed at `currentFrame` ms. */
export function drawAnimationOverlay(
  surface: DrawSurface,
  modules: ModuleData[],
  config: RenderConfig,
  currentFrame: number,
  headerHeight: number,
  coloringMode: 'gradual' | 'instant' = 'gradual'
) {
  const px = pxPerMsOf(config)
  const step = Math.max(1, config.scaleMs ?? 100)
  modules.forEach((module, row) => {
    const start = startMsOf(module)
    const duration = durationMsOf(module)
    if (duration <= 0 || currentFrame < start) return
    const elapsed = currentFrame - start
    let filledMs = Math.min(duration, elapsed)
    if (coloringMode === 'instant') {
      filledMs = Math.min(duration, Math.ceil(elapsed / step) * step)
    }
    if (filledMs <= 0) return
    const y = headerHeight + row * config.cellHeight
    const color = module.color || config.defaultFillColor
    surface.rect(start * px, y, filledMs * px, config.cellHeight, { fill: hexToRgba(color, 0.8) })
    surface.rect(start * px + 0.5, y + 0.5, filledMs * px - 1, config.cellHeight - 1, {
      stroke: color,
      lineWidth: 0.5
    })
  })
}

/** Interaction chrome, so it stays canvas-only and out of every export. */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  mouseX: number,
  mouseY: number,
  canvasWidth: number,
  canvasHeight: number
) {
  if (mouseX < 0 || mouseY < 0) return
  ctx.save()
  ctx.strokeStyle = '#ff0000'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.7
  ctx.setLineDash([5, 5])
  ctx.beginPath(); ctx.moveTo(mouseX, 0); ctx.lineTo(mouseX, canvasHeight); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(0, mouseY); ctx.lineTo(canvasWidth, mouseY); ctx.stroke()
  ctx.restore()
}

export interface RenderFrameOptions {
  modules: ModuleData[]
  config: RenderConfig
  width: number
  height: number
  /** Playback position in milliseconds. */
  currentFrame: number
  coloringMode?: 'gradual' | 'instant'
  headerHeight?: number
}

function paintFrame(surface: DrawSurface, options: RenderFrameOptions) {
  const {
    modules, config, width, height, currentFrame,
    coloringMode = 'gradual', headerHeight = HEADER_HEIGHT
  } = options

  surface.rect(0, 0, width, height, { fill: config.backgroundColor })
  drawGrid(surface, width, height, config, headerHeight)
  drawRuler(surface, width, height, config, headerHeight)

  if (modules.length > 0) {
    drawModuleTracksAligned(surface, modules, config, headerHeight)
    if (config.showDependencies !== false) {
      drawDependencyLinks(surface, modules, config, headerHeight)
    }
    if (currentFrame > 0) {
      drawAnimationOverlay(surface, modules, config, currentFrame, headerHeight, coloringMode)
    }
    drawModuleLabels(surface, modules, config, headerHeight)
  }
}

/** Draw one complete frame of the chart onto a 2D canvas context. */
export function renderTimingFrame(ctx: CanvasRenderingContext2D, options: RenderFrameOptions) {
  paintFrame(new CanvasSurface(ctx), options)
}

/** Render the chart as standalone SVG markup, for embedding in the PDF report. */
export function renderTimingFrameSvg(options: RenderFrameOptions): string {
  const surface = new SvgSurface(options.width, options.height)
  paintFrame(surface, options)
  return surface.toSvg()
}

/** Re-exported for the stage progress bars in the parameter table. */
export function actionStartTimes(group: ModuleData[]): number[] {
  return computeActionStartTimes(group)
}
