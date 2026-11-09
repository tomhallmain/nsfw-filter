import { Logger } from '../utils/Logger'
import {
  OffscreenClassifyResponse,
  OffscreenPingResponse,
  OffscreenRequest
} from '../utils/messages'

import { AutoDlSession, encodePngDataUrl, postPairToBackground } from './classifier/autoDlFrames'
import { ClassifierHost } from './classifier/classifierHost'
import { createClassifier } from './classifier/createClassifier'
import { ClassifierSettings } from './classifier/MediaClassifier'

const DEFAULT_SETTINGS: ClassifierSettings = {
  filterStrictness: 55,
  logging: false,
  classifierBackend: 'nsfwjs'
}

const logger = new Logger()
// Module-level so the per-session pair budget survives classifier rebuilds.
const autoDl = new AutoDlSession(encodePngDataUrl, postPairToBackground, logger)
const host = new ClassifierHost(
  (backend, classifierLogger, settings) => createClassifier(backend, classifierLogger, settings, autoDl),
  logger,
  DEFAULT_SETTINGS
)

chrome.runtime.onMessage.addListener((
  message: OffscreenRequest,
  _sender,
  sendResponse: (response: OffscreenClassifyResponse | OffscreenPingResponse) => void
) => {
  if (message?.target !== 'offscreen') return

  if (message.type === 'PING') {
    // Answered without touching the classifier: this reports that the
    // document's script context still runs. A document whose model failed
    // must answer too, so that it gets rebuilt in place rather than the whole
    // document being torn down and reloaded.
    sendResponse({ alive: true })
    return
  }

  if (message.type === 'SET_SETTINGS') {
    host.ensure(message.settings)
      .then(() => undefined)
      .catch(error => {
        console.error('[NSFW-Filter] SET_SETTINGS failed:', error)
      })
    return
  }

  if (message.type === 'CLASSIFY') {
    host.classify(message.url, message.mediaType)
      .then(result => sendResponse({
        result: result.blocked,
        topNsfwClass: result.topNsfwClass,
        borderColor: result.borderColor,
        score: result.score
      }))
      .catch((error: Error) => sendResponse({
        result: false,
        error: error?.message ?? String(error)
      }))

    return true
  }
})
