import { setTotalBlocked } from '../../popup/redux/actions/statistics'
import { ILogger } from '../../utils/Logger'
import { ClassificationResult } from '../classifier/ClassificationResult'
import { IUrlClassifier } from '../classifier/MediaClassifier'
import { IReduxedStorage } from '../types'

import { ConcurrentQueue } from './ConcurrentQueue'
import { QueueBase, requestQueueValue, TabIdUrl } from './QueueBase'

type HandlerParams = {
  url: string
  tabIdUrl: TabIdUrl
  result: ClassificationResult
  error: Error
}

type OnProcessParam = Pick<HandlerParams, 'url' | 'tabIdUrl'>
export type OnSuccessParam = Pick<HandlerParams, 'url' | 'result'>
export type OnFailureParam = Pick<HandlerParams, 'url' | 'error'>
type OnDoneParam = Pick<HandlerParams, 'url'>

export type CallbackFunction = (err: unknown | undefined, result: unknown | undefined) => undefined

export class PredictionQueue extends QueueBase {
  protected readonly predictionQueue: ConcurrentQueue<OnProcessParam>

  constructor (model: IUrlClassifier, logger: ILogger, store: IReduxedStorage) {
    super(model, logger, store)

    this.predictionQueue = new ConcurrentQueue({
      concurrency: 1,
      timeout: 0,
      onProcess: this.onProcess.bind(this),
      onSuccess: this.onSuccess.bind(this),
      onFailure: this.onFailure.bind(this),
      onDone: this.onDone.bind(this),
      onDrain: this.onDrain.bind(this)
    })
  }

  private onProcess ({ url, tabIdUrl }: OnProcessParam, callback: CallbackFunction): void {
    if (!this._checkCurrentTabIdUrlStatus(tabIdUrl)) {
      callback({ url, error: new Error('User closed tab or page where this url located') }, undefined)
      return
    }

    this.model.predict(url, 'image')
      .then(result => callback(undefined, { url, result }))
      .catch((error: Error) => callback({ url, error }, undefined))
  }

  private onSuccess ({ url, result }: OnSuccessParam): void {
    if (!this._checkUrlStatus(url)) return

    if (result.blocked) this.totalBlocked++
    this.cache.set(url, result)

    for (const [{ resolve }] of this.requestMap.get(url) as requestQueueValue) {
      resolve(result)
    }
  }

  private onFailure ({ url, error }: OnFailureParam): void {
    if (!this._checkUrlStatus(url)) return

    // Failures stay out of the cache, unlike results: a timeout or an
    // unreachable offscreen document says nothing about the media, and
    // caching it would leave the url unfiltered for the rest of this
    // worker's life.
    for (const [{ reject }] of this.requestMap.get(url) as requestQueueValue) {
      reject(error)
    }
  }

  private onDone ({ url }: OnDoneParam): void {
    this.requestMap.delete(url)
  }

  private onDrain (): void {
    const tmpTotalBlocked = this.totalBlocked
    this.store.dispatch(setTotalBlocked(tmpTotalBlocked))
  }
}
