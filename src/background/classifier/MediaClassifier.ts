/**
 * Backend-agnostic classifier boundary for the offscreen document.
 * Implementations: NsfwjsMediaClassifier (TF.js; MobileNet or ViT weights),
 * OnnxMediaClassifier (ORT Web).
 */

import { ClassifierBackend } from '../../utils/models'

import { ClassificationResult } from './ClassificationResult'

export type { ClassificationResult } from './ClassificationResult'

export type MediaType = 'image' | 'video' | 'gif'

export type { ClassifierBackend } from '../../utils/models'

export type ClassifierSettings = {
  filterStrictness: number
  logging: boolean
  classifierBackend?: ClassifierBackend
  /** Sampling controls for video/GIF. */
  dynamicSampleRatio?: number
  dynamicPositiveRatio?: number
  dynamicMinSamples?: number
  dynamicMaxSamples?: number
  dynamicMaxSampleDurationSeconds?: number
  dynamicMetadataTimeoutMs?: number
  dynamicSeekTimeoutMs?: number
  dynamicClassifyTimeoutMs?: number
  /** Save frame pairs around a large score swing during video sampling. */
  autoDlFramesEnabled?: boolean
  autoDlSignatureThreshold?: number
  autoDlMaxPairsPerVideo?: number
  autoDlMaxPairsPerSession?: number
}

export type MediaClassifier = {
  readonly ready: Promise<void>
  readonly backend: ClassifierBackend
  classifyImage: (url: string) => Promise<ClassificationResult>
  classifyVideo: (url: string) => Promise<ClassificationResult>
  classifyGif: (url: string) => Promise<ClassificationResult>
  setSettings: (settings: ClassifierSettings) => void
  dispose?: () => void
}

/** Service-worker side: URL-only predictions via offscreen RPC. */
export type IUrlClassifier = {
  predict: (url: string, mediaType?: MediaType) => Promise<ClassificationResult>
  setSettings: (settings: ClassifierSettings) => void
}
