import { PredictionRequest } from '../../utils/messages'

import { BackgroundCandidate, BackgroundPseudo } from './backgroundScan'
import { blurFilterForScore, SWEEP_FILTER } from './blurEffect'
import { Filter } from './Filter'
import { MediaFilterSettingsType } from './ImageFilter'
import { PageTally } from './pageSensitivity'
import { clearPseudoEffect, setPseudoEffect } from './pseudoEffects'

export type IBackgroundFilter = {
  analyzeCandidates: (candidates: BackgroundCandidate[]) => void
  setSettings: (settings: MediaFilterSettingsType) => void
  revealElement: (element: HTMLElement) => void
  revealSweptBackgrounds: () => number
}

type TargetStatus = 'processing' | 'nsfw' | 'sfw' | 'error' | 'page-sensitive'

const OVERLAY_ATTR = 'data-nsfw-filter-bg-overlay'

/** Shown over an element whose background is concealed but whose children must stay readable. */
const CONCEAL_COLOR = '#18181b'

/**
 * Where one target's state lives. An element can paint three separate
 * backgrounds -- its own, a ::before and an ::after -- so each gets its own
 * attributes. `restore` and `positioned` describe changes made to the element
 * itself and are shared.
 */
type StateKeys = {
  status: string
  src: string
  klass: string
  /** Where the effect went, so revealing knows what to undo. */
  mode: string
  /** The element's own `background-image` declaration before it was cleared. */
  restore: string
  /** '1' when the element was made a containing block for the overlay. */
  positioned: string
  /** Dataset key, not an attribute: `retryAfterFailure` reads it through `dataset`. */
  retry: string
}

const keysFor = (pseudo?: BackgroundPseudo): StateKeys => {
  const infix = pseudo === '::before' ? '-before' : pseudo === '::after' ? '-after' : ''
  const retryInfix = pseudo === '::before' ? 'Before' : pseudo === '::after' ? 'After' : ''
  return {
    status: `data-nsfw-filter-bg${infix}-status`,
    src: `data-nsfw-filter-bg${infix}-src`,
    klass: `data-nsfw-filter-bg${infix}-class`,
    mode: `data-nsfw-filter-bg${infix}-mode`,
    restore: 'data-nsfw-filter-bg-restore',
    positioned: 'data-nsfw-filter-bg-positioned',
    retry: `nsfwFilterBg${retryInfix}Retry`
  }
}

const readState = (element: HTMLElement, key: string): string | undefined =>
  element.getAttribute(key) ?? undefined

/** Every attribute selector a document-wide query has to cover to reach all three targets. */
const statusSelector = (status: TargetStatus): string => [
  `[data-nsfw-filter-bg-status="${status}"]`,
  `[data-nsfw-filter-bg-before-status="${status}"]`,
  `[data-nsfw-filter-bg-after-status="${status}"]`
].join(',')

/**
 * Filters images a page paints through CSS `background-image` rather than an
 * <img> tag.
 *
 * No border frame and no class tint: both work by reparenting the media into a
 * wrapper span, and a background-painting element can be a positioned box whose
 * layout the page's own framework owns, where reparenting breaks the layout or
 * is undone on the next render. The effect is carried by properties set on the
 * element that is already there.
 *
 * Three ways in, picked per target:
 *
 * - `direct`  -- no descendants, so a CSS `filter` on the element reaches the
 *                background and nothing else.
 * - `overlay` -- has descendants, and `filter` applies to the whole subtree, so
 *                a filtered copy of the background goes into an inserted child
 *                and the element's own background is cleared.
 * - `pseudo`  -- a ::before/::after paints it. Not a DOM node, so the effect has
 *                to arrive as a stylesheet rule.
 */
export class BackgroundFilter extends Filter implements IBackgroundFilter {
  private settings: MediaFilterSettingsType
  /** Sticky for the life of the page view; navigation builds a new instance. */
  private pageSensitive: boolean
  private sweepDismissed: boolean

  constructor (tally?: PageTally) {
    super(tally)
    this.pageSensitive = false
    this.sweepDismissed = false
    this.settings = { filterEffect: 'hide' }

    this.tally.onVerdict(() => this.evaluatePageSensitivity())
  }

  public setSettings (settings: MediaFilterSettingsType): void {
    this.settings = settings
  }

  public analyzeCandidates (candidates: BackgroundCandidate[]): void {
    for (const candidate of candidates) this.analyzeCandidate(candidate)
  }

  /** User-initiated unhide: clears every target on this element at once. */
  public revealElement (element: HTMLElement): void {
    for (const pseudo of [undefined, '::before', '::after'] as const) {
      const keys = keysFor(pseudo)
      if (readState(element, keys.status) === undefined) continue

      this.clearEffect(element, pseudo)
      element.setAttribute(keys.status, 'sfw')
      element.removeAttribute(keys.klass)
    }
  }

  /**
   * Undo the page-wide sweep for this page view and report how many elements
   * came back. Individually flagged elements keep their treatment. Stays
   * dismissed until the page is left, so verdicts still arriving cannot
   * re-trip what the user just cleared.
   */
  public revealSweptBackgrounds (): number {
    this.sweepDismissed = true
    this.pageSensitive = false

    let revealed = 0
    document.querySelectorAll<HTMLElement>(statusSelector('page-sensitive')).forEach(element => {
      for (const pseudo of [undefined, '::before', '::after'] as const) {
        const keys = keysFor(pseudo)
        if (readState(element, keys.status) !== 'page-sensitive') continue

        this.clearEffect(element, pseudo)
        element.setAttribute(keys.status, 'sfw')
        revealed++
      }
    })

    return revealed
  }

  /**
   * `force` is for the retry path only. A scan runs on every mutation burst, so
   * re-requesting a target that already failed whenever one comes round would
   * spend the retry budget in a few frames rather than over the delay that
   * budget is spaced across.
   */
  private analyzeCandidate ({ element, pseudo, url }: BackgroundCandidate, force: boolean = false): void {
    const keys = keysFor(pseudo)
    const status = readState(element, keys.status)

    if (!force && status !== undefined && url === readState(element, keys.src)) return

    element.setAttribute(keys.src, url)
    element.setAttribute(keys.status, 'processing')
    this.conceal(element, pseudo, url)

    const request = new PredictionRequest(url, this.isGifUrl(url) ? 'gif' : 'image')
    this.requestToAnalyzeImage(request)
      .then(response => {
        // The element may have been repainted with a different image while the
        // verdict was in flight; applying it now would filter the wrong picture.
        if (readState(element, keys.src) !== url) return

        if (response.failed) {
          this.markUnclassified(element, pseudo, url)
          return
        }

        if (response.result) {
          this.applyVerdict(element, pseudo, url, response.score, response.topNsfwClass)
          this.recordVerdict(true)
          this.evaluatePageSensitivity()
          return
        }

        this.recordVerdict(false)
        this.evaluatePageSensitivity()
        this.clearEffect(element, pseudo)
        element.setAttribute(keys.status, this.pageSensitive ? 'page-sensitive' : 'sfw')
        if (this.pageSensitive) this.sweep(element, pseudo, url)
      })
      .catch(() => {
        this.markUnclassified(element, pseudo, url)
      })
  }

  /**
   * No verdict was reached. The background is shown, but recorded as unjudged
   * so it stays eligible for another attempt -- writing 'sfw' here would be
   * indistinguishable from a real verdict and would never be revisited.
   */
  private markUnclassified (element: HTMLElement, pseudo: BackgroundPseudo | undefined, url: string): void {
    const keys = keysFor(pseudo)
    this.clearEffect(element, pseudo)
    element.setAttribute(keys.status, 'error')
    this.retryAfterFailure(
      element,
      () => this.analyzeCandidate({ element, pseudo, url }, true),
      keys.retry
    )
  }

  private applyVerdict (
    element: HTMLElement,
    pseudo: BackgroundPseudo | undefined,
    url: string,
    score?: number,
    topNsfwClass?: string
  ): void {
    const keys = keysFor(pseudo)
    const { filterEffect } = this.settings

    if (filterEffect === 'hide') {
      this.conceal(element, pseudo, url)
    } else {
      const effect = filterEffect === 'grayscale' ? 'grayscale(1)' : blurFilterForScore(score)
      this.applyFilter(element, pseudo, url, effect)
    }

    element.setAttribute(keys.status, 'nsfw')
    if (topNsfwClass !== undefined) element.setAttribute(keys.klass, topNsfwClass)
  }

  private sweep (element: HTMLElement, pseudo: BackgroundPseudo | undefined, url: string): void {
    this.applyFilter(element, pseudo, url, SWEEP_FILTER)
  }

  /** Hides the image while leaving any text and controls on the element readable. */
  private conceal (element: HTMLElement, pseudo: BackgroundPseudo | undefined, url: string): void {
    const keys = keysFor(pseudo)

    if (pseudo !== undefined) {
      setPseudoEffect(element, pseudo, 'background-image:none')
      element.setAttribute(keys.mode, 'pseudo')
      return
    }

    if (this.isLeaf(element)) {
      element.style.visibility = 'hidden'
      element.setAttribute(keys.mode, 'direct')
      return
    }

    this.mountOverlay(element, url, undefined)
    element.setAttribute(keys.mode, 'overlay')
  }

  private applyFilter (
    element: HTMLElement,
    pseudo: BackgroundPseudo | undefined,
    url: string,
    effect: string
  ): void {
    const keys = keysFor(pseudo)

    if (pseudo !== undefined) {
      setPseudoEffect(element, pseudo, `filter:${effect}`)
      element.setAttribute(keys.mode, 'pseudo')
      return
    }

    if (this.isLeaf(element)) {
      this.unmountOverlay(element)
      element.style.visibility = 'visible'
      element.style.filter = effect
      element.setAttribute(keys.mode, 'direct')
      return
    }

    this.mountOverlay(element, url, effect)
    element.setAttribute(keys.mode, 'overlay')
  }

  private clearEffect (element: HTMLElement, pseudo: BackgroundPseudo | undefined): void {
    const keys = keysFor(pseudo)

    if (pseudo !== undefined) {
      clearPseudoEffect(element, pseudo)
      element.removeAttribute(keys.mode)
      return
    }

    this.unmountOverlay(element)
    element.style.filter = ''
    element.style.visibility = 'visible'
    element.removeAttribute(keys.mode)
  }

  /**
   * A copy of the background, filtered, on top of the element's own, which is
   * cleared so a filter's soft edges cannot let the original show through.
   */
  private mountOverlay (element: HTMLElement, url: string, effect?: string): void {
    const keys = keysFor(undefined)

    if (readState(element, keys.restore) === undefined) {
      element.setAttribute(keys.restore, element.style.backgroundImage)
    }
    element.style.backgroundImage = 'none'

    if (this.computedPosition(element) === 'static') {
      element.style.position = 'relative'
      element.setAttribute(keys.positioned, '1')
    }

    const overlay = this.findOverlay(element) ?? this.createOverlay(element)

    if (effect === undefined) {
      overlay.style.backgroundImage = 'none'
      overlay.style.backgroundColor = CONCEAL_COLOR
      overlay.style.filter = ''
      return
    }

    const computed = this.computedStyle(element)
    overlay.style.backgroundColor = 'transparent'
    overlay.style.backgroundImage = `url("${url}")`
    overlay.style.backgroundSize = computed?.backgroundSize ?? 'cover'
    overlay.style.backgroundPosition = computed?.backgroundPosition ?? 'center'
    overlay.style.backgroundRepeat = computed?.backgroundRepeat ?? 'no-repeat'
    overlay.style.filter = effect
  }

  private createOverlay (element: HTMLElement): HTMLElement {
    const overlay = document.createElement('div')
    overlay.setAttribute(OVERLAY_ATTR, '1')
    overlay.setAttribute('aria-hidden', 'true')
    overlay.style.position = 'absolute'
    overlay.style.top = '0'
    overlay.style.right = '0'
    overlay.style.bottom = '0'
    overlay.style.left = '0'
    overlay.style.pointerEvents = 'none'
    overlay.style.borderRadius = 'inherit'
    overlay.style.zIndex = '2147483646'
    element.appendChild(overlay)
    return overlay
  }

  private unmountOverlay (element: HTMLElement): void {
    const keys = keysFor(undefined)
    this.findOverlay(element)?.remove()

    const restore = readState(element, keys.restore)
    if (restore !== undefined) {
      element.style.backgroundImage = restore
      element.removeAttribute(keys.restore)
    }

    if (readState(element, keys.positioned) === '1') {
      element.style.position = ''
      element.removeAttribute(keys.positioned)
    }
  }

  private findOverlay (element: HTMLElement): HTMLElement | null {
    for (let i = 0; i < element.children.length; i++) {
      const child = element.children[i]
      if (child instanceof HTMLElement && child.getAttribute(OVERLAY_ATTR) === '1') return child
    }
    return null
  }

  /**
   * Enough of the page came back positive to treat the page itself as unsafe,
   * so backgrounds the classifier individually cleared get swept behind a blur
   * too. Targets still in flight are picked up as their own verdicts land.
   */
  private evaluatePageSensitivity (): void {
    const thresholds = this.settings.interImageAwareness
    if (thresholds === undefined || this.pageSensitive || this.sweepDismissed) return
    if (!this.tally.isSensitive(thresholds)) return

    this.pageSensitive = true

    document.querySelectorAll<HTMLElement>(statusSelector('sfw')).forEach(element => {
      for (const pseudo of [undefined, '::before', '::after'] as const) {
        const keys = keysFor(pseudo)
        if (readState(element, keys.status) !== 'sfw') continue

        const url = readState(element, keys.src)
        if (url === undefined) continue

        element.setAttribute(keys.status, 'page-sensitive')
        this.sweep(element, pseudo, url)
      }
    })
  }

  /**
   * Whether a CSS filter on this element would reach only its background. An
   * element with rendered children cannot be filtered without filtering them.
   */
  private isLeaf (element: HTMLElement): boolean {
    if (this.findOverlay(element) !== null) {
      return element.children.length === 1 && element.textContent?.trim().length === 0
    }
    return element.children.length === 0 && element.textContent?.trim().length === 0
  }

  private computedStyle (element: HTMLElement): CSSStyleDeclaration | undefined {
    try {
      return window.getComputedStyle(element)
    } catch {
      return undefined
    }
  }

  private computedPosition (element: HTMLElement): string {
    const inline = element.style.position
    if (inline.length > 0) return inline

    // An engine that reports no position at all is describing the initial
    // value, which is what an unpositioned element has.
    const computed = this.computedStyle(element)?.position
    return computed === undefined || computed.length === 0 ? 'static' : computed
  }

  private isGifUrl (url: string): boolean {
    return /\.gif(\?.*)?$/i.test(url)
  }
}
