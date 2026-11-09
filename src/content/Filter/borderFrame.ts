/**
 * Apply a class-color ring on a wrapper so CSS `filter` on the media
 * (blur/grayscale) does not also blur the border.
 */

const FRAME_ATTR = 'data-nsfw-filter-frame'

export const applyClassBorder = (
  media: HTMLElement,
  borderColor?: string
): void => {
  if (typeof borderColor !== 'string' || borderColor.length === 0) {
    clearClassBorder(media)
    return
  }

  const frame = ensureBorderFrame(media)
  frame.style.outline = `4px solid ${borderColor}`
  frame.style.outlineOffset = '2px'
}

export const clearClassBorder = (media: HTMLElement): void => {
  const parent = media.parentElement
  if (parent === null || parent.getAttribute(FRAME_ATTR) !== '1') {
    media.style.outline = ''
    media.style.outlineOffset = ''
    return
  }

  parent.style.outline = ''
  parent.style.outlineOffset = ''
}

/**
 * Outline on the element itself — safe for <video> (no DOM reparenting).
 * May soften under CSS filter blur; still readable with a thicker ring.
 */
export const applyDirectClassBorder = (
  media: HTMLElement,
  borderColor?: string
): void => {
  if (typeof borderColor !== 'string' || borderColor.length === 0) {
    clearDirectClassBorder(media)
    return
  }

  media.style.outline = `5px solid ${borderColor}`
  media.style.outlineOffset = '2px'
}

export const clearDirectClassBorder = (media: HTMLElement): void => {
  media.style.outline = ''
  media.style.outlineOffset = ''
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
