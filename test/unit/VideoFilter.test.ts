/**
 * @jest-environment jsdom
 */

import { PredictionResponse } from '../../src/utils/messages'
import { VideoFilter } from '../../src/content/Filter/VideoFilter'

type Responder = (url: string) => PredictionResponse

const RETRY_DELAY_MS = 11000

const installChrome = (respond: Responder): jest.Mock => {
  const sendMessage = jest.fn((request: { url: string }, callback: (r: PredictionResponse) => void) => {
    callback(respond(request.url))
  })

  ;(global as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError: undefined }
  }

  return sendMessage
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const settle = async (ms: number): Promise<void> => {
  jest.advanceTimersByTime(ms)
  await flush()
}

const buildVideo = (src: string): HTMLVideoElement => {
  const video = document.createElement('video')
  video.src = src
  document.body.appendChild(video)
  return video
}

const sfw = (url: string): PredictionResponse => new PredictionResponse(false, url, undefined, 'video')

describe('content => VideoFilter blob: sources', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('a blob: source is never sent to the background, and is shown unfiltered', async () => {
    const sendMessage = installChrome(sfw)
    const video = buildVideo('blob:https://www.instagram.com/c5dea346-e0b8-4cb6-9101-5bca6a3b645a')

    new VideoFilter().analyzeVideo(video, false)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(video.dataset.nsfwFilterStatus).toBe('error')
    expect(video.style.visibility).toBe('visible')
  })

  test('a blob: source is never retried', async () => {
    const sendMessage = installChrome(sfw)
    const video = buildVideo('blob:https://www.instagram.com/c5dea346-e0b8-4cb6-9101-5bca6a3b645a')

    new VideoFilter().analyzeVideo(video, false)
    await settle(RETRY_DELAY_MS * 4)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('repeated src-mutation notifications for the same blob: URL do not thrash the pending placeholder', async () => {
    installChrome(sfw)
    const video = buildVideo('blob:https://www.instagram.com/c5dea346-e0b8-4cb6-9101-5bca6a3b645a')
    const filter = new VideoFilter()

    filter.analyzeVideo(video, true)
    await flush()
    filter.analyzeVideo(video, true)
    await flush()

    // showPending() is what inserts the "Checking media..." placeholder and
    // hides the video; the blob short-circuit must never reach it.
    expect(document.querySelector('[data-nsfw-filter-pending-for]')).toBeNull()
    expect(video.style.visibility).toBe('visible')
  })
})

describe('content => VideoFilter sticky verdicts', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('a src mutation to the same URL does not re-request an already-judged video', async () => {
    const sendMessage = installChrome(sfw)
    const filter = new VideoFilter()
    const video = buildVideo('https://example.com/a.mp4')

    filter.analyzeVideo(video, false)
    await flush()
    expect(video.dataset.nsfwFilterStatus).toBe('sfw')

    // Simulates DOMWatcher reporting a 'src' mutation whose value did not
    // actually change (e.g. a virtualized feed re-rendering a recycled node).
    filter.analyzeVideo(video, true)
    await flush()

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  test('a src mutation to a genuinely different URL still re-requests', async () => {
    const sendMessage = installChrome(sfw)
    const filter = new VideoFilter()
    const video = buildVideo('https://example.com/a.mp4')

    filter.analyzeVideo(video, false)
    await flush()
    expect(video.dataset.nsfwFilterStatus).toBe('sfw')

    video.src = 'https://example.com/b.mp4'
    filter.analyzeVideo(video, true)
    await flush()

    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})
