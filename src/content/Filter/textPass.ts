import { shadowRootOf } from '../shadowRoots'

import { replaceRanges, TextMatcher } from './textMatch'

/**
 * One pass over the page's text, run once after the document has parsed.
 * Nothing watches for text added later, so content rendered after the pass
 * (infinite scroll, client-side navigation, a framework re-render that
 * writes back a node's original text) stays unfiltered.
 *
 * Matches are written by assigning `nodeValue`. Text nodes are never split,
 * wrapped or replaced, because frameworks keep references to the nodes they
 * created, and a detached node breaks their later updates. The cost is that
 * the marker can't be styled.
 *
 * What is skipped, and why:
 *
 * - `<head>`, `<script>`, `<style>`, `<noscript>`, `<template>`,
 *   `<textarea>`, and `<title>` (which, inside SVG, is a tooltip). None of
 *   these is rendered text.
 * - Editable content. Rewriting it would change what the user is typing and
 *   could send the marker to the site. A `contenteditable` element with any
 *   value other than `false` or `inherit` is skipped with its whole subtree,
 *   `contenteditable="false"` islands inside it included, since they're
 *   still part of the editor's content. A document in `designMode` is
 *   skipped entirely. The check is on the attribute because jsdom doesn't
 *   implement `isContentEditable`.
 * - `<option>` with no `value` attribute. Its text is its form value, so
 *   rewriting it would change what the form submits.
 *
 * Text hidden with CSS is filtered. It can become visible later without any
 * DOM change, and this pass doesn't run again.
 *
 * The walk descends into open and closed shadow roots. It doesn't enter
 * iframes; their documents belong to other frames.
 */

const SKIPPED_ELEMENTS = new Set(['head', 'script', 'style', 'noscript', 'template', 'textarea', 'title'])

const isSkipped = (element: Element): boolean => {
  if (SKIPPED_ELEMENTS.has(element.localName)) return true
  if (element.localName === 'option' && !element.hasAttribute('value')) return true

  const editable = element.getAttribute('contenteditable')
  return editable !== null && editable.toLowerCase() !== 'false' && editable.toLowerCase() !== 'inherit'
}

const collectTextNodes = (root: Node, found: Text[]): void => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node instanceof Element && isSkipped(node)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT
  })

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      if (node.data.trim() !== '') found.push(node)
      continue
    }

    const shadowRoot = shadowRootOf(node as Element)
    if (shadowRoot !== null) collectTextNodes(shadowRoot, found)
  }
}

/** Filters the page's text now. Returns how many text nodes were changed. */
export const filterPageText = (matcher: TextMatcher): number => {
  if (document.designMode === 'on' || document.documentElement === null) return 0

  // Every node is gathered before any is changed, so the walk never sees the
  // pass's own writes.
  const nodes: Text[] = []
  collectTextNodes(document.documentElement, nodes)

  let changed = 0
  for (const node of nodes) {
    const replaced = replaceRanges(node.data, matcher(node.data))
    if (replaced === null) continue
    node.nodeValue = replaced
    changed++
  }
  return changed
}

/**
 * Runs the pass once the document has parsed: at `DOMContentLoaded`, or
 * immediately if that has already happened. The content script starts at
 * `document_start`, so settings can arrive while the page is still parsing.
 */
export const filterPageTextWhenParsed = (matcher: TextMatcher): void => {
  const run = (): void => { filterPageText(matcher) }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}
