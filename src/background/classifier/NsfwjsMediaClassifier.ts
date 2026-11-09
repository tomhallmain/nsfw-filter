import { enableProdMode } from '@tensorflow/tfjs-core'
import { load as loadNsfwjs } from 'nsfwjs/core'

import { ILogger } from '../../utils/Logger'
import { withTimeout } from '../../utils/messages'
import { FrameModel, Model, ModelSettings } from '../Model'
import { getModelPath, setupTfBackend } from '../setupTfBackend'

import {
  computeSampleIndices,
  computeSampleTimes,
  GifDecoder,
  GifTracks,
  SamplingConfig,
  timeoutPromise
} from './dynamicSampling'
import { AutoDlSession, autoDlSettingsFrom } from './autoDlFrames'
import { ClassificationResult, visibleResult } from './ClassificationResult'
import { ClassifierBackend, ClassifierSettings, MediaClassifier } from './MediaClassifier'
import {
  fetchBlobSource,
  fetchMediaBlob,
  loadImageElement,
  MAX_GIF_BLOB_BYTES,
  MAX_VIDEO_BLOB_BYTES
} from './mediaSource'
import { drawForClassification } from './preprocessPixels'

enableProdMode()

const IMAGE_LOAD_TIMEOUT_MS = 1000
// Budget for fetching source bytes as a blob (see mediaSource.ts), kept apart
// from IMAGE_LOAD_TIMEOUT_MS (decode-only once bytes are local) and from video's
// metadataTimeoutMs (an unrelated wait after the video element already has a src).
const IMAGE_BLOB_FETCH_TIMEOUT_MS = 3000
const VIDEO_BLOB_FETCH_TIMEOUT_MS = 6000
const PREDICTION_TIMEOUT_MS = 10000
const MAX_LOAD_ATTEMPTS = 5

const defaultSampling = (): SamplingConfig & {
  metadataTimeoutMs: number
  seekTimeoutMs: number
  classifyTimeoutMs: number
} => ({
  sampleRatio: 0.06,
  positiveRatio: 0.12,
  minSamples: 2,
  maxSamples: 10,
  maxSampleDurationSeconds: 45,
  metadataTimeoutMs: 2000,
  seekTimeoutMs: 1200,
  classifyTimeoutMs: 1200
})

/** Which TF.js weights a NsfwjsMediaClassifier runs, and how to load them. */
export type TfModelSpec = {
  backend: Extract<ClassifierBackend, 'nsfwjs'>
  /** Recorded in auto-DL metadata. */
  label: string
  imageSize: number
  load: (logger: ILogger, settings: ModelSettings) => Promise<FrameModel>
}

const NSFWJS_IMAGE_SIZE = 224

export const NSFWJS_MODEL_SPEC: TfModelSpec = {
  backend: 'nsfwjs',
  label: `MobileNet_v1.2 (${NSFWJS_IMAGE_SIZE}px)`,
  imageSize: NSFWJS_IMAGE_SIZE,
  load: async (logger, settings) => {
    const nsfwjs = await loadNsfwjs(getModelPath(), { size: NSFWJS_IMAGE_SIZE, type: 'graph' })
    return new Model(nsfwjs, logger, settings)
  }
}

/**
 * TensorFlow.js implementation of MediaClassifier, for any TfModelSpec.
 * Runs only in the offscreen document (DOM + WASM).
 */
export class NsfwjsMediaClassifier implements MediaClassifier {
  public readonly backend: ClassifierBackend
  public readonly ready: Promise<void>

  private readonly logger: ILogger
  private readonly spec: TfModelSpec
  private model: FrameModel | null = null
  private settings: ClassifierSettings
  private sampling = defaultSampling()
  private predictionChain: Promise<unknown> = Promise.resolve()
  private readonly autoDl: AutoDlSession | null

  constructor (
    logger: ILogger,
    initialSettings: ClassifierSettings,
    autoDl: AutoDlSession | null = null,
    spec: TfModelSpec = NSFWJS_MODEL_SPEC
  ) {
    this.logger = logger
    this.spec = spec
    this.backend = spec.backend
    this.autoDl = autoDl
    this.settings = initialSettings
    this.applySamplingFromSettings(initialSettings)
    if (initialSettings.logging) logger.enable()
    else logger.disable()

    this.ready = this.loadModel()
  }

  public setSettings (settings: ClassifierSettings): void {
    this.settings = settings
    this.applySamplingFromSettings(settings)
    if (settings.logging) this.logger.enable()
    else this.logger.disable()
    if (this.model !== null) {
      this.model.setSettings({ filterStrictness: settings.filterStrictness })
    }
  }

  public async classifyImage (url: string): Promise<ClassificationResult> {
    await this.ready
    if (this.model === null) throw new Error('Model is not loaded')

    const image = await this.loadImage(url, IMAGE_LOAD_TIMEOUT_MS)
    return await this.enqueuePrediction(async () =>
      await withTimeout(this.model!.predictMedia(image, url), PREDICTION_TIMEOUT_MS, 'Prediction'))
  }

  public async classifyVideo (url: string): Promise<ClassificationResult> {
    await this.ready
    if (this.model === null) throw new Error('Model is not loaded')

    try {
      return await this.sampleVideo(url)
    } catch {
      this.logger.log(`Dynamic video sampling failed for ${url}, fallback to static image prediction`)
      return await this.classifyImage(url)
    }
  }

  public async classifyGif (url: string): Promise<ClassificationResult> {
    await this.ready
    if (this.model === null) throw new Error('Model is not loaded')

    try {
      const dynamicResult = await this.sampleGif(url)
      if (dynamicResult !== null) return dynamicResult
    } catch {
      this.logger.log(`Dynamic GIF sampling failed for ${url}, fallback to static image prediction`)
    }

    return await this.classifyImage(url)
  }

  private applySamplingFromSettings (settings: ClassifierSettings): void {
    const s = this.sampling
    if (typeof settings.dynamicSampleRatio === 'number') s.sampleRatio = settings.dynamicSampleRatio
    if (typeof settings.dynamicPositiveRatio === 'number') s.positiveRatio = settings.dynamicPositiveRatio
    if (typeof settings.dynamicMinSamples === 'number') s.minSamples = settings.dynamicMinSamples
    if (typeof settings.dynamicMaxSamples === 'number') s.maxSamples = settings.dynamicMaxSamples
    if (typeof settings.dynamicMaxSampleDurationSeconds === 'number') s.maxSampleDurationSeconds = settings.dynamicMaxSampleDurationSeconds
    if (typeof settings.dynamicMetadataTimeoutMs === 'number') s.metadataTimeoutMs = settings.dynamicMetadataTimeoutMs
    if (typeof settings.dynamicSeekTimeoutMs === 'number') s.seekTimeoutMs = settings.dynamicSeekTimeoutMs
    if (typeof settings.dynamicClassifyTimeoutMs === 'number') s.classifyTimeoutMs = settings.dynamicClassifyTimeoutMs
  }

  private async loadModel (): Promise<void> {
    let attempts = 0
    while (true) {
      try {
        await setupTfBackend()
        this.model = await this.spec.load(this.logger, { filterStrictness: this.settings.filterStrictness })
        return
      } catch (error) {
        attempts++
        this.logger.error(error as Error)
        this.logger.log(`Reload model, attempt: ${attempts}`)
        if (attempts >= MAX_LOAD_ATTEMPTS) throw error
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  }

  public dispose (): void {
    this.model?.dispose?.()
    this.model = null
  }

  private async enqueuePrediction<T> (run: () => Promise<T>): Promise<T> {
    const task = this.predictionChain.then(run)
    this.predictionChain = task.catch(() => undefined)
    return await task
  }

  private async loadImage (url: string, timeoutMs: number): Promise<HTMLImageElement> {
    return await loadImageElement(url, IMAGE_BLOB_FETCH_TIMEOUT_MS, timeoutMs, this.spec.imageSize)
  }

  private async sampleVideo (url: string): Promise<ClassificationResult> {
    const blobSource = await fetchBlobSource(url, VIDEO_BLOB_FETCH_TIMEOUT_MS, MAX_VIDEO_BLOB_BYTES)
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.setAttribute('playsinline', 'true')
    video.preload = 'metadata'
    video.src = blobSource?.objectUrl ?? url

    try {
      await timeoutPromise(this.waitForVideoMetadata(video), this.sampling.metadataTimeoutMs, 'Metadata timeout')
      const sampleTimes = computeSampleTimes(video.duration, this.sampling)
      if (sampleTimes.length === 0) return visibleResult()

      const requiredPositives = Math.ceil(sampleTimes.length * this.sampling.positiveRatio)
      let positiveCount = 0
      let bestPositive: ClassificationResult | undefined
      const autoDl = this.autoDl?.startVideo(url, autoDlSettingsFrom(this.settings), {
        backend: this.spec.backend,
        model: this.spec.label
      }) ?? null

      for (let i = 0; i < sampleTimes.length; i++) {
        await timeoutPromise(this.seekTo(video, sampleTimes[i]), this.sampling.seekTimeoutMs, 'Seek timeout')

        const { result: sample, signature } = await timeoutPromise(
          this.enqueuePrediction(async () => await this.model!.predictMediaWithSignature(video, url)),
          this.sampling.classifyTimeoutMs,
          'Classification timeout'
        )
        if (autoDl !== null) {
          // The video stays on this frame until the next seek.
          const pixels = this.readFramePixels(video)
          autoDl.observe(pixels === null
            ? null
            : { index: i, timeSeconds: sampleTimes[i], size: this.spec.imageSize, signature, pixels })
        }

        if (sample.blocked) {
          positiveCount++
          bestPositive = sample
          if (positiveCount >= requiredPositives) return sample
        }

        const remaining = sampleTimes.length - (i + 1)
        if (positiveCount + remaining < requiredPositives) return visibleResult()

        if (i % 2 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      }

      return bestPositive ?? visibleResult()
    } finally {
      video.pause()
      video.removeAttribute('src')
      video.load()
      blobSource?.revoke()
    }
  }

  /** The frame as the model saw it (imageSize², over the preprocessing backdrop). */
  private readFramePixels (video: HTMLVideoElement): Uint8ClampedArray | null {
    const canvas = document.createElement('canvas')
    canvas.width = this.spec.imageSize
    canvas.height = this.spec.imageSize
    try {
      const ctx = canvas.getContext('2d')
      if (ctx === null) return null
      drawForClassification(ctx, video, this.spec.imageSize)
      return ctx.getImageData(0, 0, this.spec.imageSize, this.spec.imageSize).data
    } catch (error) {
      this.logger.log(`Auto-DL could not read frame pixels: ${(error as Error)?.message ?? String(error)}`)
      return null
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  private async sampleGif (url: string): Promise<ClassificationResult | null> {
    const decoderConstructor = (window as unknown as { ImageDecoder?: unknown }).ImageDecoder
    if (typeof decoderConstructor !== 'function') return null

    const blob = await fetchMediaBlob(url, this.sampling.metadataTimeoutMs, MAX_GIF_BLOB_BYTES)
    if (blob === null) return null

    const mimeType = blob.type || 'image/gif'
    if (mimeType.includes('gif') === false) return null

    const decoder = new (decoderConstructor as new (init: { data: Blob, type: string }) => unknown)({ data: blob, type: mimeType }) as GifDecoder

    try {
      return await this.sampleGifFrames(decoder, url)
    } finally {
      // Holds the encoded bytes and every frame it decoded until it is closed,
      // in a document that stays alive for days.
      decoder.close()
    }
  }

  private async sampleGifFrames (decoder: GifDecoder, url: string): Promise<ClassificationResult | null> {
    const tracks = decoder.tracks
    if (tracks?.ready !== undefined) {
      await timeoutPromise(tracks.ready, this.sampling.metadataTimeoutMs, 'GIF track metadata timeout')
    }

    const totalFrames = this.resolveGifFrameCount(tracks)
    const sampleIndices = computeSampleIndices(totalFrames, this.sampling)
    if (sampleIndices.length === 0) return null

    const requiredPositives = Math.ceil(sampleIndices.length * this.sampling.positiveRatio)
    let positiveCount = 0
    let bestPositive: ClassificationResult | undefined

    for (let i = 0; i < sampleIndices.length; i++) {
      const sample = await this.classifyGifFrame(decoder, sampleIndices[i], url)

      if (sample.blocked) {
        positiveCount++
        bestPositive = sample
        if (positiveCount >= requiredPositives) return sample
      }

      const remaining = sampleIndices.length - (i + 1)
      if (positiveCount + remaining < requiredPositives) return visibleResult()
    }

    return bestPositive ?? visibleResult()
  }

  private async classifyGifFrame (decoder: GifDecoder, frameIndex: number, url: string): Promise<ClassificationResult> {
    const decoding = decoder.decode({ frameIndex })

    let frame: { image: ImageBitmap }
    try {
      frame = await timeoutPromise(decoding, this.sampling.classifyTimeoutMs, 'GIF decode timeout')
    } catch (error) {
      // A frame arriving after the timeout still owns its buffer.
      decoding.then(late => late.image.close(), () => undefined)
      throw error
    }

    const image = frame.image
    const canvas = document.createElement('canvas')

    try {
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('Unable to create canvas context for GIF frame')
      context.drawImage(image, 0, 0)
    } finally {
      image.close()
    }

    try {
      return await timeoutPromise(
        this.enqueuePrediction(async () => await this.model!.predictMedia(canvas, url)),
        this.sampling.classifyTimeoutMs,
        'GIF classification timeout'
      )
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  private async waitForVideoMetadata (video: HTMLVideoElement): Promise<void> {
    return await new Promise((resolve, reject) => {
      const onLoaded = (): void => { cleanup(); resolve() }
      const onError = (): void => { cleanup(); reject(new Error('Unable to load video metadata')) }
      const cleanup = (): void => {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onError)
      }
      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', onError)
      video.load()
    })
  }

  private async seekTo (video: HTMLVideoElement, time: number): Promise<void> {
    if (Math.abs(video.currentTime - time) < 0.01) return

    await new Promise<void>((resolve, reject) => {
      const onSeeked = (): void => { cleanup(); resolve() }
      const onError = (): void => { cleanup(); reject(new Error('Seek failed')) }
      const cleanup = (): void => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
      }
      video.addEventListener('seeked', onSeeked, { once: true })
      video.addEventListener('error', onError, { once: true })
      video.currentTime = time
    })
  }

  private resolveGifFrameCount (tracks: GifTracks | undefined): number {
    const selectedTrack = tracks?.selectedTrack
    if (selectedTrack !== undefined && selectedTrack !== null && typeof selectedTrack.frameCount === 'number') {
      return Math.max(1, selectedTrack.frameCount)
    }

    if (tracks !== undefined && (tracks.length ?? 0) > 0) {
      const firstTrack = tracks[0]
      if (typeof firstTrack?.frameCount === 'number') return Math.max(1, firstTrack.frameCount)
    }

    return 1
  }
}
