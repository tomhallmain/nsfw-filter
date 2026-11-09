import { ClassificationResult, ClassifierSettings, MediaType } from '../background/classifier/MediaClassifier'

export class PredictionRequest {
  public readonly url: string
  public readonly mediaType: MediaType
  public readonly type?: string // @DOCS Chrome internal usage
  public reconectTimer?: number
  private _reconectCount: number

  constructor (url: string, mediaType: MediaType = 'image') {
    this.url = url
    this.mediaType = mediaType
    this._reconectCount = 0
  }

  public clearTimer (): number {
    this._reconectCount++
    clearTimeout(this.reconectTimer)
    return this._reconectCount
  }
}

export class PredictionResponse {
  public readonly result: boolean
  /** True when no verdict was reached. `result` is then a fail-open default, not a classification. */
  public readonly failed: boolean
  public readonly message: string
  public readonly url: string
  public readonly mediaType?: MediaType
  public readonly topNsfwClass?: string
  public readonly borderColor?: string
  public readonly score?: number

  constructor (
    result: boolean,
    url: string,
    error?: string,
    mediaType?: MediaType,
    topNsfwClass?: string,
    borderColor?: string,
    score?: number
  ) {
    const failed = typeof error === 'string' && error.length > 0
    const message = failed
      ? `Prediction result is ${result} for media ${url}, error: ${error}`
      : `Prediction result is ${result} for media ${url}`

    this.url = url
    this.result = result
    this.failed = failed
    this.message = message
    this.mediaType = mediaType
    this.topNsfwClass = topNsfwClass
    this.borderColor = borderColor
    this.score = score
  }

  public static fromClassification (
    classification: ClassificationResult,
    url: string,
    mediaType?: MediaType
  ): PredictionResponse {
    return new PredictionResponse(
      classification.blocked,
      url,
      classification.error,
      mediaType,
      classification.topNsfwClass,
      classification.borderColor,
      classification.score
    )
  }
}

// Right-click "unhide" flow: content reports whether the cursor is over a
// filtered image; the service worker shows the menu item only then.
export const CONTEXT_TARGET = 'NSFW_FILTER_CONTEXT_TARGET'
export const UNHIDE_IMAGE = 'NSFW_FILTER_UNHIDE'

/**
 * Popup -> content script, for the active tab only: drop the page-wide sweep
 * and show what the classifier individually cleared. Scoped to the current page
 * view, so it leaves the stored setting alone.
 */
export const REVEAL_PAGE_SENSITIVE = 'NSFW_FILTER_REVEAL_PAGE_SENSITIVE'

export type ContextTargetMessage = {
  type: typeof CONTEXT_TARGET
  filtered: boolean
}

export type UnhideImageMessage = {
  type: typeof UNHIDE_IMAGE
}

export type RevealPageSensitiveMessage = {
  type: typeof REVEAL_PAGE_SENSITIVE
}

export type RevealPageSensitiveResponse = {
  revealed: number
}

/** RPC messages addressed to the offscreen document. */
export type OffscreenRequest =
  | { target: 'offscreen', type: 'CLASSIFY', url: string, mediaType: MediaType }
  | { target: 'offscreen', type: 'SET_SETTINGS', settings: ClassifierSettings }
  | { target: 'offscreen', type: 'PING' }

/**
 * Answered without waiting on the model: this reports that the document's
 * script context is responsive, not that it can classify.
 */
export type OffscreenPingResponse = {
  alive: true
}

export type OffscreenClassifyResponse = {
  result: boolean
  topNsfwClass?: string
  borderColor?: string
  score?: number
  error?: string
}

/**
 * Offscreen document -> service worker: save these files under the user's
 * Downloads directory. The offscreen document can't call chrome.downloads.
 */
export const AUTO_DL_FRAME_PAIR = 'NSFW_FILTER_AUTO_DL_FRAME_PAIR'

export type AutoDlFile = {
  /** Relative to the Downloads directory. */
  filename: string
  dataUrl: string
}

export type AutoDlFramePairMessage = {
  target: 'background'
  type: typeof AUTO_DL_FRAME_PAIR
  files: AutoDlFile[]
}

export const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}
