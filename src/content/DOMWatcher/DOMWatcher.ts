// Highly sensitive code, make sure that you know what you're doing
// https://stackoverflow.com/a/39332340/10432429

// @TODO Canvas and SVG
// @TODO <a>

import { IBackgroundFilter } from '../Filter/BackgroundFilter'
import {
  BackgroundScanMode,
  invalidateSelectorCache,
  scanForBackgrounds
} from '../Filter/backgroundScan'
import { IImageFilter } from '../Filter/ImageFilter'
import { IVideoFilter } from '../Filter/VideoFilter'
import { registerShadowRoot, shadowRootOf } from '../shadowRoots'

export type IDOMWatcher = {
  watch: () => void
}

export type BackgroundWatchConfig = {
  filter: IBackgroundFilter
  mode: BackgroundScanMode
  minSize: number
}

const isInShadowTree = (node: Node): boolean => node.getRootNode() instanceof ShadowRoot

export class DOMWatcher implements IDOMWatcher {
  /**
   * Mutation bursts from a page's own framework are continuous, and a scan is
   * far more expensive than the mutation that triggered it, so scans coalesce.
   */
  private static readonly SCAN_DEBOUNCE_MS = 150

  /**
   * Past this many distinct mutated subtrees in one burst, scanning each one
   * costs more than scanning the document once.
   */
  private static readonly MAX_PENDING_ROOTS = 24

  private readonly observer: MutationObserver
  private readonly imageFilter: IImageFilter
  private readonly videoFilter: IVideoFilter
  private readonly background?: BackgroundWatchConfig

  private readonly pendingRoots: Set<Element>
  /** Roots this watcher already observes and listens on. */
  private readonly observedShadowRoots: WeakSet<ShadowRoot>
  private scanTimer?: number
  private scanWholeDocument: boolean

  constructor (imageFilter: IImageFilter, videoFilter: IVideoFilter, background?: BackgroundWatchConfig) {
    this.imageFilter = imageFilter
    this.videoFilter = videoFilter
    this.background = background?.mode === 'off' ? undefined : background
    this.pendingRoots = new Set()
    this.observedShadowRoots = new WeakSet()
    this.scanWholeDocument = false
    this.observer = new MutationObserver(this.callback.bind(this))
  }

  public watch (): void {
    this.observer.observe(document, this.getConfig())

    // Watching starts only once settings have loaded, and a MutationObserver
    // reports nothing about media the parser already placed. Sweeping after
    // observing (never before) means anything arriving mid-sweep is still
    // caught by the observer; a second look at the same element is a no-op.
    this.findAndCheckAllMedia(document.documentElement)
    this.queueBackgroundScan(document.documentElement)
    this.discoverShadowRoots(document.documentElement)

    // The browser can switch an image's displayed source with no DOM change
    // (srcset under a new viewport width, a lazy image's first load), so every
    // load is re-examined. `load` and `error` do not bubble; capture sees them.
    document.addEventListener('load', this.onMediaLoad, true)
    document.addEventListener('error', this.onMediaLoad, true)
  }

  private readonly onMediaLoad = (event: Event): void => {
    const target = event.target
    if (target instanceof HTMLImageElement) this.imageFilter.analyzeImage(target, false)
  }

  private callback (mutationsList: MutationRecord[]): void {
    for (let i = 0; i < mutationsList.length; i++) {
      const mutation = mutationsList[i]
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // A node added directly under a shadow root reports the root itself.
        const target = mutation.target as Element | ShadowRoot
        this.findAndCheckAllMedia(target)
        if (target instanceof Element) this.queueBackgroundScan(target)

        for (let j = 0; j < mutation.addedNodes.length; j++) {
          const node = mutation.addedNodes[j]
          if (node.nodeType === Node.ELEMENT_NODE) {
            this.findAndCheckAllMedia(node as Element)
            this.checkSingleNode(node as Element)
            this.noteStyleSheetNode(node as Element)
            this.discoverShadowRoots(node as Element)
          }
        }
      } else if (mutation.type === 'attributes') {
        this.checkAttributeMutation(mutation)
      }
    }
  }

  private findAndCheckAllMedia (root: Element | ShadowRoot): void {
    const images = root instanceof Element ? root.getElementsByTagName('img') : root.querySelectorAll('img')
    for (let i = 0; i < images.length; i++) {
      this.imageFilter.analyzeImage(images[i], false)
    }

    const videos = root instanceof Element ? root.getElementsByTagName('video') : root.querySelectorAll('video')
    for (let i = 0; i < videos.length; i++) {
      this.videoFilter.analyzeVideo(videos[i], false)
    }
  }

  private checkSingleNode (element: Element): void {
    if (element.nodeName === 'IMG') {
      this.imageFilter.analyzeImage(element as HTMLImageElement, false)
    } else if (element.nodeName === 'VIDEO') {
      this.videoFilter.analyzeVideo(element as HTMLVideoElement, false)
    }
  }

  private checkAttributeMutation (mutation: MutationRecord): void {
    const target = mutation.target as Element

    if (target.nodeName === 'IMG') {
      this.imageFilter.analyzeImage(target as HTMLImageElement, mutation.attributeName === 'src')
      return
    }

    if (target.nodeName === 'VIDEO') {
      this.videoFilter.analyzeVideo(target as HTMLVideoElement, mutation.attributeName === 'src')
      return
    }

    if (target.nodeName === 'SOURCE') {
      const videoElement = (target as HTMLSourceElement).parentElement
      if (videoElement !== null && videoElement.nodeName === 'VIDEO') {
        this.videoFilter.analyzeVideo(videoElement as HTMLVideoElement, mutation.attributeName === 'src')
      }
      return
    }

    // The filter's own writes land on `style` too, so this re-examines
    // elements it has already handled. That is harmless because a scan reports
    // the background URL and the filter drops any target whose URL it has
    // already reached a verdict on; nothing here needs to know which writes
    // were its own.
    if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
      this.queueBackgroundScan(target)
    }
  }

  /**
   * Media inside a shadow tree is invisible to the document's observer and to
   * tag queries from outside it, so each shadow root under `subtree` is
   * observed and scanned in its own right, nested roots included. Only hosts
   * inside new subtrees are looked for: a root attached to a host already on
   * the page is not noticed.
   */
  private discoverShadowRoots (subtree: Element | ShadowRoot): void {
    if (subtree instanceof Element) this.adoptShadowRoot(subtree)

    const walker = document.createTreeWalker(subtree, NodeFilter.SHOW_ELEMENT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      this.adoptShadowRoot(node as Element)
    }
  }

  private adoptShadowRoot (host: Element): void {
    const root = shadowRootOf(host)
    if (root === null) return

    // Registered every time it is seen: the registry forgets roots whose host
    // left the page, while this watcher's observation of them persists.
    registerShadowRoot(root)
    if (this.observedShadowRoots.has(root)) return
    this.observedShadowRoots.add(root)

    this.observer.observe(root, this.getConfig())
    // `load` and `error` are not composed, so they never leave the shadow tree.
    root.addEventListener('load', this.onMediaLoad, true)
    root.addEventListener('error', this.onMediaLoad, true)

    this.findAndCheckAllMedia(root)
    this.discoverShadowRoots(root)
  }

  /** A stylesheet arriving late can introduce background rules the harvest has not seen. */
  private noteStyleSheetNode (element: Element): void {
    if (this.background === undefined) return
    if (element.nodeName !== 'STYLE' && element.nodeName !== 'LINK') return
    // A shadow tree's sheets never reach the document-level harvest.
    if (isInShadowTree(element)) return

    invalidateSelectorCache()
    this.scanWholeDocument = true
    this.scheduleBackgroundScan()
  }

  private queueBackgroundScan (root: Element): void {
    if (this.background === undefined) return
    // The background scan and its effects work at document level only.
    if (isInShadowTree(root)) return

    if (root === document.documentElement || this.pendingRoots.size >= DOMWatcher.MAX_PENDING_ROOTS) {
      this.scanWholeDocument = true
      this.pendingRoots.clear()
    } else {
      this.pendingRoots.add(root)
    }

    this.scheduleBackgroundScan()
  }

  private scheduleBackgroundScan (): void {
    if (this.scanTimer !== undefined) return

    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = undefined
      this.runBackgroundScan()
    }, DOMWatcher.SCAN_DEBOUNCE_MS)
  }

  private runBackgroundScan (): void {
    const background = this.background
    if (background === undefined) return

    const roots = this.scanWholeDocument
      ? [document.documentElement]
      : Array.from(this.pendingRoots).filter(root => root.isConnected)

    this.scanWholeDocument = false
    this.pendingRoots.clear()

    for (const root of roots) {
      background.filter.analyzeCandidates(
        scanForBackgrounds(root, background.mode, { minSize: background.minSize })
      )
    }
  }

  private getConfig (): MutationObserverInit {
    const attributeFilter = ['src', 'poster']

    if (this.background !== undefined) {
      attributeFilter.push('style')
      // Only a stylesheet rule can make a class change swap a background, so
      // outside those modes this would be a large volume of mutations that
      // could never produce a candidate.
      if (this.background.mode !== 'inline') attributeFilter.push('class')
    }

    return {
      characterData: false,
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter
    }
  }
}
