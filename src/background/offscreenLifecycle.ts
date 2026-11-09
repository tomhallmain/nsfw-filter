import { OffscreenPingResponse } from '../utils/messages'

import { sendToOffscreen } from './offscreenMessaging'

export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen.html'
const PING_TIMEOUT_MS = 2000
const HEALTH_CHECK_INTERVAL_MS = 30000

type OffscreenApi = {
  createDocument: (parameters: {
    url: string
    reasons: string[]
    justification: string
  }) => Promise<void>
  closeDocument?: () => Promise<void>
  hasDocument?: () => Promise<boolean>
}

type RuntimeWithContexts = {
  getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>
}

const getOffscreenApi = (): OffscreenApi => (chrome as unknown as { offscreen: OffscreenApi }).offscreen

let ensuring: Promise<boolean> | null = null
let lastHealthyAt = 0

export const hasOffscreenDocument = async (): Promise<boolean> => {
  const runtime = chrome.runtime as unknown as RuntimeWithContexts
  if (typeof runtime.getContexts === 'function') {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    return contexts.length > 0
  }

  const offscreen = getOffscreenApi()
  if (offscreen.hasDocument !== undefined) {
    return await offscreen.hasDocument()
  }

  return false
}

/**
 * Forces the next `ensureOffscreenDocument` call to re-check liveness.
 * Call this when a request to the document fails in a way that suggests the
 * document itself is gone or wedged, rather than the classification failing.
 */
export const markOffscreenUnhealthy = (): void => {
  lastHealthyAt = 0
}

/**
 * Resolves once a responsive offscreen document exists, and reports whether
 * this call is what created it -- a fresh document starts at its own default
 * settings, so the caller owns pushing the real ones before classifying.
 */
export const ensureOffscreenDocument = async (): Promise<boolean> => {
  if (ensuring !== null) return await ensuring

  ensuring = ensureResponsiveDocument()
  try {
    return await ensuring
  } finally {
    ensuring = null
  }
}

const ensureResponsiveDocument = async (): Promise<boolean> => {
  if (await hasOffscreenDocument()) {
    if (await isOffscreenResponsive()) return false

    // Present but not answering: close it so the create below replaces it,
    // rather than leaving a wedged document in place.
    await closeOffscreenDocument()
  }

  await getOffscreenApi().createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['DOM_SCRAPING'],
    justification: 'Load images/videos into DOM elements and run the NSFW classification model.'
  })

  lastHealthyAt = Date.now()
  return true
}

/**
 * Throttled: this runs on the path of every prediction, and a round trip per
 * item would cost more than the wedge it is looking for. A service-worker
 * restart resets the interval, so the first prediction after each wake pays
 * for one real check.
 */
const isOffscreenResponsive = async (): Promise<boolean> => {
  if (Date.now() - lastHealthyAt < HEALTH_CHECK_INTERVAL_MS) return true

  try {
    await sendToOffscreen<OffscreenPingResponse>({ target: 'offscreen', type: 'PING' }, PING_TIMEOUT_MS)
    lastHealthyAt = Date.now()
    return true
  } catch {
    return false
  }
}

const closeOffscreenDocument = async (): Promise<void> => {
  const offscreen = getOffscreenApi()
  if (offscreen.closeDocument === undefined) return

  try {
    await offscreen.closeDocument()
  } catch {
    // Already gone, which is the state we wanted.
  }
}
