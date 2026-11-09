/**
 * Saves pairs of consecutive sampled video frames whose positive score swings
 * by at least a threshold, as review material for model training. Off unless
 * the user opts in. Frames stay on the local disk.
 *
 * Runs in the offscreen document, where `chrome.downloads` is unavailable
 * (runtime is the only extension API there), so each pair is handed to the
 * service worker as one AUTO_DL_FRAME_PAIR message.
 */

import { ILogger } from '../../utils/Logger'
import { AUTO_DL_FRAME_PAIR, AutoDlFile, AutoDlFramePairMessage } from '../../utils/messages'

import { ClassifierBackend, ClassifierSettings } from './MediaClassifier'

/** Per-class probabilities for one sampled frame, plus their positive-class sum. */
export type FrameSignature = {
  positiveScore: number
  classes: Array<{ name: string, probability: number }>
}

export type SampledFrame = {
  /** Position in the video's sample sequence. */
  index: number
  timeSeconds: number
  signature: FrameSignature
  /** RGBA pixels of the square `size`² image the classifier saw. */
  pixels: Uint8ClampedArray
  size: number
}

export type AutoDlSettings = {
  enabled: boolean
  threshold: number
  maxPairsPerVideo: number
  maxPairsPerSession: number
}

export const DEFAULT_AUTO_DL_SETTINGS: AutoDlSettings = {
  enabled: false,
  threshold: 0.5,
  maxPairsPerVideo: 3,
  maxPairsPerSession: 20
}

export const AUTO_DL_DIR = 'nsfw-filter-frames'

export type ModelInfo = {
  backend: ClassifierBackend
  model: string
}

export type PngEncoder = (pixels: Uint8ClampedArray, size: number) => string
export type PairSink = (files: AutoDlFile[]) => void

export const autoDlSettingsFrom = (settings: ClassifierSettings): AutoDlSettings => ({
  enabled: settings.autoDlFramesEnabled === true,
  threshold: settings.autoDlSignatureThreshold ?? DEFAULT_AUTO_DL_SETTINGS.threshold,
  maxPairsPerVideo: settings.autoDlMaxPairsPerVideo ?? DEFAULT_AUTO_DL_SETTINGS.maxPairsPerVideo,
  maxPairsPerSession: settings.autoDlMaxPairsPerSession ?? DEFAULT_AUTO_DL_SETTINGS.maxPairsPerSession
})

/** 32-bit FNV-1a, hex. Groups a video's files without putting its URL in folder names. */
export const hashUrl = (url: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Scheme and host only; the path and query can identify the page or viewer. */
export const mediaOrigin = (url: string): string => {
  if (url.startsWith('blob:')) return 'blob:'
  if (url.startsWith('data:')) return 'data:'
  try {
    return new URL(url).origin
  } catch {
    return 'unknown'
  }
}

const jsonDataUrl = (value: unknown): string =>
  `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`

/**
 * Owns the per-session pair budget. "Session" is this offscreen document's
 * lifetime, which outlasts service-worker restarts.
 */
export class AutoDlSession {
  private readonly encode: PngEncoder
  private readonly sink: PairSink
  private readonly logger: ILogger
  private readonly now: () => number
  private pairsSaved = 0

  constructor (encode: PngEncoder, sink: PairSink, logger: ILogger, now: () => number = Date.now) {
    this.encode = encode
    this.sink = sink
    this.logger = logger
    this.now = now
  }

  /** A tracker for one sampling of one video, or null when nothing may be saved. */
  public startVideo (url: string, settings: AutoDlSettings, model: ModelInfo): AutoDlVideoTracker | null {
    if (!settings.enabled || this.pairsSaved >= settings.maxPairsPerSession) return null

    const folder = `${AUTO_DL_DIR}/${hashUrl(url)}-${this.now().toString(36)}`
    return new AutoDlVideoTracker(this, folder, url, settings, model)
  }

  /** @internal Called by a tracker once a pair is encoded and ready to send. */
  public commit (files: AutoDlFile[]): void {
    this.pairsSaved++
    this.sink(files)
  }

  /** @internal */
  public hasBudget (settings: AutoDlSettings): boolean {
    return this.pairsSaved < settings.maxPairsPerSession
  }

  /** @internal */
  public encodeFrame (frame: SampledFrame): string {
    return this.encode(frame.pixels, frame.size)
  }

  /** @internal */
  public log (message: string): void {
    this.logger.log(message)
  }
}

export class AutoDlVideoTracker {
  private readonly session: AutoDlSession
  private readonly folder: string
  private readonly url: string
  private readonly settings: AutoDlSettings
  private readonly model: ModelInfo
  private previous: SampledFrame | null = null
  private lastSavedIndex: number | null = null
  private pairs = 0

  constructor (session: AutoDlSession, folder: string, url: string, settings: AutoDlSettings, model: ModelInfo) {
    this.session = session
    this.folder = folder
    this.url = url
    this.settings = settings
    this.model = model
  }

  /**
   * Feed each sample in order. Pass null for a sample with no signature (a
   * flat frame skips inference); no pair is formed across it.
   */
  public observe (frame: SampledFrame | null): void {
    const previous = this.previous
    this.previous = frame
    if (frame === null || previous === null) return

    const delta = Math.abs(frame.signature.positiveScore - previous.signature.positiveScore)
    if (delta < this.settings.threshold) return
    if (this.pairs >= this.settings.maxPairsPerVideo || !this.session.hasBudget(this.settings)) return

    let files: AutoDlFile[]
    try {
      files = this.buildFiles(previous, frame, delta)
    } catch (error) {
      // Never fatal to sampling: the verdict does not depend on this.
      this.session.log(`Auto-DL skipped a frame pair for ${this.url}: ${(error as Error)?.message ?? String(error)}`)
      return
    }

    this.pairs++
    this.lastSavedIndex = frame.index
    this.session.commit(files)
  }

  private frameFilename (frame: SampledFrame): string {
    return `${this.folder}/frame-${frame.index}.png`
  }

  private buildFiles (before: SampledFrame, after: SampledFrame, delta: number): AutoDlFile[] {
    const files: AutoDlFile[] = []
    // A frame that was the previous pair's "after" is already on disk.
    if (this.lastSavedIndex !== before.index) {
      files.push({ filename: this.frameFilename(before), dataUrl: this.session.encodeFrame(before) })
    }
    files.push({ filename: this.frameFilename(after), dataUrl: this.session.encodeFrame(after) })

    const describe = (frame: SampledFrame): Record<string, unknown> => ({
      sampleIndex: frame.index,
      timeSeconds: frame.timeSeconds,
      file: this.frameFilename(frame).slice(this.folder.length + 1),
      positiveScore: frame.signature.positiveScore,
      classes: frame.signature.classes
    })

    files.push({
      filename: `${this.folder}/pair-${before.index}-${after.index}.json`,
      dataUrl: jsonDataUrl({
        videoId: hashUrl(this.url),
        mediaOrigin: mediaOrigin(this.url),
        backend: this.model.backend,
        model: this.model.model,
        metric: 'abs-delta-positive-score',
        delta,
        threshold: this.settings.threshold,
        before: describe(before),
        after: describe(after)
      })
    })
    return files
  }
}

/** PNG data URL from RGBA pixels. Offscreen document only (needs a DOM canvas). */
export const encodePngDataUrl: PngEncoder = (pixels, size) => {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  try {
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('Unable to create canvas context for frame export')
    // ImageData needs an ArrayBuffer-backed array; copy in case `pixels` views a shared buffer.
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, size), 0, 0)
    return canvas.toDataURL('image/png')
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/** Offscreen → service worker. One-way; the worker does the download. */
export const postPairToBackground: PairSink = (files) => {
  const message: AutoDlFramePairMessage = { target: 'background', type: AUTO_DL_FRAME_PAIR, files }
  chrome.runtime.sendMessage(message, () => {
    // Reading lastError marks the absent reply as handled.
    if (chrome.runtime.lastError !== undefined) { /* handled */ }
  })
}
