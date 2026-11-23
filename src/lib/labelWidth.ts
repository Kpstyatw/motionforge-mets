/**
 * Shared label-column sizing helpers.
 *
 * The Gantt flow column, the left hierarchy sidebar and the resource swim-lane
 * column all show names that can be arbitrarily long (Chinese/CJK especially).
 * We estimate rendered text width from glyph classes so these columns can
 * auto-size instead of ellipsising names away. CJK/full-width glyphs take about
 * one em, latin/digits about 0.58 em — close enough at these small font sizes,
 * with the per-call padding acting as a safety margin.
 */

export function measureTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32
    width += code > 0x2e80 ? fontSize : fontSize * 0.58
  }
  return width
}

/** Truncate to a pixel width with a trailing ellipsis, CJK-aware. */
export function fitTextToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (measureTextWidth(text, fontSize) <= maxWidth) return text
  const ell = '…'
  const ellW = measureTextWidth(ell, fontSize)
  let out = ''
  for (const ch of text) {
    if (measureTextWidth(out + ch, fontSize) + ellW > maxWidth) break
    out += ch
  }
  return out + ell
}

/**
 * Label drawn inside a resource claim bar. Always the ACTION NAME (never the
 * numeric code); when the bar is too narrow the name is truncated with an
 * ellipsis so it stays inside the bar. The full name is shown in the hover
 * tooltip. `cycleTag` (e.g. "C2·") is kept in front when present.
 */
export function claimBarLabel(name: string, cycleTag: string, barWidthPx: number, fontSize = 10): string {
  const available = Math.max(0, barWidthPx - 12 - measureTextWidth(cycleTag, fontSize))
  return cycleTag + fitTextToWidth(name, available, fontSize)
}

export interface LabelSizing {
  /** Name text to size against. */
  name: string
  /** Tree depth used for left indentation. */
  depth?: number
  /** Extra fixed pixels for badges / codes / icons next to the name. */
  extras?: number
  /** Font size of the name text. */
  fontSize?: number
}

/** Compute a clamped label-column width from a list of rows. */
export function computeLabelWidth(
  items: LabelSizing[],
  opts: { min: number; max: number; indentPerDepth?: number; basePadding?: number }
): number {
  const indentPerDepth = opts.indentPerDepth ?? 14
  const basePadding = opts.basePadding ?? 60
  let widest = opts.min
  for (const item of items) {
    const indent = (item.depth ?? 0) * indentPerDepth
    const name = measureTextWidth(item.name || '', item.fontSize ?? 12)
    widest = Math.max(widest, indent + (item.extras ?? 0) + name + basePadding)
  }
  return Math.min(opts.max, Math.ceil(widest))
}
