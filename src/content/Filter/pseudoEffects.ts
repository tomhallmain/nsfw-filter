/**
 * Applying a filter effect to a ::before/::after background.
 *
 * A pseudo-element is not a DOM node: it has no `style` property to write and
 * no node to wrap, so the only way to reach one is a stylesheet rule. Each
 * handled host gets a key attribute, and rules are written against that key so
 * a rule targets exactly one element without depending on the site's own
 * class names.
 *
 * The rules go into a constructed stylesheet where the browser supports one,
 * because a page's Content-Security-Policy can reject an injected <style>
 * element while leaving `adoptedStyleSheets` untouched. Declarations carry
 * `!important` so a site rule of higher specificity does not win.
 */

import { BackgroundPseudo } from './backgroundScan'

export const PSEUDO_KEY_ATTR = 'data-nsfw-filter-bg-key'

type RuleKey = string

const declarations = new Map<RuleKey, string>()

let sequence = 0
let adopted: CSSStyleSheet | null = null
let styleElement: HTMLStyleElement | null = null

const supportsConstructed = (): boolean => {
  try {
    return typeof CSSStyleSheet === 'function' &&
      'replaceSync' in CSSStyleSheet.prototype &&
      Array.isArray(document.adoptedStyleSheets)
  } catch {
    return false
  }
}

const render = (): void => {
  const css = Array.from(declarations.entries())
    .map(([selector, body]) => `${selector}{${body}}`)
    .join('\n')

  if (supportsConstructed()) {
    if (adopted === null) {
      adopted = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted]
    }
    adopted.replaceSync(css)
    return
  }

  if (styleElement === null || !styleElement.isConnected) {
    styleElement = document.createElement('style')
    styleElement.setAttribute('data-nsfw-filter-pseudo', '1')
    document.head?.appendChild(styleElement)
  }
  styleElement.textContent = css
}

const keyFor = (element: HTMLElement): string => {
  const existing = element.getAttribute(PSEUDO_KEY_ATTR)
  if (existing !== null) return existing

  const key = String(++sequence)
  element.setAttribute(PSEUDO_KEY_ATTR, key)
  return key
}

const ruleKey = (element: HTMLElement, pseudo: BackgroundPseudo): RuleKey =>
  `[${PSEUDO_KEY_ATTR}="${keyFor(element)}"]${pseudo}`

/** `body` is a CSS declaration list, e.g. `filter:blur(40px)`, without a trailing semicolon. */
export const setPseudoEffect = (
  element: HTMLElement,
  pseudo: BackgroundPseudo,
  body: string
): void => {
  const withImportance = body
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => (part.endsWith('!important') ? part : `${part} !important`))
    .join(';')

  declarations.set(ruleKey(element, pseudo), withImportance)
  render()
}

export const clearPseudoEffect = (element: HTMLElement, pseudo: BackgroundPseudo): void => {
  const key = element.getAttribute(PSEUDO_KEY_ATTR)
  if (key === null) return

  declarations.delete(`[${PSEUDO_KEY_ATTR}="${key}"]${pseudo}`)
  render()
}

/** Test seam: drops every rule and the sheet holding them. */
export const resetPseudoEffects = (): void => {
  declarations.clear()
  if (styleElement !== null) {
    styleElement.remove()
    styleElement = null
  }
  adopted = null
}
