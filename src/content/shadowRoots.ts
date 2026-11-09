/**
 * Shadow roots found on the page. Document-level queries don't descend into a
 * shadow tree, so page-wide passes over filtered media use `queryAllDeep` to
 * reach media inside one.
 */

const knownRoots = new Set<ShadowRoot>()

/** An element's shadow root, closed ones included where the extension API allows. */
export const shadowRootOf = (element: Element): ShadowRoot | null => {
  if (element.shadowRoot !== null) return element.shadowRoot

  // Only HTML elements can host an author shadow root.
  if (!(element instanceof HTMLElement)) return null
  if (typeof chrome === 'undefined' || typeof chrome.dom?.openOrClosedShadowRoot !== 'function') return null

  try {
    return chrome.dom.openOrClosedShadowRoot(element) ?? null
  } catch {
    return null
  }
}

export const registerShadowRoot = (root: ShadowRoot): void => {
  knownRoots.add(root)
}

/**
 * `querySelectorAll` across the document and every known shadow root. A root
 * whose host has left the page is forgotten; if the host comes back, the DOM
 * watcher finds and registers it again.
 */
export const queryAllDeep = <E extends Element>(selector: string): E[] => {
  const found = Array.from(document.querySelectorAll<E>(selector))

  knownRoots.forEach(root => {
    if (!root.host.isConnected) {
      knownRoots.delete(root)
      return
    }
    found.push(...Array.from(root.querySelectorAll<E>(selector)))
  })

  return found
}
