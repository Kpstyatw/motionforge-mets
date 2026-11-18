import { TimeConfig, ExcelLayoutConfig, GanttConfig } from '@/types'

/**
 * Time scale & precision.
 *
 * Everything in the scheduling engine is an integer number of milliseconds.
 * `precisionMs` is the quantum: 1 means true millisecond accuracy. Floating
 * point never enters the schedule, so a chain of 50 dependent actions cannot
 * accumulate drift.
 */

export const MIN_PRECISION_MS = 1
export const MAX_SCALE_MS = 3_600_000

export const SCALE_CHOICES = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500,
  1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000, 600_000
] as const

export const PRECISION_CHOICES = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000] as const

export const DEFAULT_TIME_CONFIG: TimeConfig = {
  scaleMs: 100,
  precisionMs: 1,
  displayUnit: 'ms'
}

export const DEFAULT_EXCEL_LAYOUT: ExcelLayoutConfig = {
  rowHeight: 22,
  headerHeight: 30,
  columnWidths: {
    code: 14,
    id: 12,
    level: 8,
    module: 20,
    action: 24,
    stage: 10,
    startMs: 14,
    anchorMs: 16,
    durationMs: 14,
    endMs: 14,
    scale: 12,
    mode: 12,
    predecessors: 34,
    color: 12
  },
  matrixCellWidth: 3.5,
  matrixRowHeight: 18,
  matrixStepMs: 0,
  matrixLabelEvery: 0,
  fontSize: 10
}

export const DEFAULT_GANTT_CONFIG: GanttConfig = {
  pxPerMs: 0.35,
  rowHeight: 34,
  showDependencies: true,
  showSummaries: true
}

export function normalizeTimeConfig(input?: Partial<TimeConfig> | null): TimeConfig {
  const raw = { ...DEFAULT_TIME_CONFIG, ...(input ?? {}) }
  const precisionMs = Math.max(
    MIN_PRECISION_MS,
    Math.min(MAX_SCALE_MS, Math.round(Number(raw.precisionMs) || MIN_PRECISION_MS))
  )
  // A scale finer than the precision would make ruler ticks unrepresentable.
  const scaleMs = Math.max(
    precisionMs,
    Math.min(MAX_SCALE_MS, Math.round(Number(raw.scaleMs) || DEFAULT_TIME_CONFIG.scaleMs))
  )
  return {
    scaleMs,
    precisionMs,
    displayUnit: raw.displayUnit === 's' || raw.displayUnit === 'min' ? raw.displayUnit : 'ms'
  }
}

/** Snap an arbitrary millisecond value onto the configured quantum. */
export function quantize(ms: number, precisionMs: number, mode: 'floor' | 'ceil' | 'round' = 'round'): number {
  const p = Math.max(1, Math.round(precisionMs))
  const value = Number.isFinite(ms) ? ms : 0
  switch (mode) {
    case 'floor':
      return Math.floor(value / p) * p
    case 'ceil':
      return Math.ceil(value / p) * p
    default:
      return Math.round(value / p) * p
  }
}

/** Number of decimals needed to display a value at the configured precision. */
export function precisionDecimals(precisionMs: number): number {
  if (precisionMs >= 1000) return 0
  if (precisionMs >= 100) return 1
  if (precisionMs >= 10) return 2
  return 3
}

/** Compact label for rulers/tooltips: "1.234s" / "12ms" / "02:03". */
export function formatTime(ms: number, config: TimeConfig): string {
  const value = Math.max(0, Math.round(ms))
  if (config.displayUnit === 'min') {
    const minutes = Math.floor(value / 60_000)
    const seconds = Math.floor((value % 60_000) / 1000)
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }
  if (config.displayUnit === 's' || value >= 10_000) {
    const decimals = Math.min(3, precisionDecimals(config.precisionMs))
    return `${(value / 1000).toFixed(decimals)}s`
  }
  return `${value}ms`
}

/**
 * Parse what a user types into an absolute millisecond value.
 * Accepts `1234`, `1234ms`, `1.234s`, `1s234`, `01:23.456`, `2m 3s`.
 */
export function parseTimeInput(input: string): number | null {
  const text = input.trim().toLowerCase()
  if (!text) return null

  // mm:ss.mmm or hh:mm:ss.mmm
  if (text.includes(':')) {
    const parts = text.split(':').map(p => Number(p))
    if (parts.some(p => !Number.isFinite(p))) return null
    let seconds = 0
    for (const part of parts) seconds = seconds * 60 + part
    return Math.round(seconds * 1000)
  }

  const match = text.match(/^(?:(\d+(?:\.\d+)?)\s*m(?:in)?\b)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?\b)?\s*(?:(\d+(?:\.\d+)?)\s*ms\b)?\s*(?:(\d+(?:\.\d+)?))?$/)
  if (!match) return null
  const [, minutes, seconds, millis, bare] = match
  if (!minutes && !seconds && !millis && bare === undefined) return null
  const total =
    (minutes ? Number(minutes) * 60_000 : 0) +
    (seconds ? Number(seconds) * 1000 : 0) +
    (millis ? Number(millis) : 0) +
    (bare !== undefined ? Number(bare) : 0)
  return Number.isFinite(total) ? Math.round(total) : null
}

/** Human-readable time for an elapsed duration, used in dialogs. */
export function describeDuration(ms: number): string {
  const v = Math.max(0, Math.round(ms))
  if (v < 1000) return `${v} ms`
  if (v < 60_000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 3)} s`
  const minutes = Math.floor(v / 60_000)
  const seconds = (v % 60_000) / 1000
  return `${minutes} min ${seconds.toFixed(3)} s`
}

export function timeToPx(ms: number, pxPerMs: number): number {
  return ms * pxPerMs
}

export function pxToTime(px: number, pxPerMs: number): number {
  return pxPerMs > 0 ? px / pxPerMs : 0
}

/**
 * Ruler ticks, thinned so labels never collide. `pxPerMs` and `minLabelSpacing`
 * are both in pixels, so the step is a whole number of scale divisions.
 */
export function rulerTicks(
  totalMs: number,
  scaleMs: number,
  pxPerMs: number,
  minLabelSpacing = 64
): number[] {
  if (totalMs <= 0 || scaleMs <= 0 || pxPerMs <= 0) return [0]
  const divisions = Math.max(1, Math.ceil(minLabelSpacing / (scaleMs * pxPerMs)))
  const step = divisions * scaleMs
  const ticks: number[] = []
  const padded = totalMs + scaleMs * 2
  for (let t = 0; t <= padded; t += step) ticks.push(t)
  return ticks
}
