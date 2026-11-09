/**
 * @jest-environment jsdom
 */

import { DOMWatcher } from '../../src/content/DOMWatcher/DOMWatcher'
import { blurFilterForScore } from '../../src/content/Filter/blurEffect'
import { IImageFilter, ImageFilter } from '../../src/content/Filter/ImageFilter'
import { IVideoFilter } from '../../src/content/Filter/VideoFilter'
import { PredictionResponse } from '../../src/utils/messages'

const FALLBACK = 'https://example.com/fallback.gif'
const CHOSEN = 'https://example.com/chosen-small.webp'
const CHOSEN_LARGER = 'https://example.com/chosen-large.webp'
const SCORE = 0.9

type Pending = Map<string, Array<(response: PredictionResponse) => void>>

/** Holds every request open until the test answers it. */
const installDeferredChrome = (): { sendMessage: jest.Mock, pending: Pending } => {
  const pending: Pending = new Map()
  const sendMessage = jest.fn((request: { url: string }, callback: (r: PredictionResponse) => void) => {
    pending.set(request.url, [...(pending.get(request.url) ?? []), callback])
  })

  ;(global as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError: undefined }
  }

  return { sendMessage, pending }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const answer = async (pending: Pending, url: string, blocked: boolean): Promise<void> => {
  const response = blocked
    ? new PredictionResponse(true, url, undefined, 'image', 'Porn', '#e11d48', SCORE)
    : new PredictionResponse(false, url)
  for (const callback of pending.get(url) ?? []) callback(response)
  pending.delete(url)
  await flush()
}

const requestedUrls = (sendMessage: jest.Mock): string[] =>
  sendMessage.mock.calls.map(([request]: [{ url: string }]) => request.url)

/** jsdom never selects a source, so the browser's choice is set by hand. */
const setCurrentSrc = (image: HTMLImageElement, url: string): void => {
  Object.defineProperty(image, 'currentSrc', { configurable: true, get: () => url })
}

const pictureImage = (): HTMLImageElement => {
  const picture = document.createElement('picture')
  const source = document.createElement('source')
  source.setAttribute('srcset', `${CHOSEN} 300w, ${CHOSEN_LARGER} 600w`)
  const image = document.createElement('img')
  image.src = FALLBACK
  picture.appendChild(source)
  picture.appendChild(image)
  document.body.appendChild(picture)
  return image
}

const srcsetImage = (): HTMLImageElement => {
  const image = document.createElement('img')
  image.src = FALLBACK
  image.setAttribute('srcset', `${CHOSEN} 1x, ${CHOSEN_LARGER} 2x`)
  document.body.appendChild(image)
  return image
}

describe('content => ImageFilter classifies the source the browser displays', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('an image inside <picture> is classified by its chosen source, not its src', async () => {
    const { sendMessage, pending } = installDeferredChrome()
    const filter = new ImageFilter()
    const image = pictureImage()
    setCurrentSrc(image, CHOSEN)

    filter.analyzeImage(image, false)
    await answer(pending, CHOSEN, false)

    expect(requestedUrls(sendMessage)).toEqual([CHOSEN])
    expect(image.dataset.nsfwFilterSrc).toBe(CHOSEN)
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')
    expect(image.style.visibility).toBe('visible')
  })

  test.each([
    ['inside <picture>', pictureImage],
    ['with srcset', srcsetImage]
  ])('an image %s with no source chosen yet is held hidden, not judged by its src', async (_name, build) => {
    const { sendMessage } = installDeferredChrome()
    const image = build()

    new ImageFilter().analyzeImage(image, false)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(image.dataset.nsfwFilterStatus).toBe('awaiting-source')
    expect(image.style.visibility).toBe('hidden')
  })

  test('a held image directly under <body> is not display: none, so it can still lazy-load', async () => {
    installDeferredChrome()
    const image = srcsetImage()

    new ImageFilter().analyzeImage(image, false)
    await flush()

    expect(image.parentNode?.nodeName).toBe('BODY')
    expect(image.hidden).toBe(false)
  })

  test('a held image with no src at all is still held', async () => {
    const { sendMessage } = installDeferredChrome()
    const image = pictureImage()
    image.removeAttribute('src')

    new ImageFilter().analyzeImage(image, false)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(image.dataset.nsfwFilterStatus).toBe('awaiting-source')
    expect(image.style.visibility).toBe('hidden')
  })

  test('once the source is chosen, the held image is classified and shown', async () => {
    const { sendMessage, pending } = installDeferredChrome()
    const filter = new ImageFilter()
    const image = pictureImage()
    filter.analyzeImage(image, false)

    setCurrentSrc(image, CHOSEN)
    filter.analyzeImage(image, false)
    await answer(pending, CHOSEN, false)

    expect(requestedUrls(sendMessage)).toEqual([CHOSEN])
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')
    expect(image.style.visibility).toBe('visible')
  })

  test('once the source is chosen, a flagged held image is blurred', async () => {
    const { pending } = installDeferredChrome()
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = pictureImage()
    filter.analyzeImage(image, false)

    setCurrentSrc(image, CHOSEN)
    filter.analyzeImage(image, false)
    await answer(pending, CHOSEN, true)

    expect(image.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(image.style.filter).toBe(blurFilterForScore(SCORE))
  })

  test('a held image that turns out too small is released, not left hidden', async () => {
    const { sendMessage } = installDeferredChrome()
    const filter = new ImageFilter()
    const image = srcsetImage()
    filter.analyzeImage(image, false)
    expect(image.style.visibility).toBe('hidden')

    image.width = 16
    image.height = 16
    setCurrentSrc(image, CHOSEN)
    filter.analyzeImage(image, false)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(image.style.visibility).toBe('visible')
    expect(image.dataset.nsfwFilterStatus).toBeUndefined()
  })

  test('a held image that loses its srcset and has no src is released', async () => {
    installDeferredChrome()
    const filter = new ImageFilter()
    const image = srcsetImage()
    filter.analyzeImage(image, false)

    image.removeAttribute('srcset')
    image.removeAttribute('src')
    filter.analyzeImage(image, false)
    await flush()

    expect(image.style.visibility).toBe('visible')
    expect(image.dataset.nsfwFilterStatus).toBeUndefined()
  })

  test('re-examining an image whose chosen source is unchanged sends nothing new', async () => {
    const { sendMessage, pending } = installDeferredChrome()
    const filter = new ImageFilter()
    const image = pictureImage()
    setCurrentSrc(image, CHOSEN)
    filter.analyzeImage(image, false)
    await answer(pending, CHOSEN, false)

    filter.analyzeImage(image, false)
    await flush()

    expect(requestedUrls(sendMessage)).toEqual([CHOSEN])
  })

  test('a different chosen source (e.g. after a resize) is classified again', async () => {
    const { sendMessage, pending } = installDeferredChrome()
    const filter = new ImageFilter()
    const image = pictureImage()
    setCurrentSrc(image, CHOSEN)
    filter.analyzeImage(image, false)
    await answer(pending, CHOSEN, false)

    setCurrentSrc(image, CHOSEN_LARGER)
    filter.analyzeImage(image, false)

    expect(requestedUrls(sendMessage)).toEqual([CHOSEN, CHOSEN_LARGER])
    expect(image.dataset.nsfwFilterSrc).toBe(CHOSEN_LARGER)
  })

  test('a verdict for a source the image has since left is ignored', async () => {
    const { pending } = installDeferredChrome()
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })
    const image = pictureImage()
    setCurrentSrc(image, CHOSEN)
    filter.analyzeImage(image, false)

    setCurrentSrc(image, CHOSEN_LARGER)
    filter.analyzeImage(image, false)

    await answer(pending, CHOSEN, true)
    expect(image.style.filter).toBe('')
    expect(image.dataset.nsfwFilterStatus).toBe('processing')

    await answer(pending, CHOSEN_LARGER, false)
    expect(image.style.filter).toBe('')
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')
    expect(image.style.visibility).toBe('visible')
  })

  test('a plain image with no srcset is still classified by its src', async () => {
    const { sendMessage } = installDeferredChrome()
    const image = document.createElement('img')
    image.src = FALLBACK
    document.body.appendChild(image)

    new ImageFilter().analyzeImage(image, false)

    expect(requestedUrls(sendMessage)).toEqual([FALLBACK])
  })
})

describe('content => DOMWatcher re-examines images as they load', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const watch = (): jest.Mock => {
    const analyzeImage = jest.fn()
    const imageFilter = { analyzeImage, setSettings: jest.fn() } as unknown as IImageFilter
    const videoFilter = { analyzeVideo: jest.fn(), setSettings: jest.fn() } as unknown as IVideoFilter
    new DOMWatcher(imageFilter, videoFilter).watch()
    analyzeImage.mockClear()
    return analyzeImage
  }

  test.each(['load', 'error'])('a non-bubbling %s event on an image reaches the image filter', eventType => {
    const image = document.createElement('img')
    document.body.appendChild(image)
    const analyzeImage = watch()

    image.dispatchEvent(new Event(eventType, { bubbles: false }))

    expect(analyzeImage).toHaveBeenCalledWith(image, false)
  })

  test('a load event on something other than an image is ignored', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const analyzeImage = watch()

    video.dispatchEvent(new Event('load', { bubbles: false }))

    expect(analyzeImage).not.toHaveBeenCalled()
  })
})
