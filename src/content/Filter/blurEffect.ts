/**
 * Map classification certainty to CSS blur / blackout, with optional
 * category-colored tint on the existing border frame (images only).
 */

const FRAME_ATTR = 'data-nsfw-filter-frame'
const TINT_ATTR = 'data-nsfw-filter-tint'

/**
 * Applied to media the classifier cleared but that got swept in once the page
 * as a whole tripped. Fixed rather than scaled by certainty, because a cleared
 * item has no positive score to scale from, and milder than the user's
 * configured effect so a precaution stays visibly distinct from a verdict.
 */
export const SWEEP_FILTER = 'blur(16px)'

/** Mild blur at low certainty → near-blackout at high certainty. */
export const blurFilterForScore = (score?: number): string => {
  const certainty = clamp01(typeof score === 'number' ? score : 0.6)
  const blurPx = Math.round(12 + certainty * 48) // 12..60
  const brightness = round3(1 - certainty * 0.6) // 1..0.4
  return `blur(${blurPx}px) brightness(${brightness})`
}

/**
 * Colored wash over blurred media. Uses the border frame when present;
 * otherwise creates the same wrapper images already use for outlines.
 */
export const applyClassTint = (
  media: HTMLElement,
  borderColor?: string,
  score?: number
): void => {
  clearClassTint(media)

  if (typeof borderColor !== 'string' || borderColor.length === 0) return

  const certainty = clamp01(typeof score === 'number' ? score : 0.6)
  const opacity = round3(certainty * 0.55)
  if (opacity <= 0) return

  const frame = ensureBorderFrame(media)
  frame.style.position = 'relative'

  const tint = document.createElement('span')
  tint.setAttribute(TINT_ATTR, '1')
  tint.style.position = 'absolute'
  tint.style.top = '0'
  tint.style.right = '0'
  tint.style.bottom = '0'
  tint.style.left = '0'
  tint.style.background = borderColor
  tint.style.opacity = String(opacity)
  tint.style.pointerEvents = 'none'
  tint.style.zIndex = '1'
  frame.appendChild(tint)
}

export const clearClassTint = (media: HTMLElement): void => {
  const parent = media.parentElement
  if (parent === null || parent.getAttribute(FRAME_ATTR) !== '1') return

  parent.querySelectorAll(`[${TINT_ATTR}="1"]`).forEach(node => node.remove())
}

const ensureBorderFrame = (media: HTMLElement): HTMLElement => {
  const parent = media.parentElement
  if (parent !== null && parent.getAttribute(FRAME_ATTR) === '1') {
    return parent
  }

  const frame = document.createElement('span')
  frame.setAttribute(FRAME_ATTR, '1')
  frame.style.display = 'inline-block'
  frame.style.lineHeight = '0'
  frame.style.maxWidth = '100%'
  frame.style.verticalAlign = 'middle'

  if (parent !== null) {
    parent.insertBefore(frame, media)
  }
  frame.appendChild(media)
  return frame
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const round3 = (value: number): number => Math.round(value * 1000) / 1000
