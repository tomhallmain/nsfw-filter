import { DynamicMediaScheduler } from '../../src/background/media/DynamicMediaScheduler'
import { IUrlClassifier } from '../../src/background/classifier/MediaClassifier'
import { blockedResult, visibleResult } from '../../src/background/classifier/ClassificationResult'
import { ILogger } from '../../src/utils/Logger'
import { computeSampleIndices } from '../../src/background/classifier/dynamicSampling'

describe('background => DynamicMediaScheduler', () => {
  const buildScheduler = (settings: Record<string, number> = {}): { scheduler: DynamicMediaScheduler, classifier: jest.Mocked<IUrlClassifier>, logger: any } => {
    const classifier = {
      predict: jest.fn(),
      setSettings: jest.fn()
    } as unknown as jest.Mocked<IUrlClassifier>

    const logger = {
      status: false,
      log: jest.fn(),
      error: jest.fn(),
      enable: jest.fn(),
      disable: jest.fn()
    } as unknown as ILogger

    const scheduler = new DynamicMediaScheduler(classifier, logger, settings)
    return { scheduler, classifier, logger }
  }

  test('computes sample indices conservatively', () => {
    const indices = computeSampleIndices(100, {
      sampleRatio: 0.06,
      positiveRatio: 0.12,
      minSamples: 2,
      maxSamples: 10,
      maxSampleDurationSeconds: 45
    })
    expect(indices).toEqual([0, 16, 32, 48, 64, 80])
  })

  test('returns classifier result for video tasks', async () => {
    const { scheduler, classifier } = buildScheduler()
    classifier.predict.mockResolvedValue(blockedResult('class_1', '#e11d48'))

    const result = await scheduler.predict('https://example.com/video.mp4', { tabId: 1, tabUrl: 'https://example.com' }, 'video')
    expect(result.blocked).toBe(true)
    expect(result.borderColor).toBe('#e11d48')
    expect(classifier.predict).toHaveBeenCalledWith('https://example.com/video.mp4', 'video')
  })

  test('caches predictions by media type and url', async () => {
    const { scheduler, classifier } = buildScheduler()
    classifier.predict.mockResolvedValue(visibleResult())

    const tab = { tabId: 1, tabUrl: 'https://example.com' }
    await scheduler.predict('https://example.com/a.gif', tab, 'gif')
    await scheduler.predict('https://example.com/a.gif', tab, 'gif')

    expect(classifier.predict).toHaveBeenCalledTimes(1)
  })

  test('enforces queue backpressure per tab', async () => {
    const { scheduler, classifier } = buildScheduler({ queueLimitPerTab: 1, maxConcurrentGlobal: 1, maxConcurrentPerTab: 1 })

    let resolveFirst: (value: ReturnType<typeof visibleResult>) => void = () => undefined
    classifier.predict.mockImplementation(async () => await new Promise(resolve => {
      resolveFirst = resolve
    }))

    const tab = { tabId: 7, tabUrl: 'https://example.com' }
    const first = scheduler.predict('https://example.com/1.mp4', tab, 'video')

    await expect(scheduler.predict('https://example.com/2.mp4', tab, 'video'))
      .rejects.toThrow('Dynamic media queue limit reached for tab: 7')

    resolveFirst(visibleResult())
    await first
  })

  test('clears queued and pending entries on tab cancellation', async () => {
    const { scheduler, classifier } = buildScheduler({ maxConcurrentGlobal: 1, maxConcurrentPerTab: 1 })

    let resolveFirst: (value: ReturnType<typeof visibleResult>) => void = () => undefined
    classifier.predict.mockImplementation(async () => await new Promise(resolve => {
      resolveFirst = resolve
    }))

    const tab = { tabId: 3, tabUrl: 'https://example.com' }
    const first = scheduler.predict('https://example.com/1.mp4', tab, 'video')
    const second = scheduler.predict('https://example.com/2.mp4', tab, 'video')

    scheduler.clearByTabId(3)
    resolveFirst(blockedResult('class_1'))

    await expect(first).rejects.toThrow('User closed tab')
    await expect(second).rejects.toThrow('User closed tab')
    expect(classifier.predict).toHaveBeenCalledTimes(1)
  })

  test('falls back to visible when classifier rejects', async () => {
    const { scheduler, classifier } = buildScheduler()
    classifier.predict.mockRejectedValue(new Error('boom'))

    const result = await scheduler.predict('https://example.com/a.gif', { tabId: 1, tabUrl: 'https://example.com' }, 'gif')
    expect(result.blocked).toBe(false)
    // Reported as unjudged, so the content script does not record it as a verdict.
    expect(result.error).toBe('boom')
  })

  test('does not cache a failure, so the next request reaches the classifier again', async () => {
    const { scheduler, classifier } = buildScheduler()
    const tabIdUrl = { tabId: 1, tabUrl: 'https://example.com' }
    classifier.predict.mockResolvedValue(visibleResult())
    classifier.predict.mockRejectedValueOnce(new Error('boom'))

    const first = await scheduler.predict('https://example.com/a.gif', tabIdUrl, 'gif')
    expect(first.error).toBe('boom')

    const second = await scheduler.predict('https://example.com/a.gif', tabIdUrl, 'gif')
    expect(second.error).toBeUndefined()
    expect(classifier.predict).toHaveBeenCalledTimes(2)
  })
})
