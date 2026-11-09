/**
 * Cross-origin media loading for the offscreen document.
 *
 * Loading a remote URL straight into an <img>/<video> and drawing it to a canvas
 * taints the canvas whenever the server omits `Access-Control-Allow-Origin`, so
 * `getImageData` throws a SecurityError. Extension pages may still fetch those
 * bytes directly under `host_permissions`, and a blob URL is same-origin, so
 * decoding through one keeps the canvas readable regardless of CORS headers.
 *
 * A caller that falls back to the direct `url` because this returns null (fetch
 * failed, blocked, or timed out) is back to the tainted-canvas risk above for
 * that item. Give `timeoutMs` its own generous budget rather than sharing it
 * with an unrelated wait -- a premature abort here is what triggers that
 * fallback, not the size of the media itself.
 *
 * Known remaining gaps, not fixed by the timeout budgeting above:
 * - Videos over MAX_VIDEO_BLOB_BYTES are never blob-fetched at all (see
 *   below), so they always take the tainted-canvas risk on a non-CORS host,
 *   not just occasionally.
 * - A site that rejects a bare `fetch()` (e.g. Referer-based hotlink
 *   protection) while still allowing normal <img>/<video> tag loads will
 *   also fall back every time. Fixing that would mean passing the source
 *   tab's URL down as a `referrer` on this fetch, which isn't wired through
 *   the message-passing layer between the service worker and this document.
 */

/** Videos larger than this stream from the network instead of a blob -- see the gap this leaves, noted above. */
export const MAX_VIDEO_BLOB_BYTES = 64 * 1024 * 1024

/** GIFs larger than this are classified from a single frame rather than sampled. */
export const MAX_GIF_BLOB_BYTES = 32 * 1024 * 1024

export type BlobSource = {
  objectUrl: string
  revoke: () => void
}

/**
 * Media bytes, or null when they cannot be fetched within `timeoutMs` or
 * exceed `maxBytes`. The abort signal covers the body as well as the headers,
 * so a server that stalls mid-body cannot hold the caller open.
 */
export const fetchMediaBlob = async (
  url: string,
  timeoutMs: number,
  maxBytes?: number
): Promise<Blob | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal })
    if (!response.ok) return null

    if (maxBytes !== undefined && exceedsSizeLimit(response, maxBytes)) {
      controller.abort()
      return null
    }

    const blob = await response.blob()
    // Content-Length is absent for chunked transfers, so the check above can
    // miss an oversized body; re-check the decoded blob before keeping it.
    if (maxBytes !== undefined && blob.size > maxBytes) return null

    return blob
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves to null when the bytes cannot be fetched; callers fall back to `url`. */
export const fetchBlobSource = async (
  url: string,
  timeoutMs: number,
  maxBytes?: number
): Promise<BlobSource | null> => {
  // These already load into a canvas without tainting it, so wrapping them in
  // a second blob buys nothing.
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome-extension:')) {
    return null
  }

  const blob = await fetchMediaBlob(url, timeoutMs, maxBytes)
  if (blob === null) return null

  const objectUrl = URL.createObjectURL(blob)
  return {
    objectUrl,
    revoke: () => URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Decoded image whose pixels stay readable from a canvas.
 * `fetchTimeoutMs` and `decodeTimeoutMs` are independent budgets: decoding a
 * same-origin blob: URL is fast and local, while the fetch is a real network
 * request and needs its own room to complete instead of eating into it.
 */
export const loadImageElement = async (
  url: string,
  fetchTimeoutMs: number,
  decodeTimeoutMs: number,
  size?: number
): Promise<HTMLImageElement> => {
  const source = await fetchBlobSource(url, fetchTimeoutMs)

  try {
    return await decodeImageElement(source?.objectUrl ?? url, decodeTimeoutMs, size)
  } finally {
    source?.revoke()
  }
}

const decodeImageElement = async (
  src: string,
  timeoutMs: number,
  size?: number
): Promise<HTMLImageElement> => {
  const image = size === undefined ? new Image() : new Image(size, size)
  image.crossOrigin = 'anonymous'

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Image load timeout ${src}`)), timeoutMs)
    image.onload = () => { clearTimeout(timer); resolve(image) }
    image.onerror = () => { clearTimeout(timer); reject(new Error(`Unable to load image: ${src}`)) }
    image.src = src
  })
}

const exceedsSizeLimit = (response: Response, maxBytes: number): boolean => {
  const header = response.headers.get('content-length')
  if (header === null) return false

  const contentLength = Number(header)
  return Number.isFinite(contentLength) && contentLength > maxBytes
}
