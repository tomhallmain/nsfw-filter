import { ILogger } from '../../utils/Logger'
import { withTimeout } from '../../utils/messages'
import { Model } from '../Model'

import {
  computeSampleIndices,
  computeSampleTimes,
  GifDecoder,
  GifTracks,
  SamplingConfig,
  timeoutPromise
} from './dynamicSampling'
import { AutoDlSession, autoDlSettingsFrom, FrameSignature } from './autoDlFrames'
import { blockedResult, ClassificationResult, visibleResult } from './ClassificationResult'
import { ClassifierBackend, ClassifierSettings, MediaClassifier } from './MediaClassifier'
import {
  fetchBlobSource,
  fetchMediaBlob,
  loadImageElement,
  MAX_GIF_BLOB_BYTES,
  MAX_VIDEO_BLOB_BYTES
} from './mediaSource'
import {
  applySmallImageWeights,
  DEFAULT_ONNX_MODEL_CONFIG,
  mergeOnnxModelConfig,
  OnnxClassScore,
  OnnxModelConfig,
  positiveScoreFromClassScores,
  scoresFromLogits,
  topPositiveClass
} from './onnxModelConfig'
import { getOnnxConfigUrl, getOnnxModelUrl, getOrtWasmPaths } from './onnxPaths'
import { getOrt, OrtInferenceSession, OrtTensor } from './ortGlobal'
import { drawForClassification, isFlatImage } from './preprocessPixels'

const IMAGE_LOAD_TIMEOUT_MS = 1000
// Budget for fetching source bytes as a blob (see mediaSource.ts), kept apart
// from IMAGE_LOAD_TIMEOUT_MS (decode-only once bytes are local) and from video's
// metadataTimeoutMs (an unrelated wait after the video element already has a src).
const IMAGE_BLOB_FETCH_TIMEOUT_MS = 3000
const VIDEO_BLOB_FETCH_TIMEOUT_MS = 6000
const PREDICTION_TIMEOUT_MS = 10000

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

/**
 * ONNX Runtime Web implementation of MediaClassifier.
 * Expects `models/onnx/model.onnx` (+ optional external weight shards) and
 * ORT WASM binaries under `models/onnx/ort/` (copied at build time).
 */
export class OnnxMediaClassifier implements MediaClassifier {
  public readonly backend: ClassifierBackend = 'onnx'
  public readonly ready: Promise<void>

  private readonly logger: ILogger
  private session: OrtInferenceSession | null = null
  private settings: ClassifierSettings
  private modelConfig: OnnxModelConfig = { ...DEFAULT_ONNX_MODEL_CONFIG }
  private sampling = defaultSampling()
  private predictionChain: Promise<unknown> = Promise.resolve()
  private inputName = 'input'
  private outputName = 'output'
  private executionProvider = 'wasm'
  private preprocessCanvas: HTMLCanvasElement | null = null
  private preprocessCtx: CanvasRenderingContext2D | null = null
  private floatBuffer: Float32Array | null = null
  private readonly autoDl: AutoDlSession | null

  constructor (logger: ILogger, initialSettings: ClassifierSettings, autoDl: AutoDlSession | null = null) {
    this.logger = logger
    this.autoDl = autoDl
    this.settings = initialSettings
    this.applySamplingFromSettings(initialSettings)
    if (initialSettings.logging) logger.enable()
    else logger.disable()

    this.ready = this.loadSession()
  }

  public setSettings (settings: ClassifierSettings): void {
    this.settings = settings
    this.applySamplingFromSettings(settings)
    if (settings.logging) this.logger.enable()
    else this.logger.disable()
  }

  public dispose (): void {
    this.session = null
    this.preprocessCanvas = null
    this.preprocessCtx = null
    this.floatBuffer = null
  }

  public async classifyImage (url: string): Promise<ClassificationResult> {
    await this.ready
    const image = await this.loadImage(url, IMAGE_LOAD_TIMEOUT_MS)
    return await this.enqueuePrediction(async () =>
      await withTimeout(this.classifyElement(image, url), PREDICTION_TIMEOUT_MS, 'ONNX prediction'))
  }

  public async classifyVideo (url: string): Promise<ClassificationResult> {
    await this.ready
    try {
      return await this.sampleVideo(url)
    } catch {
      this.logger.log(`ONNX video sampling failed for ${url}, fallback to static image`)
      return await this.classifyImage(url)
    }
  }

  public async classifyGif (url: string): Promise<ClassificationResult> {
    await this.ready
    try {
      const dynamicResult = await this.sampleGif(url)
      if (dynamicResult !== null) return dynamicResult
    } catch {
      this.logger.log(`ONNX GIF sampling failed for ${url}, fallback to static image`)
    }
    return await this.classifyImage(url)
  }

  private async loadSession (): Promise<void> {
    this.modelConfig = await this.loadModelConfig()

    const ort = getOrt()
    // Prefer multi-thread WASM only when SharedArrayBuffer is available (rare in
    // extension pages). Otherwise stay on one thread — same constraint as TF.js.
    const canMultiThread = typeof SharedArrayBuffer !== 'undefined'
    const hw = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 1) : 1
    ort.env.wasm.numThreads = canMultiThread ? Math.min(4, Math.max(1, hw)) : 1
    ort.env.wasm.simd = true
    ort.env.wasm.proxy = false
    ort.env.wasm.wasmPaths = getOrtWasmPaths()

    const modelUrl = getOnnxModelUrl(this.modelConfig.modelFile)
    const probe = await fetch(modelUrl)
    if (!probe.ok) {
      throw new Error(
        `ONNX model not found at ${modelUrl}. Place ${this.modelConfig.modelFile} (and any external weight shards) under dist/models/onnx/. See models/onnx/README.md.`
      )
    }

    // Use WASM only. ort.min.js does not register the WebGPU EP (that needs
    // ort.webgpu.min.js); requesting "webgpu" only logs a noisy ORT warning.
    this.session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true
    })
    this.executionProvider = 'wasm'

    this.inputName = this.modelConfig.inputName || this.session.inputNames[0] || 'input'
    this.outputName = this.modelConfig.outputName || this.session.outputNames[0] || 'output'

    await this.warmUp()

    const sfwCount = this.modelConfig.classes.filter(c => c.sfw).length
    const nsfwCount = this.modelConfig.classes.length - sfwCount
    this.logger.log(
      `ONNX session ready (${this.modelConfig.architecture}, ${this.modelConfig.inputSize}px, ` +
      `${this.modelConfig.classes.length} classes: ${sfwCount} SFW / ${nsfwCount} positive, ` +
      `ep=${this.executionProvider}, threads=${ort.env.wasm.numThreads}, ` +
      `input=${this.inputName}, output=${this.outputName})`
    )
  }

  private async warmUp (): Promise<void> {
    if (this.session === null) return
    const size = this.modelConfig.inputSize
    const plane = size * size
    const floats = this.getFloatBuffer(plane * 3)
    floats.fill(0)
    const dims = this.modelConfig.layout === 'NHWC'
      ? [1, size, size, 3]
      : [1, 3, size, size]
    const tensor = new (getOrt().Tensor)('float32', floats, dims)
    await this.session.run({ [this.inputName]: tensor })
  }

  private async loadModelConfig (): Promise<OnnxModelConfig> {
    try {
      const response = await fetch(getOnnxConfigUrl())
      if (!response.ok) return mergeOnnxModelConfig(undefined)
      const partial = await response.json() as Partial<OnnxModelConfig>
      return mergeOnnxModelConfig(partial)
    } catch {
      return mergeOnnxModelConfig(undefined)
    }
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

  private nsfwThreshold (): number {
    // Higher strictness => lower score needed to block (same spirit as NSFWJS thresholds).
    return Model.handleFilterStrictness({
      value: this.settings.filterStrictness,
      minValue: 15,
      maxValue: 85
    })
  }

  private async enqueuePrediction<T> (run: () => Promise<T>): Promise<T> {
    const task = this.predictionChain.then(run)
    this.predictionChain = task.catch(() => undefined)
    return await task
  }

  private async classifyElement (
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
    url: string
  ): Promise<ClassificationResult> {
    return (await this.classifyElementWithFrame(media, url)).result
  }

  /** `frame` is absent for a flat frame, which is not run through the model. */
  private async classifyElementWithFrame (
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
    url: string
  ): Promise<{ result: ClassificationResult, frame?: { signature: FrameSignature, pixels: Uint8ClampedArray } }> {
    if (this.session === null) throw new Error('ONNX session is not loaded')

    const pixels = this.readPixels(media)
    if (isFlatImage(pixels)) {
      if (this.logger.status) this.logger.log(`ONNX skipped flat (single-colour) image for ${url}`)
      return { result: visibleResult() }
    }

    const tensor = this.pixelsToTensor(pixels)
    const feeds: Record<string, OrtTensor> = { [this.inputName]: tensor }
    const results = await this.session.run(feeds)
    const output = results[this.outputName]
    const { width, height } = this.mediaDimensions(media)
    const classScores = applySmallImageWeights(
      this.classScoresFromOutput(output),
      width,
      height,
      this.modelConfig
    )
    const score = positiveScoreFromClassScores(classScores)
    const threshold = this.nsfwThreshold()
    const isNsfw = score >= threshold
    const topPositive = topPositiveClass(classScores)

    if (this.logger.status) {
      const top = [...classScores].sort((a, b) => b.probability - a.probability).slice(0, 3)
        .map(c => `${c.name}=${c.probability.toFixed(3)}${c.sfw ? '(sfw)' : ''}`)
        .join(', ')
      this.logger.log(
        `ONNX positive=${score.toFixed(4)} (threshold ${threshold}) ` +
        `size=${width}x${height} top=[${top}] for ${url}`
      )
    }

    const frame = {
      signature: {
        positiveScore: score,
        classes: classScores.map(c => ({ name: c.name, probability: c.probability }))
      },
      pixels
    }
    if (!isNsfw || topPositive === undefined) return { result: visibleResult(), frame }
    return { result: blockedResult(topPositive.name, topPositive.borderColor, score), frame }
  }

  private getPreprocessContext (size: number): CanvasRenderingContext2D {
    if (this.preprocessCanvas === null || this.preprocessCtx === null) {
      this.preprocessCanvas = document.createElement('canvas')
      this.preprocessCanvas.width = size
      this.preprocessCanvas.height = size
      this.preprocessCtx = this.preprocessCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
      if (this.preprocessCtx === null) throw new Error('Unable to create canvas context for ONNX preprocess')
    } else if (this.preprocessCanvas.width !== size || this.preprocessCanvas.height !== size) {
      this.preprocessCanvas.width = size
      this.preprocessCanvas.height = size
    }
    return this.preprocessCtx
  }

  private getFloatBuffer (length: number): Float32Array {
    if (this.floatBuffer === null || this.floatBuffer.length !== length) {
      this.floatBuffer = new Float32Array(length)
    }
    return this.floatBuffer
  }

  /** RGBA pixels of `media` resized to config.inputSize, on the reused canvas. */
  private readPixels (media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Uint8ClampedArray {
    const size = this.modelConfig.inputSize
    const ctx = this.getPreprocessContext(size)

    drawForClassification(ctx, media as CanvasImageSource, size)
    return ctx.getImageData(0, 0, size, size).data
  }

  /** RGB float32, ImageNet-style normalize. Reuses the float buffer across predictions. */
  private pixelsToTensor (data: Uint8ClampedArray): OrtTensor {
    const size = this.modelConfig.inputSize
    const { mean, std } = this.modelConfig.normalize
    const plane = size * size
    const floatData = this.getFloatBuffer(3 * plane)

    let pixel = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = (data[i] / 255 - mean[0]) / std[0]
      const g = (data[i + 1] / 255 - mean[1]) / std[1]
      const b = (data[i + 2] / 255 - mean[2]) / std[2]

      if (this.modelConfig.layout === 'NHWC') {
        const base = pixel * 3
        floatData[base] = r
        floatData[base + 1] = g
        floatData[base + 2] = b
      } else {
        floatData[pixel] = r
        floatData[pixel + plane] = g
        floatData[pixel + 2 * plane] = b
      }
      pixel++
    }

    const dims = this.modelConfig.layout === 'NHWC'
      ? [1, size, size, 3]
      : [1, 3, size, size]

    return new (getOrt().Tensor)('float32', floatData, dims)
  }

  /** Per-class probabilities; positive score = sum of non-SFW classes. */
  private classScoresFromOutput (output: OrtTensor): OnnxClassScore[] {
    const data = output.data
    const values: number[] = []
    for (let i = 0; i < data.length; i++) values.push(Number(data[i]))
    return scoresFromLogits(values, this.modelConfig)
  }

  private mediaDimensions (
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
  ): { width: number, height: number } {
    if (media instanceof HTMLVideoElement) {
      return {
        width: media.videoWidth || media.width || 0,
        height: media.videoHeight || media.height || 0
      }
    }
    if (media instanceof HTMLImageElement) {
      return {
        width: media.naturalWidth || media.width || 0,
        height: media.naturalHeight || media.height || 0
      }
    }
    return { width: media.width || 0, height: media.height || 0 }
  }

  private async loadImage (url: string, timeoutMs: number): Promise<HTMLImageElement> {
    return await loadImageElement(url, IMAGE_BLOB_FETCH_TIMEOUT_MS, timeoutMs, this.modelConfig.inputSize)
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
        backend: 'onnx',
        model: `${this.modelConfig.architecture} (${this.modelConfig.modelFile})`
      }) ?? null

      for (let i = 0; i < sampleTimes.length; i++) {
        await timeoutPromise(this.seekTo(video, sampleTimes[i]), this.sampling.seekTimeoutMs, 'Seek timeout')
        const { result: sample, frame } = await timeoutPromise(
          this.enqueuePrediction(async () => await this.classifyElementWithFrame(video, url)),
          this.sampling.classifyTimeoutMs,
          'Classification timeout'
        )
        autoDl?.observe(frame === undefined
          ? null
          : { index: i, timeSeconds: sampleTimes[i], size: this.modelConfig.inputSize, ...frame })
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
      const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
      if (context === null) throw new Error('Unable to create canvas context for GIF frame')
      context.drawImage(image, 0, 0)
    } finally {
      image.close()
    }

    try {
      return await timeoutPromise(
        this.enqueuePrediction(async () => await this.classifyElement(canvas, url)),
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
