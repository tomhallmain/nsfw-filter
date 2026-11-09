/**
 * @jest-environment jsdom
 */

import { ANALYSIS_DEADLINE_MS } from '../../src/content/Filter/Filter'
import { ImageFilter } from '../../src/content/Filter/ImageFilter'
import { PredictionResponse } from '../../src/utils/messages'

type Callback = (r: PredictionResponse) => void

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const settle = async (ms: number): Promise<void> => {
  jest.advanceTimersByTime(ms)
  await flush()
}

/** A background that receives requests but only answers when told to. */
const installSilentChrome = (): { sendMessage: jest.Mock, pending: Callback[] } => {
  const pending: Callback[] = []
  const sendMessage = jest.fn((_request: unknown, callback: Callback) => { pending.push(callback) })
  ;(global as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError: undefined }
  }
  return { sendMessage, pending }
}

const buildImage = (): HTMLImageElement => {
  const image = document.createElement('img')
  image.src = 'https://example.com/a.jpg'
  document.body.appendChild(image)
  return image
}

describe('content => Filter => analysis deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('media waits for its verdict until the deadline', async () => {
    installSilentChrome()
    const image = buildImage()

    new ImageFilter().analyzeImage(image, false)
    await settle(ANALYSIS_DEADLINE_MS - 1)

    expect(image.dataset.nsfwFilterStatus).not.toBe('error')
  })

  test('a background that never answers leaves every waiter unjudged at the deadline', async () => {
    const { sendMessage } = installSilentChrome()
    const first = buildImage()
    const second = buildImage()

    const filter = new ImageFilter()
    filter.analyzeImage(first, false)
    filter.analyzeImage(second, false)
    await settle(ANALYSIS_DEADLINE_MS)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    for (const image of [first, second]) {
      expect(image.dataset.nsfwFilterStatus).toBe('error')
      expect(image.style.visibility).toBe('visible')
    }
  })

  test('a reply that arrives after the deadline is dropped', async () => {
    const { pending } = installSilentChrome()
    const image = buildImage()

    new ImageFilter().analyzeImage(image, false)
    await settle(ANALYSIS_DEADLINE_MS)

    pending[0](new PredictionResponse(true, 'https://example.com/a.jpg', undefined, 'image', 'Porn', '#e11d48', 0.9))
    await flush()

    expect(image.dataset.nsfwFilterStatus).toBe('error')
  })
})
