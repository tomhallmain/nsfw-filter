/**
 * @jest-environment jsdom
 */

import { blurFilterForScore, SWEEP_FILTER } from '../../src/content/Filter/blurEffect'
import { ImageFilter } from '../../src/content/Filter/ImageFilter'
import { VideoFilter } from '../../src/content/Filter/VideoFilter'
import { PredictionResponse } from '../../src/utils/messages'

type Responder = (url: string) => PredictionResponse

const FLAGGED = 'https://example.com/flagged.jpg'
const CLEAN = 'https://example.com/real.jpg'
const BROKEN = 'https://example.com/broken.jpg'
/** Long enough to exhaust the reconnect attempts inside Filter, short of its retry delay. */
const GIVE_UP_MS = 10000
const SCORE = 0.9

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

const byUrl: Responder = url => {
  if (url === FLAGGED) return new PredictionResponse(true, url, undefined, 'image', 'Porn', '#e11d48', SCORE)
  if (url === BROKEN) return new PredictionResponse(false, url, 'classifier down')
  return new PredictionResponse(false, url)
}

const frameOf = (media: HTMLElement): HTMLElement | null =>
  media.closest<HTMLElement>('[data-nsfw-filter-frame]')

describe('content => effect from a previous source is removed when the source changes', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
    installChrome(byUrl)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const flaggedImage = async (filter: ImageFilter): Promise<HTMLImageElement> => {
    const wrapper = document.createElement('div')
    const image = document.createElement('img')
    image.src = FLAGGED
    wrapper.appendChild(image)
    document.body.appendChild(wrapper)

    filter.analyzeImage(image, false)
    await flush()

    expect(image.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(image.style.filter).toBe(blurFilterForScore(SCORE))
    return image
  }

  test('image: a flagged image swapped for a clean one is left unblurred', async () => {
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = await flaggedImage(filter)

    image.src = CLEAN
    filter.analyzeImage(image, true)
    await flush()

    expect(image.dataset.nsfwFilterStatus).toBe('sfw')
    expect(image.style.filter).toBe('')
    expect(image.style.visibility).toBe('visible')
    expect(image.dataset.nsfwFilterClass).toBeUndefined()
    expect(frameOf(image)?.style.outline ?? '').toBe('')
    expect(document.querySelector('[data-nsfw-filter-tint]')).toBeNull()
  })

  test('image: grayscale from a previous source is removed too', async () => {
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'grayscale' })
    const image = document.createElement('img')
    image.src = FLAGGED
    document.body.appendChild(image)
    filter.analyzeImage(image, false)
    await flush()
    expect(image.style.filter).toBe('grayscale(1)')

    image.src = CLEAN
    filter.analyzeImage(image, true)
    await flush()

    expect(image.style.filter).toBe('')
  })

  test('image: a failed classification of the new source does not keep the old blur', async () => {
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = await flaggedImage(filter)

    image.src = BROKEN
    filter.analyzeImage(image, true)
    await settle(GIVE_UP_MS)

    expect(image.dataset.nsfwFilterStatus).toBe('error')
    expect(image.style.filter).toBe('')
  })

  test('image: a blob: source replacing a flagged one does not keep the old blur', async () => {
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = await flaggedImage(filter)

    image.src = 'blob:https://example.com/7d1f0c3e-0000-4000-8000-000000000000'
    filter.analyzeImage(image, true)
    await flush()

    expect(image.dataset.nsfwFilterStatus).toBe('error')
    expect(image.style.filter).toBe('')
  })

  test('image: the page-wide sweep blur does not survive a source change', async () => {
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = document.createElement('img')
    image.src = FLAGGED
    image.dataset.nsfwFilterSrc = FLAGGED
    image.dataset.nsfwFilterStatus = 'page-sensitive'
    image.style.filter = SWEEP_FILTER
    document.body.appendChild(image)

    image.src = CLEAN
    filter.analyzeImage(image, true)
    await flush()

    expect(image.dataset.nsfwFilterStatus).toBe('sfw')
    expect(image.style.filter).toBe('')
  })

  test('image: a filter the site set on an image never flagged is left alone', async () => {
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = document.createElement('img')
    image.src = CLEAN
    image.style.filter = 'sepia(1)'
    document.body.appendChild(image)

    filter.analyzeImage(image, false)
    await flush()

    expect(image.dataset.nsfwFilterStatus).toBe('sfw')
    expect(image.style.filter).toBe('sepia(1)')
  })

  test('video: a reused player does not keep the previous source\'s blur', async () => {
    const filter = new VideoFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const video = document.createElement('video')
    video.src = FLAGGED
    document.body.appendChild(video)

    filter.analyzeVideo(video, false)
    await flush()
    expect(video.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(video.style.filter).toBe(blurFilterForScore(SCORE))

    video.src = CLEAN
    filter.analyzeVideo(video, true)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('sfw')
    expect(video.style.filter).toBe('')
    expect(video.style.outline).toBe('')
    expect(video.dataset.nsfwFilterClass).toBeUndefined()
    expect(video.style.visibility).toBe('visible')
  })

  test('video: a failed classification of the new source does not keep the old blur', async () => {
    const filter = new VideoFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const video = document.createElement('video')
    video.src = FLAGGED
    document.body.appendChild(video)
    filter.analyzeVideo(video, false)
    await flush()

    video.src = BROKEN
    filter.analyzeVideo(video, true)
    await settle(GIVE_UP_MS)

    expect(video.dataset.nsfwFilterStatus).toBe('error')
    expect(video.style.filter).toBe('')
  })
})
