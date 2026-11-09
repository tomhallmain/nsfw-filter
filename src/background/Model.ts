import type { NSFWJS, PredictionType } from 'nsfwjs/core'

import { ILogger } from '../utils/Logger'

import type { FrameSignature } from './classifier/autoDlFrames'
import { blockedResult, ClassificationResult, visibleResult } from './classifier/ClassificationResult'

export type ModelSettings = {
  filterStrictness: number
}

/** All NSFWJS classes, so a frame's full signature is available. */
const NSFWJS_CLASS_COUNT = 5

const NSFWJS_BORDER_COLORS: Record<string, string> = {
  Porn: '#e11d48',
  Hentai: '#7c3aed',
  Sexy: '#ea580c'
}

type MediaSource = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement

/** One loaded set of TF.js weights, as NsfwjsMediaClassifier drives it. */
export type FrameModel = {
  predictMedia: (media: MediaSource, url: string) => Promise<ClassificationResult>
  predictMediaWithSignature: (media: MediaSource, url: string) => Promise<{ result: ClassificationResult, signature: FrameSignature }>
  setSettings: (settings: ModelSettings) => void
  dispose?: () => void
}

export class Model implements FrameModel {
  private readonly model: NSFWJS
  private readonly logger: ILogger

  private readonly FILTER_LIST: Set<string>
  private readonly firstFilterPercentages: Map<string, number>
  private readonly secondFilterPercentages: Map<string, number>

  constructor (model: NSFWJS, logger: ILogger, settings: ModelSettings) {
    this.model = model
    this.logger = logger

    this.logger.log('Model is loaded')

    this.FILTER_LIST = new Set(['Hentai', 'Porn', 'Sexy'])

    this.firstFilterPercentages = new Map()
    this.secondFilterPercentages = new Map()

    this.setSettings(settings)
  }

  public setSettings (settings: ModelSettings): void {
    const { filterStrictness } = settings
    this.firstFilterPercentages.clear()
    this.secondFilterPercentages.clear()

    for (const className of this.FILTER_LIST.values()) {
      this.firstFilterPercentages.set(
        className,
        Model.handleFilterStrictness({
          value: filterStrictness,
          maxValue: 100,
          minValue: className === 'Porn' ? 40 : 60
        })
      )
    }

    for (const className of this.FILTER_LIST.values()) {
      this.secondFilterPercentages.set(
        className,
        Model.handleFilterStrictness({
          value: filterStrictness,
          maxValue: 50,
          minValue: className === 'Porn' ? 15 : 25
        })
      )
    }
  }

  public dispose (): void {
    this.model.dispose()
  }

  public async predictMedia (media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, url: string): Promise<ClassificationResult> {
    return (await this.predictMediaWithSignature(media, url)).result
  }

  public async predictMediaWithSignature (
    media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
    url: string
  ): Promise<{ result: ClassificationResult, signature: FrameSignature }> {
    const start = this.logger.status ? new Date().getTime() : 0

    const prediction = await this.model.classify(media, NSFWJS_CLASS_COUNT)
    const outcome = this.handlePrediction(prediction)

    if (this.logger.status) {
      const end = new Date().getTime()
      this.logger.log(`Media prediction (${end - start} ms) is ${outcome.className} ${outcome.probability} for ${url}`)
    }

    return { result: outcome.result, signature: this.signatureOf(prediction) }
  }

  /** Positive score is the summed probability of the filtered classes. */
  private signatureOf (prediction: PredictionType[]): FrameSignature {
    let positiveScore = 0
    for (const { className, probability } of prediction) {
      if (this.FILTER_LIST.has(className)) positiveScore += probability
    }
    return {
      positiveScore,
      classes: prediction.map(({ className, probability }) => ({ name: className, probability }))
    }
  }

  private handlePrediction (prediction: PredictionType[]): { result: ClassificationResult, className: string, probability: number } {
    const [{ className: cn1, probability: pb1 }, { className: cn2, probability: pb2 }] = prediction

    const result1 = this.FILTER_LIST.has(cn1) && pb1 > (this.firstFilterPercentages.get(cn1) as number)
    if (result1) {
      return {
        result: blockedResult(cn1, NSFWJS_BORDER_COLORS[cn1], pb1),
        className: cn1,
        probability: pb1
      }
    }

    const result2 = this.FILTER_LIST.has(cn2) && pb2 > (this.secondFilterPercentages.get(cn2) as number)
    if (result2) {
      return {
        result: blockedResult(cn2, NSFWJS_BORDER_COLORS[cn2], pb2),
        className: cn2,
        probability: pb2
      }
    }

    return ({ result: visibleResult(), className: cn1, probability: pb1 })
  }

  public static handleFilterStrictness ({ value, minValue, maxValue }: {value: number, minValue: number, maxValue: number}): number {
    const MIN = minValue
    const MAX = maxValue

    const calc = (value: number): number => {
      if (value <= 1) return MAX
      else if (value >= 100) return MIN
      else {
        const coefficient = 1 - (value / 100)
        return (coefficient * (MAX - MIN)) + MIN
      }
    }

    return Math.round((calc(value) / 100) * 10000) / 10000
  }
}
