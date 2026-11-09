declare namespace chrome {
  namespace dom {
    /** Content scripts only. Returns closed shadow roots as well as open ones. */
    function openOrClosedShadowRoot (element: HTMLElement): ShadowRoot | null
  }
}
