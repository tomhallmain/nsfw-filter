import { PredictionRequest } from '../../utils/messages'
import { queryAllDeep } from '../shadowRoots'

import { applyClassBorder, clearClassBorder } from './borderFrame'
import { applyClassTint, blurFilterForScore, clearClassTint, SWEEP_FILTER } from './blurEffect'
import { Filter, isCrossContextBlobUrl } from './Filter'
import { PageSensitivityThresholds, PageTally } from './pageSensitivity'

/** Status of an image hidden until the browser picks its source. */
const AWAITING_SOURCE = 'awaiting-source'

/** The URL the image actually displays, which differs from `src` under srcset or <picture>. */
const imageSource = (image: HTMLImageElement): string =>
  image.currentSrc.length > 0 ? image.currentSrc : image.src

export type MediaFilterSettingsType = {
  filterEffect: 'blur' | 'hide' | 'grayscale'
  /** Absent when the protection level is switched off. Ignored by VideoFilter. */
  interImageAwareness?: PageSensitivityThresholds
}

export type IImageFilter = {
  analyzeImage: (image: HTMLImageElement, srcAttribute: boolean) => void
  setSettings: (settings: MediaFilterSettingsType) => void
  revealImage: (image: HTMLImageElement) => void
  revealSweptImages: () => number
}

export class ImageFilter extends Filter implements IImageFilter {
  private readonly MIN_IMAGE_SIZE: number
  private settings: MediaFilterSettingsType
  /** Sticky for the life of the page view; navigation builds a new instance. */
  private pageSensitive: boolean
  /** Set once the user has asked to see through the sweep on this page. */
  private sweepDismissed: boolean
  private readonly flaggedListeners: Array<(image: HTMLImageElement) => void>

  constructor (tally?: PageTally) {
    super(tally)
    this.MIN_IMAGE_SIZE = 41
    this.pageSensitive = false
    this.sweepDismissed = false
    this.flaggedListeners = []

    this.settings = { filterEffect: 'hide' }

    // Blocked video moves the same counters, so the sweep has to be able to
    // trip on a verdict no image on the page produced.
    this.tally.onVerdict(() => this.evaluatePageSensitivity())
  }

  /** Called after an image's NSFW verdict has been applied. */
  public onFlagged (listener: (image: HTMLImageElement) => void): void {
    this.flaggedListeners.push(listener)
  }

  public setSettings (settings: MediaFilterSettingsType): void {
    this.settings = settings
  }

  // User-initiated unhide from the right-click menu.
  public revealImage (image: HTMLImageElement): void {
    if (image.parentNode?.nodeName === 'BODY') image.hidden = false
    image.style.filter = ''
    image.style.visibility = 'visible'
    this.clearBorder(image)
    clearClassTint(image)
    image.dataset.nsfwFilterStatus = 'sfw'
    delete image.dataset.nsfwFilterClass
  }

  /**
   * Undo the page-wide sweep for this page view and report how many images came
   * back. Individually flagged images keep their treatment: the sweep is the
   * only thing being dismissed. Stays dismissed until the page is left, so
   * verdicts still arriving cannot re-trip what the user just cleared.
   */
  public revealSweptImages (): number {
    this.sweepDismissed = true
    this.pageSensitive = false

    const swept = queryAllDeep<HTMLImageElement>(
      'img[data-nsfw-filter-status="page-sensitive"]'
    )
    swept.forEach(image => {
      image.style.filter = ''
      image.dataset.nsfwFilterStatus = 'sfw'
    })

    return swept.length
  }

  public analyzeImage (image: HTMLImageElement, _srcAttribute: boolean = false): void {
    const status = image.dataset.nsfwFilterStatus

    if (!this.isLargeEnough(image)) {
      if (status === AWAITING_SOURCE) this.releaseHold(image)
      return
    }

    if (this.awaitsSourceSelection(image)) {
      this.holdUntilLoaded(image, status)
      return
    }

    const source = imageSource(image)
    if (source.length === 0) {
      if (status === AWAITING_SOURCE) this.releaseHold(image)
      return
    }

    const judged = status !== undefined && status !== 'error' && status !== AWAITING_SOURCE
    if (source === image.dataset.nsfwFilterSrc && judged) return

    if (status === 'nsfw' || status === 'page-sensitive') this.clearAppliedEffect(image)

    if (isCrossContextBlobUrl(source)) {
      this.markUnsupported(image, source)
      return
    }

    image.dataset.nsfwFilterSrc = source
    image.dataset.nsfwFilterStatus = 'processing'
    this._analyzeImage(image, source)
  }

  /** Width and height of 0 mean not yet known, not too small. */
  private isLargeEnough (image: HTMLImageElement): boolean {
    return (image.width > this.MIN_IMAGE_SIZE && image.height > this.MIN_IMAGE_SIZE) ||
      image.height === 0 ||
      image.width === 0
  }

  /**
   * The displayed picture comes from `srcset` or a <picture> <source>, but the
   * browser has not chosen it yet (a lazy image stays unchosen until it nears
   * the viewport). `src` is then only a fallback, often a placeholder, so the
   * image waits for its `load` event instead of being judged by it.
   */
  private awaitsSourceSelection (image: HTMLImageElement): boolean {
    return image.currentSrc.length === 0 &&
      (image.hasAttribute('srcset') || image.parentElement?.nodeName === 'PICTURE')
  }

  /**
   * Hidden by visibility only: the `hidden` attribute is display: none, and an
   * element with no box is never lazy-loaded, so it would wait forever.
   */
  private holdUntilLoaded (image: HTMLImageElement, status: string | undefined): void {
    if (status === 'nsfw' || status === 'page-sensitive') this.clearAppliedEffect(image)
    image.dataset.nsfwFilterStatus = AWAITING_SOURCE
    image.style.visibility = 'hidden'
  }

  private releaseHold (image: HTMLImageElement): void {
    delete image.dataset.nsfwFilterStatus
    image.style.visibility = 'visible'
  }

  private _analyzeImage (image: HTMLImageElement, source: string): void {
    this.hideImage(image)

    const mediaType = this.isGifUrl(source) ? 'gif' : 'image'
    const request = new PredictionRequest(source, mediaType)
    this.requestToAnalyzeImage(request)
      .then(response => {
        // The image moved on to another source while this one was judged; the
        // newer source has its own request, and this verdict says nothing about it.
        if (imageSource(image) !== response.url) return

        if (response.failed) {
          this.markUnclassified(image, response.url)
          return
        }

        const { result, url, borderColor, topNsfwClass, score } = response
        if (result) {
          if (this.settings.filterEffect === 'blur') {
            image.style.filter = blurFilterForScore(score)
            this.applyBorder(image, borderColor)
            applyClassTint(image, borderColor, score)
            this.showImage(image, url, 'nsfw', topNsfwClass)
          } else if (this.settings.filterEffect === 'grayscale') {
            image.style.filter = 'grayscale(1)'
            this.applyBorder(image, borderColor)
            clearClassTint(image)
            this.showImage(image, url, 'nsfw', topNsfwClass)
          } else {
            // hide: no border (element not shown)
            image.dataset.nsfwFilterStatus = 'nsfw'
            if (topNsfwClass !== undefined) image.dataset.nsfwFilterClass = topNsfwClass
          }

          this.recordVerdict(true)
          this.evaluatePageSensitivity()
          this.flaggedListeners.forEach(listener => listener(image))
        } else {
          this.recordVerdict(false)
          this.evaluatePageSensitivity()
          this.clearBorder(image)
          clearClassTint(image)
          this.showImage(image, url, this.pageSensitive ? 'page-sensitive' : 'sfw')
        }
      }).catch(({ url }) => {
        this.markUnclassified(image, url)
      })
  }

  /**
   * An element being re-analysed for a new source still carries the previous
   * source's effect, which no later verdict path removes. Lazy-loaders and
   * modal viewers reuse one <img> across pictures.
   */
  private clearAppliedEffect (image: HTMLImageElement): void {
    image.style.filter = ''
    this.clearBorder(image)
    clearClassTint(image)
    delete image.dataset.nsfwFilterClass
  }

  /**
   * No verdict was reached. The image is shown, but recorded as unjudged so it
   * stays eligible for another attempt -- writing 'sfw' here would be
   * indistinguishable from a real verdict and would never be revisited.
   */
  private markUnclassified (image: HTMLImageElement, url: string): void {
    this.clearBorder(image)
    clearClassTint(image)
    this.showImage(image, url, 'error')
    this.retryAfterFailure(image, () => this.analyzeImage(image, false))
  }

  /**
   * A blob: source can never be classified -- see `isCrossContextBlobUrl`.
   * Unlike a transient failure, this never retries: shown unfiltered and
   * left alone until the src genuinely changes.
   */
  private markUnsupported (image: HTMLImageElement, source: string): void {
    this.clearBorder(image)
    clearClassTint(image)
    image.dataset.nsfwFilterSrc = source
    image.dataset.nsfwFilterStatus = 'error'
    delete image.dataset.nsfwFilterClass
    if (image.parentNode?.nodeName === 'BODY') image.hidden = false
    image.style.visibility = 'visible'
  }

  /**
   * Enough of the page came back positive to treat the page itself as unsafe,
   * so images the classifier individually cleared get swept behind a blur too.
   * Images still in flight are picked up as their own verdicts land.
   */
  private evaluatePageSensitivity (): void {
    const thresholds = this.settings.interImageAwareness
    if (thresholds === undefined || this.pageSensitive || this.sweepDismissed) return
    if (!this.tally.isSensitive(thresholds)) return

    this.pageSensitive = true

    const cleared = queryAllDeep<HTMLImageElement>('img[data-nsfw-filter-status="sfw"]')
    cleared.forEach(image => {
      image.dataset.nsfwFilterStatus = 'page-sensitive'
      image.style.filter = SWEEP_FILTER
    })
  }

  private hideImage (image: HTMLImageElement): void {
    if (image.parentNode?.nodeName === 'BODY') image.hidden = true

    image.style.visibility = 'hidden'
  }

  private showImage (
    image: HTMLImageElement,
    url: string,
    status: 'sfw' | 'nsfw' | 'error' | 'page-sensitive' = 'sfw',
    topNsfwClass?: string
  ): void {
    if (imageSource(image) === url) {
      if (image.parentNode?.nodeName === 'BODY') image.hidden = false

      image.dataset.nsfwFilterStatus = status
      if (status === 'page-sensitive') image.style.filter = SWEEP_FILTER
      if (status === 'nsfw' && topNsfwClass !== undefined) {
        image.dataset.nsfwFilterClass = topNsfwClass
      } else {
        delete image.dataset.nsfwFilterClass
      }
      image.style.visibility = 'visible'
    }
  }

  private applyBorder (image: HTMLImageElement, borderColor?: string): void {
    applyClassBorder(image, borderColor)
  }

  private clearBorder (image: HTMLImageElement): void {
    clearClassBorder(image)
  }

  private isGifUrl (url: string): boolean {
    return /\.gif(\?.*)?$/i.test(url)
  }
}
