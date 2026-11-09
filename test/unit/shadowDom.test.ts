/**
 * @jest-environment jsdom
 */

import { DOMWatcher } from '../../src/content/DOMWatcher/DOMWatcher'
import { IBackgroundFilter } from '../../src/content/Filter/BackgroundFilter'
import { IImageFilter, ImageFilter } from '../../src/content/Filter/ImageFilter'
import { IVideoFilter, VideoFilter } from '../../src/content/Filter/VideoFilter'
import { queryAllDeep } from '../../src/content/shadowRoots'
import { PredictionResponse } from '../../src/utils/messages'

const IMAGE = 'https://example.com/picture.jpg'
const VIDEO = 'https://example.com/clip.mp4'

/** MutationObserver delivers on a microtask. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const setChrome = (value: unknown): void => {
  (global as unknown as { chrome: unknown }).chrome = value
}

type Mocks = { analyzeImage: jest.Mock, analyzeVideo: jest.Mock }

const watch = (background?: IBackgroundFilter): Mocks => {
  const analyzeImage = jest.fn()
  const analyzeVideo = jest.fn()
  const imageFilter = { analyzeImage, setSettings: jest.fn() } as unknown as IImageFilter
  const videoFilter = { analyzeVideo, setSettings: jest.fn() } as unknown as IVideoFilter
  new DOMWatcher(
    imageFilter,
    videoFilter,
    background === undefined ? undefined : { filter: background, mode: 'stylesheet', minSize: 41 }
  ).watch()
  return { analyzeImage, analyzeVideo }
}

const analyzed = (mock: jest.Mock): Element[] => mock.mock.calls.map(([element]: [Element]) => element)

/** A host element with an open shadow root, appended to `parent`. */
const openHost = (parent: Node = document.body): ShadowRoot => {
  const host = document.createElement('media-card')
  parent.appendChild(host)
  return host.attachShadow({ mode: 'open' })
}

const video = (): HTMLVideoElement => {
  const element = document.createElement('video')
  element.src = VIDEO
  return element
}

const image = (): HTMLImageElement => {
  const element = document.createElement('img')
  element.src = IMAGE
  return element
}

describe('content => DOMWatcher finds media inside shadow trees', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setChrome(undefined)
  })

  test('a video in a shadow root present when watching starts is analysed', () => {
    const root = openHost()
    const wrapper = document.createElement('div')
    const player = video()
    wrapper.appendChild(player)
    root.appendChild(wrapper)

    const { analyzeVideo } = watch()

    expect(analyzed(analyzeVideo)).toContain(player)
  })

  test('a shadow host inserted later, with media already inside, is analysed', async () => {
    const { analyzeImage, analyzeVideo } = watch()

    const host = document.createElement('media-card')
    const root = host.attachShadow({ mode: 'open' })
    const picture = image()
    const player = video()
    root.appendChild(picture)
    root.appendChild(player)
    document.body.appendChild(host)
    await flush()

    expect(analyzed(analyzeImage)).toContain(picture)
    expect(analyzed(analyzeVideo)).toContain(player)
  })

  test('media appended directly under an already-observed shadow root is analysed', async () => {
    const root = openHost()
    const { analyzeVideo } = watch()

    const player = video()
    root.appendChild(player)
    await flush()

    expect(analyzed(analyzeVideo)).toContain(player)
  })

  test('media appended deeper inside an already-observed shadow root is analysed', async () => {
    const root = openHost()
    const wrapper = document.createElement('div')
    root.appendChild(wrapper)
    const { analyzeImage } = watch()

    const picture = image()
    wrapper.appendChild(picture)
    await flush()

    expect(analyzed(analyzeImage)).toContain(picture)
  })

  test('nested shadow roots are reached, including ones added later', async () => {
    const outer = openHost()
    const inner = openHost(outer)
    const first = video()
    inner.appendChild(first)

    const { analyzeVideo } = watch()
    expect(analyzed(analyzeVideo)).toContain(first)

    const innermost = openHost(inner)
    const second = video()
    innermost.appendChild(second)
    await flush()
    // The host was added empty; its content arrives inside a root the watcher
    // only learned of from that addition.
    const third = video()
    innermost.appendChild(third)
    await flush()

    expect(analyzed(analyzeVideo)).toEqual(expect.arrayContaining([second, third]))
  })

  test('a src change on media inside a shadow root is noticed', async () => {
    const root = openHost()
    const picture = image()
    root.appendChild(picture)
    const { analyzeImage } = watch()
    analyzeImage.mockClear()

    picture.src = 'https://example.com/other.jpg'
    await flush()

    expect(analyzeImage).toHaveBeenCalledWith(picture, true)
  })

  test('a load event inside a shadow root reaches the image filter', () => {
    const root = openHost()
    const picture = image()
    root.appendChild(picture)
    const { analyzeImage } = watch()
    analyzeImage.mockClear()

    picture.dispatchEvent(new Event('load', { bubbles: false, composed: false }))

    expect(analyzeImage).toHaveBeenCalledWith(picture, false)
  })

  test('a closed shadow root is reached through the extension API', () => {
    const host = document.createElement('media-card')
    const root = host.attachShadow({ mode: 'closed' })
    const player = video()
    root.appendChild(player)
    document.body.appendChild(host)

    const openOrClosedShadowRoot = jest.fn((element: Element) => (element === host ? root : null))
    setChrome({ dom: { openOrClosedShadowRoot } })

    const { analyzeVideo } = watch()

    expect(analyzed(analyzeVideo)).toContain(player)
  })

  test('without the extension API, a closed shadow root is skipped quietly', () => {
    const host = document.createElement('media-card')
    const root = host.attachShadow({ mode: 'closed' })
    root.appendChild(video())
    document.body.appendChild(host)

    expect(() => watch()).not.toThrow()
  })

  test('mutations inside a shadow tree never queue a background scan', async () => {
    jest.useFakeTimers()
    try {
      const root = openHost()
      const background: IBackgroundFilter = {
        analyzeCandidates: jest.fn(),
        setSettings: jest.fn(),
        revealElement: jest.fn(),
        revealSweptBackgrounds: jest.fn()
      }
      watch(background)
      jest.advanceTimersByTime(200)
      await flush()
      ;(background.analyzeCandidates as jest.Mock).mockClear()

      const panel = document.createElement('div')
      root.appendChild(panel)
      await flush()
      panel.style.backgroundImage = 'url("https://example.com/bg.jpg")'
      await flush()
      jest.advanceTimersByTime(200)
      await flush()

      expect(background.analyzeCandidates).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('content => filters handle media inside shadow trees', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('the video pending placeholder inside a shadow root is removed once judged', async () => {
    setChrome({
      runtime: {
        sendMessage: jest.fn((request: { url: string }, callback: (r: PredictionResponse) => void) => {
          // Answered after showPending has run, as a real round trip would be.
          setTimeout(() => callback(new PredictionResponse(false, request.url, undefined, 'video')), 0)
        }),
        lastError: undefined
      }
    })
    jest.useFakeTimers()
    try {
      const root = openHost()
      const player = video()
      root.appendChild(player)

      new VideoFilter().analyzeVideo(player, false)
      expect(root.querySelector('[data-nsfw-filter-pending-for]')).not.toBeNull()

      jest.advanceTimersByTime(1)
      await flush()

      expect(player.dataset.nsfwFilterStatus).toBe('sfw')
      expect(root.querySelector('[data-nsfw-filter-pending-for]')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  test('the pending placeholder is placed even when the video sits directly under the shadow root', () => {
    setChrome({ runtime: { sendMessage: jest.fn(), lastError: undefined } })
    const root = openHost()
    const player = video()
    root.appendChild(player)

    new VideoFilter().analyzeVideo(player, false)

    expect(player.previousSibling).not.toBeNull()
    expect((player.previousSibling as HTMLElement).dataset.nsfwFilterPendingFor).toBe('video')
  })

  test('the page-wide reveal reaches swept images inside a shadow root', () => {
    const root = openHost()
    const picture = image()
    picture.dataset.nsfwFilterStatus = 'page-sensitive'
    picture.style.filter = 'blur(16px)'
    root.appendChild(picture)
    // The registry learns of roots through the watcher.
    watch()

    const revealed = new ImageFilter().revealSweptImages()

    expect(revealed).toBe(1)
    expect(picture.style.filter).toBe('')
    expect(picture.dataset.nsfwFilterStatus).toBe('sfw')
  })

  test('queryAllDeep forgets a root whose host has left the page', () => {
    const root = openHost()
    const picture = image()
    picture.className = 'probe'
    root.appendChild(picture)
    watch()
    expect(queryAllDeep('img.probe')).toEqual([picture])

    document.body.innerHTML = ''

    expect(queryAllDeep('img.probe')).toEqual([])
  })
})
