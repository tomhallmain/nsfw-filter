import { ILogger } from '../../utils/Logger'
import { ClassificationResult, unjudgedResult } from '../classifier/ClassificationResult'
import { IUrlClassifier } from '../classifier/MediaClassifier'
import { LRUCache } from '../LRUCache'
import { TabIdUrl } from '../Queue/QueueBase'

export type DynamicMediaSchedulerSettings = {
  sampleRatio: number
  positiveRatio: number
  minSamples: number
  maxSamples: number
  maxConcurrentGlobal: number
  maxConcurrentPerTab: number
  queueLimitPerTab: number
  metadataTimeoutMs: number
  seekTimeoutMs: number
  classifyTimeoutMs: number
  maxSampleDurationSeconds: number
}

type PendingResolver = {
  tabId: number
  resolve: (value: ClassificationResult) => void
  reject: (error: Error) => void
}

type DynamicTask = {
  key: string
  url: string
  tabId: number
  mediaType: 'video' | 'gif'
}

const DEFAULT_SETTINGS: DynamicMediaSchedulerSettings = {
  sampleRatio: 0.06,
  positiveRatio: 0.12,
  minSamples: 2,
  maxSamples: 10,
  maxConcurrentGlobal: 2,
  maxConcurrentPerTab: 1,
  queueLimitPerTab: 30,
  metadataTimeoutMs: 2000,
  seekTimeoutMs: 1200,
  classifyTimeoutMs: 1200,
  maxSampleDurationSeconds: 45
}

/**
 * Service-worker scheduler for video/GIF URLs.
 * Queueing, cache, and concurrency live here; DOM sampling runs in offscreen
 * via IUrlClassifier.predict(url, 'video' | 'gif').
 */
export class DynamicMediaScheduler {
  private readonly classifier: IUrlClassifier
  private readonly logger: ILogger
  private readonly settings: DynamicMediaSchedulerSettings

  private readonly cache: LRUCache<string, ClassificationResult>
  private readonly queue: DynamicTask[]
  private readonly queuedKeys: Set<string>
  private readonly pendingByKey: Map<string, PendingResolver[]>
  private readonly ownerTabByKey: Map<string, number>
  private readonly tabTrackedCount: Map<number, number>
  private readonly inFlightCountByTab: Map<number, number>
  private inFlightGlobalCount: number

  constructor (classifier: IUrlClassifier, logger: ILogger, settings: Partial<DynamicMediaSchedulerSettings> = {}) {
    this.classifier = classifier
    this.logger = logger
    this.settings = { ...DEFAULT_SETTINGS, ...settings }

    this.cache = new LRUCache(200)
    this.queue = []
    this.queuedKeys = new Set()
    this.pendingByKey = new Map()
    this.ownerTabByKey = new Map()
    this.tabTrackedCount = new Map()
    this.inFlightCountByTab = new Map()
    this.inFlightGlobalCount = 0
  }

  public setSettings (settings: Partial<DynamicMediaSchedulerSettings>): void {
    this.settings.sampleRatio = this.normalizeNumber(settings.sampleRatio, this.settings.sampleRatio, 0.01, 1)
    this.settings.positiveRatio = this.normalizeNumber(settings.positiveRatio, this.settings.positiveRatio, 0.01, 1)
    this.settings.minSamples = this.normalizeInteger(settings.minSamples, this.settings.minSamples, 1, 20)
    this.settings.maxSamples = this.normalizeInteger(settings.maxSamples, this.settings.maxSamples, 1, 30)
    this.settings.maxConcurrentGlobal = this.normalizeInteger(settings.maxConcurrentGlobal, this.settings.maxConcurrentGlobal, 1, 4)
    this.settings.maxConcurrentPerTab = this.normalizeInteger(settings.maxConcurrentPerTab, this.settings.maxConcurrentPerTab, 1, 2)
    this.settings.queueLimitPerTab = this.normalizeInteger(settings.queueLimitPerTab, this.settings.queueLimitPerTab, 5, 100)
    this.settings.metadataTimeoutMs = this.normalizeInteger(settings.metadataTimeoutMs, this.settings.metadataTimeoutMs, 200, 10000)
    this.settings.seekTimeoutMs = this.normalizeInteger(settings.seekTimeoutMs, this.settings.seekTimeoutMs, 200, 10000)
    this.settings.classifyTimeoutMs = this.normalizeInteger(settings.classifyTimeoutMs, this.settings.classifyTimeoutMs, 200, 10000)
    this.settings.maxSampleDurationSeconds = this.normalizeInteger(settings.maxSampleDurationSeconds, this.settings.maxSampleDurationSeconds, 1, 300)

    if (this.settings.maxSamples < this.settings.minSamples) {
      this.settings.maxSamples = this.settings.minSamples
    }
    if (this.settings.maxConcurrentPerTab > this.settings.maxConcurrentGlobal) {
      this.settings.maxConcurrentPerTab = this.settings.maxConcurrentGlobal
    }
  }

  public getSamplingSettings (): Pick<DynamicMediaSchedulerSettings,
  'sampleRatio' | 'positiveRatio' | 'minSamples' | 'maxSamples' |
  'metadataTimeoutMs' | 'seekTimeoutMs' | 'classifyTimeoutMs' | 'maxSampleDurationSeconds'
  > {
    return {
      sampleRatio: this.settings.sampleRatio,
      positiveRatio: this.settings.positiveRatio,
      minSamples: this.settings.minSamples,
      maxSamples: this.settings.maxSamples,
      metadataTimeoutMs: this.settings.metadataTimeoutMs,
      seekTimeoutMs: this.settings.seekTimeoutMs,
      classifyTimeoutMs: this.settings.classifyTimeoutMs,
      maxSampleDurationSeconds: this.settings.maxSampleDurationSeconds
    }
  }

  public predict (url: string, tabIdUrl: TabIdUrl, mediaType: 'video' | 'gif'): Promise<ClassificationResult> {
    const key = `${mediaType}:${url}`

    return new Promise((resolve, reject) => {
      if (this.cache.has(key)) {
        resolve(this.cache.get(key) as ClassificationResult)
        return
      }

      const pendingResolvers = this.pendingByKey.get(key)
      if (pendingResolvers !== undefined) {
        pendingResolvers.push({ tabId: tabIdUrl.tabId, resolve, reject })
        return
      }

      if (!this.canTrackTaskForTab(tabIdUrl.tabId)) {
        reject(new Error(`Dynamic media queue limit reached for tab: ${tabIdUrl.tabId}`))
        return
      }

      this.pendingByKey.set(key, [{ tabId: tabIdUrl.tabId, resolve, reject }])
      this.ownerTabByKey.set(key, tabIdUrl.tabId)
      this.incrementTrackedCount(tabIdUrl.tabId)
      this.enqueue({ key, url, tabId: tabIdUrl.tabId, mediaType })
      this.schedule()
    })
  }

  public clearByTabId (tabId: number): void {
    this.removeQueuedTasksForTab(tabId)

    const keys = Array.from(this.pendingByKey.keys())
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const pending = this.pendingByKey.get(key)
      if (pending === undefined) continue

      const cancelled = pending.filter(item => item.tabId === tabId)
      const filtered = pending.filter(item => item.tabId !== tabId)

      for (let j = 0; j < cancelled.length; j++) {
        cancelled[j].reject(new Error('User closed tab or page where this url located'))
      }

      if (filtered.length === 0) {
        this.pendingByKey.delete(key)
        this.releaseTrackedTask(key)
      } else {
        this.pendingByKey.set(key, filtered)
      }
    }
  }

  public clearCache (): void {
    this.cache.clear()
  }

  private enqueue (task: DynamicTask): void {
    if (this.queuedKeys.has(task.key)) return

    this.queue.push(task)
    this.queuedKeys.add(task.key)
  }

  private schedule (): void {
    if (this.inFlightGlobalCount >= this.settings.maxConcurrentGlobal) return

    const taskIndex = this.findNextEligibleTaskIndex()
    if (taskIndex === -1) return

    const task = this.queue.splice(taskIndex, 1)[0]
    this.queuedKeys.delete(task.key)

    this.inFlightGlobalCount++
    this.incrementInFlightForTab(task.tabId)

    this.processTask(task)
      .then(result => {
        this.cache.set(task.key, result)
        this.resolvePending(task.key, result)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.log(`Dynamic media failed for ${task.url}: ${message}`)
        // Deliberately not cached: a cached failure would answer every later
        // request for this url without ever reaching the classifier again.
        this.resolvePending(task.key, unjudgedResult(message))
      })
      .finally(() => {
        this.inFlightGlobalCount--
        this.decrementInFlightForTab(task.tabId)
        this.releaseTrackedTask(task.key)
        this.schedule()
      })

    this.schedule()
  }

  private async processTask (task: DynamicTask): Promise<ClassificationResult> {
    return await this.classifier.predict(task.url, task.mediaType)
  }

  private findNextEligibleTaskIndex (): number {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i]
      const inFlightForTab = this.inFlightCountByTab.get(task.tabId) ?? 0
      if (inFlightForTab < this.settings.maxConcurrentPerTab) return i
    }

    return -1
  }

  private resolvePending (key: string, result: ClassificationResult): void {
    const pending = this.pendingByKey.get(key)
    this.pendingByKey.delete(key)
    if (pending === undefined) return

    for (let i = 0; i < pending.length; i++) {
      pending[i].resolve(result)
    }
  }

  private removeQueuedTasksForTab (tabId: number): void {
    const retained: DynamicTask[] = []

    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i]
      if (task.tabId === tabId) {
        this.queuedKeys.delete(task.key)
        this.releaseTrackedTask(task.key)
      } else {
        retained.push(task)
      }
    }

    this.queue.length = 0
    for (let i = 0; i < retained.length; i++) {
      this.queue.push(retained[i])
    }
  }

  private releaseTrackedTask (key: string): void {
    const tabId = this.ownerTabByKey.get(key)
    if (tabId === undefined) return

    this.ownerTabByKey.delete(key)
    this.decrementTrackedCount(tabId)
  }

  private canTrackTaskForTab (tabId: number): boolean {
    const count = this.tabTrackedCount.get(tabId) ?? 0
    return count < this.settings.queueLimitPerTab
  }

  private incrementTrackedCount (tabId: number): void {
    const count = this.tabTrackedCount.get(tabId) ?? 0
    this.tabTrackedCount.set(tabId, count + 1)
  }

  private decrementTrackedCount (tabId: number): void {
    const count = this.tabTrackedCount.get(tabId) ?? 0
    if (count <= 1) {
      this.tabTrackedCount.delete(tabId)
      return
    }

    this.tabTrackedCount.set(tabId, count - 1)
  }

  private incrementInFlightForTab (tabId: number): void {
    const count = this.inFlightCountByTab.get(tabId) ?? 0
    this.inFlightCountByTab.set(tabId, count + 1)
  }

  private decrementInFlightForTab (tabId: number): void {
    const count = this.inFlightCountByTab.get(tabId) ?? 0
    if (count <= 1) {
      this.inFlightCountByTab.delete(tabId)
      return
    }

    this.inFlightCountByTab.set(tabId, count - 1)
  }

  private normalizeNumber (value: number | undefined, defaultValue: number, min: number, max: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return defaultValue
    return Math.min(max, Math.max(min, value))
  }

  private normalizeInteger (value: number | undefined, defaultValue: number, min: number, max: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return defaultValue
    const intValue = Math.floor(value)
    return Math.min(max, Math.max(min, intValue))
  }
}
