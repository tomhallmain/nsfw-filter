import { browser, image as tfImage, softmax, Tensor, tidy } from '@tensorflow/tfjs-core'
import { GraphModel } from '@tensorflow/tfjs-converter'

import { ILogger } from '../utils/Logger'

import type { FrameSignature } from './classifier/autoDlFrames'
import { blockedResult, ClassificationResult, visibleResult } from './classifier/ClassificationResult'
import { FrameModel, ModelSettings } from './Model'

// Marqo/nsfw-image-detection-384 (ViT-Tiny), converted to a TF.js GraphModel.
// Binary: two logits, class index 0 is NSFW. The graph is NHWC
// [1,384,384,3], which is what browser.fromPixels produces.
export const VIT_INPUT_SIZE = 384
export const VIT_MODEL_PATH = 'models/marqo/model.json'
const NSFW_INDEX = 0

// Marqo's preprocessing: (x/255 - 0.5) / 0.5 per channel. Must match the
// values the model was exported with.
const NORM_MEAN = 0.5
const NORM_STD = 0.5

// Maps the 1..100 strictness slider to a threshold on P(NSFW): low slider =
// lenient (high threshold). The default (55) lands near the converted model's
// best-F1 point (~0.52).
const LENIENT_THRESHOLD = 0.98
const STRICT_THRESHOLD = 0.15

const VIT_BORDER_COLOR = '#e11d48'

export const strictnessToThreshold = (value: number): number => {
  const clamped = Math.min(100, Math.max(1, value))
  return LENIENT_THRESHOLD + ((clamped - 1) / 99) * (STRICT_THRESHOLD - LENIENT_THRESHOLD)
}

export class ViTModel implements FrameModel {
  private readonly model: GraphModel
  private readonly logger: ILogger
  private threshold: number

  constructor (model: GraphModel, logger: ILogger, settings: ModelSettings) {
    this.model = model
    this.logger = logger
    this.threshold = strictnessToThreshold(settings.filterStrictness)
  }

  public setSettings (settings: ModelSettings): void {
    this.threshold = strictnessToThreshold(settings.filterStrictness)
  }

  public async predictMedia (media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, url: string): Promise<ClassificationResult> {
    return (await this.predictMediaWithSignature(media, url)).result
  }

  public async predictMediaWithSignature (
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
    url: string
  ): Promise<{ result: ClassificationResult, signature: FrameSignature }> {
    const start = this.logger.status ? Date.now() : 0
    const prob = this.nsfwProbability(media)
    let probability: number
    try {
      [probability] = await prob.data()
    } finally {
      prob.dispose()
    }

    const blocked = probability >= this.threshold
    if (this.logger.status) {
      this.logger.log(`Media prediction (ViT, ${Date.now() - start} ms) is NSFW ${probability.toFixed(4)} (>= ${this.threshold.toFixed(4)} = ${String(blocked)}) for ${url}`)
    }

    return {
      result: blocked ? blockedResult('NSFW', VIT_BORDER_COLOR, probability) : visibleResult(),
      signature: {
        positiveScore: probability,
        classes: [{ name: 'NSFW', probability }, { name: 'SFW', probability: 1 - probability }]
      }
    }
  }

  public dispose (): void {
    this.model.dispose()
  }

  // Scalar P(NSFW); intermediates are freed by tidy, the caller disposes the result.
  private nsfwProbability (source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Tensor {
    return tidy(() => {
      const pixels = browser.fromPixels(source)
      const resized = tfImage.resizeBilinear(pixels, [VIT_INPUT_SIZE, VIT_INPUT_SIZE])
      const normalized = resized.toFloat().div(255).sub(NORM_MEAN).div(NORM_STD).expandDims(0)
      const logits = this.model.predict(normalized) as Tensor
      return softmax(logits).reshape([2]).slice([NSFW_INDEX], [1]).reshape([])
    })
  }
}
