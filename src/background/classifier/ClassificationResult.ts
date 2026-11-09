/** Rich classification outcome passed from offscreen → SW → content script. */
export type ClassificationResult = {
  blocked: boolean
  /** Highest-probability non-SFW class when blocked. */
  topNsfwClass?: string
  /** CSS color for border when effect is blur/grayscale. */
  borderColor?: string
  /**
   * Certainty in [0, 1] when blocked (ONNX: sum of positive-class probs;
   * NSFWJS: winning class probability). Used to scale blur strength.
   */
  score?: number
  /** Set when no verdict was reached; `blocked` is then a fail-open default. */
  error?: string
}

export const visibleResult = (): ClassificationResult => ({ blocked: false })

/** Shown, but not judged: the caller may ask again. */
export const unjudgedResult = (error: string): ClassificationResult => ({ blocked: false, error })

export const blockedResult = (
  topNsfwClass?: string,
  borderColor?: string,
  score?: number
): ClassificationResult => ({
  blocked: true,
  topNsfwClass,
  borderColor,
  score
})
