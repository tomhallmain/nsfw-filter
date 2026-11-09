import { createStore } from 'redux'

import { createChromeStore } from '../popup/redux/chrome-storage'
import { rootReducer } from '../popup/redux/reducers'
import { isHostAllowed } from '../utils/allowlist'
import {
  CONTEXT_TARGET,
  REVEAL_PAGE_SENSITIVE,
  RevealPageSensitiveMessage,
  RevealPageSensitiveResponse,
  UNHIDE_IMAGE,
  UnhideImageMessage
} from '../utils/messages'

import { DOMWatcher } from './DOMWatcher/DOMWatcher'
import { BackgroundFilter } from './Filter/BackgroundFilter'
import { ImageFilter } from './Filter/ImageFilter'
import { PageTally } from './Filter/pageSensitivity'
import { VideoFilter } from './Filter/VideoFilter'

/**
 * Smallest box, on either axis, that is treated as a picture rather than an
 * icon or a sprite. Matches ImageFilter's floor for <img>.
 */
const MIN_BACKGROUND_SIZE = 41

/** Any element carrying a background verdict, whichever of its three targets holds it. */
const FILTERED_BACKGROUND = [
  '[data-nsfw-filter-bg-status="nsfw"]',
  '[data-nsfw-filter-bg-before-status="nsfw"]',
  '[data-nsfw-filter-bg-after-status="nsfw"]'
].join(',')

// Wire the right-click "unhide" menu. On every context-menu open we tell the
// service worker whether the cursor is over an image we filtered.
const wireContextMenuUnhide = (imageFilter: ImageFilter, backgroundFilter: BackgroundFilter): void => {
  let lastImage: HTMLImageElement | null = null
  let lastBackground: HTMLElement | null = null

  document.addEventListener('contextmenu', event => {
    // event.target is retargeted to the shadow host when the cursor is over
    // something inside an open shadow tree; the path still starts at the real node.
    const target = event.composedPath()[0] ?? event.target
    lastImage = null
    lastBackground = null

    if (target instanceof HTMLImageElement && target.dataset.nsfwFilterStatus === 'nsfw') {
      lastImage = target
    } else if (target instanceof Element) {
      // The cursor lands on whatever sits over the background -- a caption, a
      // button, the overlay itself -- so the element holding the verdict is
      // the nearest ancestor carrying one.
      lastBackground = target.closest<HTMLElement>(FILTERED_BACKGROUND)
    }

    const filtered = lastImage !== null || lastBackground !== null
    chrome.runtime.sendMessage({ type: CONTEXT_TARGET, filtered }, () => {
      if (chrome.runtime.lastError !== undefined) { /* handled */ }
    })
  }, true)

  chrome.runtime.onMessage.addListener((message: UnhideImageMessage) => {
    if (message?.type !== UNHIDE_IMAGE) return

    if (lastImage !== null) imageFilter.revealImage(lastImage)
    if (lastBackground !== null) backgroundFilter.revealElement(lastBackground)

    lastImage = null
    lastBackground = null
  })
}

// The popup cannot reach the page's DOM, so the reveal arrives as a message
// aimed at the active tab.
const wireRevealSwept = (imageFilter: ImageFilter, backgroundFilter: BackgroundFilter): void => {
  chrome.runtime.onMessage.addListener((
    message: RevealPageSensitiveMessage,
    sender,
    sendResponse: (response: RevealPageSensitiveResponse) => void
  ) => {
    if (message?.type !== REVEAL_PAGE_SENSITIVE) return
    sendResponse({
      revealed: imageFilter.revealSweptImages() + backgroundFilter.revealSweptBackgrounds()
    })
  })
}

const init = (): void => {
  // One tally per page view, shared so blocked video counts toward the same
  // threshold blocked images do.
  const tally = new PageTally()
  const imageFilter = new ImageFilter(tally)
  const backgroundFilter = new BackgroundFilter(tally)

  // Unhide menu must work per-frame (contextmenu does not cross iframes).
  wireContextMenuUnhide(imageFilter, backgroundFilter)

  // Filtering stays top-frame only.
  if (window.self !== window.top) return

  // Top frame only, like the sweep it undoes.
  wireRevealSwept(imageFilter, backgroundFilter)

  const videoFilter = new VideoFilter(tally)
  // A video that can't be classified may take its verdict from a cover image
  // judged after it.
  imageFilter.onFlagged(() => videoFilter.recheckCovers())

  createChromeStore({ createStore })(rootReducer)
    .then(store => {
      const settings = store.getState().settings
      const {
        enabled,
        filterEffect,
        websites,
        interImageAwarenessEnabled,
        interImageAwarenessMinCount,
        interImageAwarenessMinRatio,
        backgroundScanMode
      } = settings

      imageFilter.setSettings({
        filterEffect,
        interImageAwareness: interImageAwarenessEnabled === true
          ? { minCount: interImageAwarenessMinCount, minRatio: interImageAwarenessMinRatio }
          : undefined
      })
      videoFilter.setSettings({ filterEffect })
      backgroundFilter.setSettings({
        filterEffect,
        interImageAwareness: interImageAwarenessEnabled === true
          ? { minCount: interImageAwarenessMinCount, minRatio: interImageAwarenessMinRatio }
          : undefined
      })

      const domWatcher = new DOMWatcher(imageFilter, videoFilter, {
        filter: backgroundFilter,
        mode: backgroundScanMode,
        minSize: MIN_BACKGROUND_SIZE
      })

      const allowed = isHostAllowed(window.location.hostname, websites)
      if (enabled && !allowed) {
        domWatcher.watch()
      }
    })
    .catch(error => {
      console.warn(error)
      imageFilter.setSettings({ filterEffect: 'blur' })
      videoFilter.setSettings({ filterEffect: 'blur' })
      backgroundFilter.setSettings({ filterEffect: 'blur' })
    })
}

init()
