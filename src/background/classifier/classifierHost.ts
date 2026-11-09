import { ILogger } from '../../utils/Logger'

import { ClassificationResult } from './ClassificationResult'
import { resolveBackend } from './createClassifier'
import { ClassifierBackend, ClassifierSettings, MediaClassifier, MediaType } from './MediaClassifier'

export type ClassifierFactory = (
  backend: ClassifierBackend,
  logger: ILogger,
  settings: ClassifierSettings
) => MediaClassifier

type ActiveClassifier = {
  backend: ClassifierBackend
  instance: MediaClassifier
  ready: Promise<void>
}

/** Shortest gap between load attempts after one fails. */
export const REBUILD_COOLDOWN_MS = 10000

/**
 * Owns the classifier instance inside the offscreen document.
 *
 * Every classify call awaits `ready`, so an instance whose load failed can
 * never be used again -- recovery means building a new one. The document
 * outlives the service worker by days, so without that the first failed load
 * stops all classification until someone reloads the extension by hand.
 * Builds run one at a time, and no sooner than REBUILD_COOLDOWN_MS after a
 * failure, so a page full of media cannot start a model load per item.
 */
export class ClassifierHost {
  private readonly createClassifier: ClassifierFactory
  private readonly logger: ILogger
  private readonly now: () => number

  private settings: ClassifierSettings
  private active: ActiveClassifier | null = null
  private buildChain: Promise<unknown> = Promise.resolve()
  private lastFailure: { at: number, error: Error } | null = null

  constructor (
    createClassifier: ClassifierFactory,
    logger: ILogger,
    initialSettings: ClassifierSettings,
    now: () => number = Date.now
  ) {
    this.createClassifier = createClassifier
    this.logger = logger
    this.settings = initialSettings
    this.now = now
  }

  public async ensure (next: ClassifierSettings): Promise<MediaClassifier> {
    this.settings = next
    const backend = resolveBackend(next)
    const current = this.active

    if (current !== null && current.backend === backend) {
      current.instance.setSettings(next)
      return current.instance
    }

    return (await this.build(backend, next)).instance
  }

  public async classify (url: string, mediaType: MediaType): Promise<ClassificationResult> {
    const classifier = await this.ensure(this.settings)

    if (mediaType === 'video') return await classifier.classifyVideo(url)
    if (mediaType === 'gif') return await classifier.classifyGif(url)
    return await classifier.classifyImage(url)
  }

  private async build (backend: ClassifierBackend, settings: ClassifierSettings): Promise<ActiveClassifier> {
    const task = this.buildChain.then(async () => {
      // An earlier build in this chain may already have produced what this
      // caller wanted.
      const current = this.active
      if (current !== null && current.backend === backend) return current

      return await this.startClassifier(backend, settings)
    })

    this.buildChain = task.catch(() => undefined)
    return await task
  }

  private async startClassifier (
    backend: ClassifierBackend,
    settings: ClassifierSettings
  ): Promise<ActiveClassifier> {
    const failure = this.lastFailure
    if (failure !== null && this.now() - failure.at < REBUILD_COOLDOWN_MS) throw failure.error

    const previous = this.active

    try {
      const built = await this.instantiateWithFallback(backend, settings)
      this.active = built
      this.lastFailure = null
      return built
    } catch (error) {
      this.active = null
      this.lastFailure = { at: this.now(), error: error as Error }
      throw error
    } finally {
      if (previous !== null && previous !== this.active) previous.instance.dispose?.()
    }
  }

  private async instantiateWithFallback (
    backend: ClassifierBackend,
    settings: ClassifierSettings
  ): Promise<ActiveClassifier> {
    try {
      return await this.instantiate(backend, settings)
    } catch (error) {
      this.logger.error(error as Error)
      // Reported regardless of the logging setting: a dead classifier is
      // otherwise silent, and this console is where it gets diagnosed.
      console.error(`[NSFW-Filter] Failed to start classifier "${backend}":`, error)

      if (backend === 'nsfwjs') throw error

      console.warn('[NSFW-Filter] Falling back to nsfwjs classifier')
      return await this.instantiate('nsfwjs', { ...settings, classifierBackend: 'nsfwjs' })
    }
  }

  private async instantiate (
    backend: ClassifierBackend,
    settings: ClassifierSettings
  ): Promise<ActiveClassifier> {
    const instance = this.createClassifier(backend, this.logger, settings)
    const ready = instance.ready
    // Claim the rejection now; nothing else awaits `ready` until a later call.
    ready.catch(() => undefined)

    try {
      await ready
    } catch (error) {
      // Release whatever a partly-built classifier took before it failed;
      // this instance is discarded either way.
      instance.dispose?.()
      throw error
    }

    this.logger.log(`Classifier backend ready: ${backend}`)
    return { backend, instance, ready }
  }
}
