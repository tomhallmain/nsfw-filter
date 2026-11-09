import { PredictionRequest, PredictionResponse } from '../../utils/messages'

import { PageTally } from './pageSensitivity'

type IFilter = {
  getBlockAmount: () => number
}

type FilterRequestWaiter = {
  resolve: (value: PredictionResponse) => void
  reject: (error: PredictionRequest) => void
}

type FilterRequestQueueValue = {
  waiters: FilterRequestWaiter[]
  deadline: number
  request: PredictionRequest
}

// Media waits on its verdict, and nothing downstream is guaranteed to answer:
// the service worker can be torn down mid-request, and a wedged offscreen
// document never replies. Past this, the request settles as failed, which
// takes the normal failure path instead of waiting for the life of the page.
export const ANALYSIS_DEADLINE_MS = 60000

/**
 * A blob: URL is only resolvable inside the exact browsing context that
 * created it. Every blob: URL a filter sees here was minted by the page,
 * which the offscreen document never shares, so classifying it by URL can
 * never succeed -- no fetch, timeout, or retry changes that.
 */
export const isCrossContextBlobUrl = (url: string): boolean => url.startsWith('blob:')

export class Filter implements IFilter {
  /** Attempts to re-classify one element after a failure, before leaving it alone. */
  private static readonly MAX_RETRIES = 3
  /**
   * Long enough for the offscreen classifier's rebuild cooldown to expire, so a
   * retry can meet a freshly built model rather than the cached failure.
   */
  private static readonly RETRY_DELAY_MS = 11000

  protected blockedItems: number
  /** Shared with every other filter on the page. */
  protected readonly tally: PageTally
  private readonly requestQueue: Map<string, FilterRequestQueueValue>

  constructor (tally: PageTally = new PageTally()) {
    this.blockedItems = 0
    this.tally = tally
    this.requestQueue = new Map()
  }

  public getBlockAmount (): number {
    return this.blockedItems
  }

  /**
   * A failed classification is not a verdict: it is evidence of nothing, and
   * counting it would drag the page's blocked-to-analyzed ratio down while the
   * classifier is the thing at fault.
   */
  protected recordVerdict (blocked: boolean): void {
    if (blocked) this.blockedItems++
    this.tally.record(blocked)
  }

  protected async requestToAnalyzeImage (request: PredictionRequest): Promise<PredictionResponse> {
    return await new Promise((resolve, reject) => {
      const queueName = this.getQueueName(request)

      try {
        const queued = this.requestQueue.get(queueName)
        if (queued !== undefined) {
          queued.waiters.push({ resolve, reject })
        } else {
          this.requestQueue.set(queueName, {
            waiters: [{ resolve, reject }],
            deadline: window.setTimeout(() => this._giveUp(queueName), ANALYSIS_DEADLINE_MS),
            request
          })

          this._requestToAnalyzeImage(request, queueName)
        }
      } catch {
        const pending = this._take(queueName)
        if (pending !== undefined) {
          for (const { reject } of pending.waiters) reject(request)
        } else {
          reject(request)
        }
      }
    })
  }

  /** Removes the entry and stops its timers; undefined if it already settled. */
  private _take (queueName: string): FilterRequestQueueValue | undefined {
    const queued = this.requestQueue.get(queueName)
    if (queued === undefined) return undefined

    window.clearTimeout(queued.deadline)
    window.clearTimeout(queued.request.reconectTimer)
    this.requestQueue.delete(queueName)
    return queued
  }

  /**
   * A media key can be queued again after a request is abandoned, so a late
   * reply or retry must prove it still belongs to the queued entry.
   */
  private _isCurrent (request: PredictionRequest, queueName: string): boolean {
    return this.requestQueue.get(queueName)?.request === request
  }

  private _giveUp (queueName: string): void {
    const pending = this._take(queueName)
    if (pending === undefined) return

    const { url, mediaType } = pending.request
    console.warn(`[NSFW-Filter] No verdict for ${url} after ${ANALYSIS_DEADLINE_MS}ms, leaving it unjudged`)
    const response = new PredictionResponse(false, url, 'Analysis timed out', mediaType)
    for (const { resolve } of pending.waiters) resolve(response)
  }

  private _requestToAnalyzeImage (request: PredictionRequest, queueName: string): void {
    chrome.runtime.sendMessage(request, (response: PredictionResponse) => {
      // Not cancellable, so this can fire for a request already given up on.
      if (!this._isCurrent(request, queueName)) return

      if (chrome.runtime.lastError !== null && chrome.runtime.lastError !== undefined) {
        this._handleBackgroundErrors(request, queueName, chrome.runtime.lastError.message)
        return
      }

      if (this._isRecoverableResponse(response)) {
        this._handleBackgroundErrors(request, queueName, response.message)
        return
      }

      this.settleQueue(queueName, response)
    })
  }

  /** Answers every caller coalesced onto this request. */
  private settleQueue (queueName: string, response: PredictionResponse): void {
    for (const { resolve } of this._take(queueName)?.waiters ?? []) {
      resolve(response)
    }
  }

  /**
   * Re-runs `analyze` on an element whose classification failed. The budget is
   * per element for its lifetime: a page whose classifier is down must not keep
   * queueing work for media it has already given up on. `datasetKey` separates
   * budgets where one element carries more than one classifiable target, as an
   * element with both its own background and a ::before background does.
   */
  protected retryAfterFailure (
    element: HTMLElement,
    analyze: () => void,
    datasetKey: string = 'nsfwFilterRetry'
  ): void {
    const attempts = Number(element.dataset[datasetKey] ?? '0') + 1
    if (attempts > Filter.MAX_RETRIES) return

    element.dataset[datasetKey] = String(attempts)
    window.setTimeout(analyze, Filter.RETRY_DELAY_MS)
  }

  private _isRecoverableResponse (response: PredictionResponse): boolean {
    return response.failed
  }

  private _handleBackgroundErrors (request: PredictionRequest, queueName: string, message: string | undefined): void {
    const reconnectCount = request.clearTimer()
    console.log(`[NSFW-Filter] Cannot connect to background worker for ${request.url} media, attempt ${reconnectCount}, error: ${message}`)

    if (reconnectCount > 5) {
      console.warn(`[NSFW-Filter] Background worker is down, leaving ${request.url} unjudged`)
      this.settleQueue(queueName, new PredictionResponse(false, request.url, 'Background worker doesn\'t working'))
    } else {
      request.reconectTimer = window.setTimeout(() => this._requestToAnalyzeImage(request, queueName), 500)
    }
  }

  private getQueueName (request: PredictionRequest): string {
    return `${request.mediaType}:${request.url}`
  }
}
