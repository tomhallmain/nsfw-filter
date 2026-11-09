/**
 * Whether enough of a page has come back positive to treat the page itself as
 * unsafe, rather than only the individual images that were flagged.
 *
 * Both conditions are required. The floor stops a handful of early results
 * from tripping a page that has barely begun classifying, and the ratio stops
 * one fixed count from meaning the same thing on a four-image page and a
 * four-hundred-image one.
 */
export type PageSensitivityThresholds = {
  minCount: number
  minRatio: number
}

/**
 * `analyzed` counts images that reached a verdict, blocked or not. Images still
 * in flight, and ones whose classification failed, are excluded: neither says
 * anything about how unsafe the page is, and counting them would drag the ratio
 * toward zero while the page is still loading.
 */
export const isPageSensitive = (
  blocked: number,
  analyzed: number,
  { minCount, minRatio }: PageSensitivityThresholds
): boolean => {
  if (analyzed <= 0) return false
  if (blocked < minCount) return false

  return blocked / analyzed >= minRatio
}

/**
 * Verdict counts for one page view, shared by the image and video filters.
 *
 * The trigger asks how much of the page came back positive, so a page whose
 * unsafe media is video has to move the same counters an image would. Listeners
 * are notified on every verdict, letting a filter react to a threshold its own
 * media did not cross.
 */
export class PageTally {
  private blocked: number
  private analyzed: number
  private readonly listeners: Array<() => void>

  constructor () {
    this.blocked = 0
    this.analyzed = 0
    this.listeners = []
  }

  public record (blocked: boolean): void {
    this.analyzed++
    if (blocked) this.blocked++

    for (const listener of this.listeners) listener()
  }

  public onVerdict (listener: () => void): void {
    this.listeners.push(listener)
  }

  public isSensitive (thresholds: PageSensitivityThresholds): boolean {
    return isPageSensitive(this.blocked, this.analyzed, thresholds)
  }
}
