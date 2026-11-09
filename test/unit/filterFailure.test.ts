/**
 * @jest-environment jsdom
 */

import { ImageFilter } from '../../src/content/Filter/ImageFilter'
import { PredictionResponse } from '../../src/utils/messages'

type Responder = (url: string) => PredictionResponse

const RETRY_DELAY_MS = 11000
/** Long enough to exhaust the reconnect attempts inside Filter. */
const GIVE_UP_MS = 10000

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

const buildImage = (): HTMLImageElement => {
  const image = document.createElement('img')
  image.src = 'https://example.com/a.jpg'
  document.body.appendChild(image)
  return image
}

const failure = (url: string): PredictionResponse => new PredictionResponse(false, url, 'classifier down')
const sfw = (url: string): PredictionResponse => new PredictionResponse(false, url)
const nsfw = (url: string): PredictionResponse => new PredictionResponse(true, url, undefined, 'image', 'Porn', '#e11d48', 0.9)

describe('content => classification failures', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('a failed classification is recorded as unjudged, not as sfw', async () => {
    installChrome(failure)
    const image = buildImage()

    new ImageFilter().analyzeImage(image, false)
    await settle(GIVE_UP_MS)

    expect(image.dataset.nsfwFilterStatus).toBe('error')
    // The media is still shown: a dead classifier must not black out the page.
    expect(image.style.visibility).toBe('visible')
    expect(image.hidden).toBe(false)
  })

  test('every image waiting on the same url is released when retries run out', async () => {
    const sendMessage = installChrome(failure)
    const first = buildImage()
    const second = buildImage()

    // Same url, so the second request joins the first instead of sending its own.
    const filter = new ImageFilter()
    filter.analyzeImage(first, false)
    filter.analyzeImage(second, false)
    await settle(GIVE_UP_MS)

    const urls = sendMessage.mock.calls.map(([request]: [{ url: string }]) => request.url)
    expect(new Set(urls).size).toBe(1)
    for (const image of [first, second]) {
      expect(image.dataset.nsfwFilterStatus).toBe('error')
      expect(image.style.visibility).toBe('visible')
    }
  })

  test('an unjudged image is re-analyzed, and a later verdict replaces the failure', async () => {
    let respond: Responder = failure
    installChrome(url => respond(url))
    const image = buildImage()

    new ImageFilter().analyzeImage(image, false)
    await settle(GIVE_UP_MS)
    expect(image.dataset.nsfwFilterStatus).toBe('error')

    respond = nsfw
    await settle(RETRY_DELAY_MS)

    expect(image.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(image.dataset.nsfwFilterClass).toBe('Porn')
  })

  test('a real sfw verdict is still sticky', async () => {
    const sendMessage = installChrome(sfw)
    const filter = new ImageFilter()
    const image = buildImage()

    filter.analyzeImage(image, false)
    await settle(GIVE_UP_MS)
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')

    filter.analyzeImage(image, false)
    await flush()

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  test('retries are capped, so a page whose classifier is down stops re-queueing', async () => {
    const sendMessage = installChrome(failure)
    const image = buildImage()

    new ImageFilter().analyzeImage(image, false)
    await settle(GIVE_UP_MS)

    for (let i = 0; i < 5; i++) await settle(RETRY_DELAY_MS + GIVE_UP_MS)

    expect(image.dataset.nsfwFilterStatus).toBe('error')
    expect(image.dataset.nsfwFilterRetry).toBe('3')
  })
})

describe('content => unclassifiable blob: sources', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('a blob: src is never sent to the background, and is shown unfiltered', async () => {
    const sendMessage = installChrome(nsfw)
    const image = document.createElement('img')
    image.src = 'blob:https://www.instagram.com/c5dea346-e0b8-4cb6-9101-5bca6a3b645a'
    document.body.appendChild(image)

    new ImageFilter().analyzeImage(image, false)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(image.dataset.nsfwFilterStatus).toBe('error')
    expect(image.style.visibility).toBe('visible')
    expect(image.hidden).toBe(false)
  })

  test('a blob: src is never retried', async () => {
    const sendMessage = installChrome(nsfw)
    const image = document.createElement('img')
    image.src = 'blob:https://www.instagram.com/c5dea346-e0b8-4cb6-9101-5bca6a3b645a'
    document.body.appendChild(image)

    new ImageFilter().analyzeImage(image, false)
    await settle(RETRY_DELAY_MS * 4)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('a src mutation to the same URL does not re-request an already-judged image', async () => {
    const sendMessage = installChrome(sfw)
    const filter = new ImageFilter()
    const image = buildImage()

    filter.analyzeImage(image, false)
    await flush()
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')

    // Simulates DOMWatcher reporting a 'src' attribute mutation whose value
    // did not actually change (e.g. a virtualized feed re-rendering a node).
    filter.analyzeImage(image, true)
    await flush()

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  test('a src mutation to a genuinely different URL still re-requests', async () => {
    const sendMessage = installChrome(sfw)
    const filter = new ImageFilter()
    const image = buildImage()

    filter.analyzeImage(image, false)
    await flush()
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')

    image.src = 'https://example.com/b.jpg'
    filter.analyzeImage(image, true)
    await flush()

    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})
