import {
  OffscreenClassifyResponse
} from '../utils/messages'

import { ClassificationResult, visibleResult } from './classifier/ClassificationResult'
import { ClassifierSettings, IUrlClassifier, MediaType } from './classifier/MediaClassifier'
import { ensureOffscreenDocument, markOffscreenUnhealthy } from './offscreenLifecycle'
import { postToOffscreen, sendToOffscreen } from './offscreenMessaging'

// Budgets for unwedging a document that has stopped answering, not for
// policing latency: both sit above the offscreen document's own worst case,
// which for dynamic media is a 45s sampling budget plus whatever is queued
// ahead of it. Timing out early would fail media that was still being worked
// on, so these only fire when something is genuinely stuck.
const PREDICT_TIMEOUT_IMAGE_MS = 20000
const PREDICT_TIMEOUT_DYNAMIC_MS = 60000

/**
 * Service-worker proxy for the MediaClassifier that runs in the offscreen document.
 */
export class OffscreenModel implements IUrlClassifier {
  private lastSettings: ClassifierSettings | undefined

  public async predict (url: string, mediaType: MediaType = 'image'): Promise<ClassificationResult> {
    const created = await ensureOffscreenDocument()
    if (created && this.lastSettings !== undefined) {
      postToOffscreen({ target: 'offscreen', type: 'SET_SETTINGS', settings: this.lastSettings })
    }

    const response = await this.classify(url, mediaType)

    if (typeof response.error === 'string' && response.error.length > 0) {
      throw new Error(response.error)
    }

    if (!response.result) return visibleResult()

    return {
      blocked: true,
      topNsfwClass: response.topNsfwClass,
      borderColor: response.borderColor,
      score: response.score
    }
  }

  public setSettings (settings: ClassifierSettings): void {
    this.lastSettings = settings
    postToOffscreen({ target: 'offscreen', type: 'SET_SETTINGS', settings })
  }

  private async classify (url: string, mediaType: MediaType): Promise<OffscreenClassifyResponse> {
    const timeoutMs = mediaType === 'image' ? PREDICT_TIMEOUT_IMAGE_MS : PREDICT_TIMEOUT_DYNAMIC_MS

    try {
      return await sendToOffscreen<OffscreenClassifyResponse>(
        { target: 'offscreen', type: 'CLASSIFY', url, mediaType },
        timeoutMs
      )
    } catch (error) {
      // The round trip failed rather than the classification: the document is
      // unreachable or hung, so make the next call re-check it.
      markOffscreenUnhealthy()
      throw error
    }
  }
}
