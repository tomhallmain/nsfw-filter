/**
 * Finding elements that paint an image through CSS `background-image` rather
 * than an <img>/<video> tag.
 *
 * Cost is the whole problem here. Reading `getComputedStyle` for every element
 * on a page forces a style recalculation and is the expensive way to answer the
 * question, so the search is tiered and the caller picks how far to go:
 *
 *   'inline'     -- attribute selector on elements carrying an inline
 *                   `background-image`. No style resolution at all.
 *   'stylesheet' -- the above, plus selectors harvested once from the CSSOM for
 *                   rules that set a url() background. `getComputedStyle` runs
 *                   only on elements those selectors actually match, and the
 *                   harvest is the only way to reach ::before/::after painters,
 *                   which are not DOM nodes and so match no query.
 *   'computed'   -- the above, plus `getComputedStyle` on every element under
 *                   the scanned root. Complete, and the one tier whose cost
 *                   scales with page size rather than with how much of the page
 *                   uses background images.
 *
 * A stylesheet the document cannot read -- cross-origin without CORS -- raises
 * on `cssRules` and contributes no selectors, so 'stylesheet' silently covers
 * less of such a page. `blindStyleSheets()` reports how many were unreadable.
 */

import { extractBackgroundUrl } from './backgroundUrl'

export type BackgroundScanMode = 'off' | 'inline' | 'stylesheet' | 'computed'

export type BackgroundPseudo = '::before' | '::after'

export type BackgroundCandidate = {
  element: HTMLElement
  /** Absent when the element paints the background itself. */
  pseudo?: BackgroundPseudo
  url: string
}

export type BackgroundScanOptions = {
  /** Elements smaller than this on either axis are skipped. */
  minSize: number
  /** Ceiling on elements visited by the 'computed' walk, per scan. */
  maxComputedElements?: number
}

const DEFAULT_MAX_COMPUTED_ELEMENTS = 4000

/** Elements that never paint a background a viewer sees. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE'])

type HarvestedSelectors = {
  element: string[]
  pseudo: Array<{ selector: string, pseudo: BackgroundPseudo }>
  blind: number
}

let harvestCache: HarvestedSelectors | null = null

/** Drop the CSSOM harvest so the next scan rebuilds it. */
export const invalidateSelectorCache = (): void => {
  harvestCache = null
}

/** Stylesheets the last harvest could not read, so their rules were not seen. */
export const blindStyleSheets = (): number => harvestCache?.blind ?? 0

/** Split a comma-separated selector list without cutting inside :is(), :not() or attribute values. */
const splitSelectorList = (selectorText: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (const character of selectorText) {
    if (quote !== null) {
      current += character
      if (character === quote) quote = null
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }

    if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth--
    else if (character === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }

    current += character
  }

  parts.push(current.trim())
  return parts.filter(part => part.length > 0)
}

const PSEUDO_TAIL = /(::?)(before|after)\s*$/i

const recordSelector = (selector: string, into: HarvestedSelectors): void => {
  const match = PSEUDO_TAIL.exec(selector)
  if (match === null) {
    into.element.push(selector)
    return
  }

  const host = selector.slice(0, match.index).trim()
  if (host.length === 0) return

  into.pseudo.push({
    selector: host,
    pseudo: match[2].toLowerCase() === 'before' ? '::before' : '::after'
  })
}

const collectFromRules = (rules: CSSRuleList, into: HarvestedSelectors): void => {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    const nested = (rule as CSSGroupingRule).cssRules

    if (nested !== undefined && nested !== null) {
      collectFromRules(nested, into)
      continue
    }

    const style = (rule as CSSStyleRule).style
    const selectorText = (rule as CSSStyleRule).selectorText
    if (style === undefined || typeof selectorText !== 'string') continue

    // The longhand is the cheap read, but a CSSOM that does not expand the
    // `background` shorthand into it leaves it empty, so fall back to the
    // rule's own text before deciding the rule paints nothing.
    const declared = `${style.backgroundImage ?? ''} ${style.background ?? ''}`
    const paints = declared.includes('url(') ||
      (declared.trim().length === 0 && (rule.cssText ?? '').includes('url('))
    if (!paints) continue

    for (const selector of splitSelectorList(selectorText)) {
      recordSelector(selector, into)
    }
  }
}

const harvestSelectors = (): HarvestedSelectors => {
  if (harvestCache !== null) return harvestCache

  const harvested: HarvestedSelectors = { element: [], pseudo: [], blind: 0 }
  const sheets = document.styleSheets

  for (let i = 0; i < sheets.length; i++) {
    let rules: CSSRuleList | null = null
    try {
      rules = sheets[i].cssRules
    } catch {
      // Cross-origin without CORS: unreadable, and nothing makes it readable.
      harvested.blind++
      continue
    }
    if (rules !== null) collectFromRules(rules, harvested)
  }

  harvestCache = harvested
  return harvested
}

const isViable = (element: Element, minSize: number): element is HTMLElement => {
  if (!(element instanceof HTMLElement)) return false
  if (SKIPPED_TAGS.has(element.tagName)) return false

  const rect = element.getBoundingClientRect()

  // A zero box is an element that has not been laid out yet rather than one
  // that is too small. Skipping it keeps decorative sprites and never-rendered
  // nodes out of the queue; a later scan sees it once it has a size.
  return rect.width > minSize && rect.height > minSize
}

const addElementCandidate = (
  element: HTMLElement,
  candidates: Map<string, BackgroundCandidate>,
  useComputed: boolean
): void => {
  const inline = element.style.backgroundImage
  let url = inline.length > 0
    ? extractBackgroundUrl(inline, document.baseURI)
    : undefined

  if (url === undefined && useComputed) {
    url = extractBackgroundUrl(window.getComputedStyle(element).backgroundImage, document.baseURI)
  }

  if (url === undefined) return
  candidates.set(`${keyFor(element)}|`, { element, url })
}

const addPseudoCandidate = (
  element: HTMLElement,
  pseudo: BackgroundPseudo,
  candidates: Map<string, BackgroundCandidate>
): void => {
  let style: CSSStyleDeclaration
  try {
    style = window.getComputedStyle(element, pseudo)
  } catch {
    return
  }

  // A pseudo-element with no `content` generates no box, so its background is
  // never painted however the rule reads.
  const content = style.content
  if (content === 'none' || content === 'normal' || content === undefined) return

  const url = extractBackgroundUrl(style.backgroundImage, document.baseURI)
  if (url === undefined) return

  candidates.set(`${keyFor(element)}|${pseudo}`, { element, pseudo, url })
}

let elementSequence = 0
const elementKeys = new WeakMap<Element, string>()

/** Stable per-element key, so one scan cannot report the same target twice. */
const keyFor = (element: Element): string => {
  const existing = elementKeys.get(element)
  if (existing !== undefined) return existing

  const key = String(++elementSequence)
  elementKeys.set(element, key)
  return key
}

const queryWithin = (root: Element, selector: string): Element[] => {
  const found: Element[] = []
  try {
    root.querySelectorAll(selector).forEach(node => found.push(node))
    if (root.matches(selector)) found.push(root)
  } catch {
    // A selector the browser parses inside a stylesheet but rejects here
    // (vendor pseudo-classes, for one) is simply not searchable.
  }
  return found
}

export const scanForBackgrounds = (
  root: Element,
  mode: BackgroundScanMode,
  options: BackgroundScanOptions
): BackgroundCandidate[] => {
  if (mode === 'off') return []

  const { minSize, maxComputedElements = DEFAULT_MAX_COMPUTED_ELEMENTS } = options
  const candidates = new Map<string, BackgroundCandidate>()

  for (const element of queryWithin(root, '[style*="background-image"]')) {
    if (isViable(element, minSize)) addElementCandidate(element, candidates, false)
  }

  if (mode === 'stylesheet' || mode === 'computed') {
    const harvested = harvestSelectors()

    for (const selector of harvested.element) {
      for (const element of queryWithin(root, selector)) {
        if (isViable(element, minSize)) addElementCandidate(element, candidates, true)
      }
    }

    for (const { selector, pseudo } of harvested.pseudo) {
      for (const element of queryWithin(root, selector)) {
        if (isViable(element, minSize)) addPseudoCandidate(element, pseudo, candidates)
      }
    }
  }

  if (mode === 'computed') {
    const all = root.querySelectorAll('*')
    const limit = Math.min(all.length, maxComputedElements)

    for (let i = 0; i < limit; i++) {
      const element = all[i]
      if (!isViable(element, minSize)) continue
      addElementCandidate(element, candidates, true)
    }

    if (isViable(root, minSize)) addElementCandidate(root, candidates, true)
  }

  return Array.from(candidates.values())
}
