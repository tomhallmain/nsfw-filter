/**
 * Pull classifiable image URLs out of a CSS `background-image` value.
 *
 * A value can hold several comma-separated layers, and a layer can be a
 * gradient, an `image-set()`, or a `url()`. This scans for `url(` tokens
 * directly rather than splitting the value into layers, which avoids having to
 * balance the commas inside `linear-gradient(to top, rgb(0, 0, 0) 0%, ...)`;
 * gradients carry no `url(` token to confuse the scan.
 */

/**
 * Schemes the offscreen document cannot fetch. `blob:` belongs here for the
 * reason given on `isCrossContextBlobUrl`: the URL only resolves inside the
 * context that minted it.
 */
const UNFETCHABLE = /^(?:data|blob|about|javascript|chrome|chrome-extension|moz-extension|filesystem):/i

/** Every `url()` target in a CSS value, in source order, quotes and escapes resolved. */
const readUrlTokens = (value: string): string[] => {
  const urls: string[] = []
  let cursor = 0

  while (cursor < value.length) {
    const open = value.indexOf('url(', cursor)
    if (open === -1) break

    // `url(` has to start a function token, not end an identifier such as
    // `-webkit-image-url(`, which is a different function entirely.
    const preceding = open === 0 ? '' : value[open - 1]
    if (/[A-Za-z0-9_-]/.test(preceding)) {
      cursor = open + 4
      continue
    }

    let index = open + 4
    while (index < value.length && /\s/.test(value[index])) index++

    const quote = value[index]
    let raw = ''

    if (quote === '"' || quote === "'") {
      index++
      while (index < value.length && value[index] !== quote) {
        if (value[index] === '\\') index++
        if (index < value.length) raw += value[index]
        index++
      }
      index++
    } else {
      while (index < value.length && value[index] !== ')') {
        raw += value[index]
        index++
      }
      raw = raw.trim()
    }

    const close = value.indexOf(')', index)
    cursor = close === -1 ? value.length : close + 1

    if (raw.length > 0) urls.push(raw)
  }

  return urls
}

/**
 * Fetchable URLs from a `background-image` value, deduplicated, in source
 * order. Values read off `getComputedStyle` are already absolute; an inline
 * value read off `element.style` may not be, so relative URLs are resolved
 * against `base`.
 */
export const extractBackgroundUrls = (cssValue: string, base?: string): string[] => {
  if (typeof cssValue !== 'string' || cssValue.length === 0) return []
  if (cssValue === 'none') return []

  const seen = new Set<string>()
  const urls: string[] = []

  for (const token of readUrlTokens(cssValue)) {
    if (UNFETCHABLE.test(token)) continue

    let resolved = token
    if (typeof base === 'string' && base.length > 0) {
      try {
        resolved = new URL(token, base).href
      } catch {
        continue
      }
    }

    if (seen.has(resolved)) continue
    seen.add(resolved)
    urls.push(resolved)
  }

  return urls
}

/**
 * The single URL a background-backed element is classified on. The first
 * fetchable layer is the one painted on top, so it is the one a viewer sees
 * first. An `image-set()` contributes its first candidate, which need not be
 * the density the browser actually picked -- close enough to classify, since
 * the candidates are the same picture at different resolutions.
 */
export const extractBackgroundUrl = (cssValue: string, base?: string): string | undefined =>
  extractBackgroundUrls(cssValue, base)[0]
