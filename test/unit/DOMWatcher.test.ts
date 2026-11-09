/**
 * @jest-environment jsdom
 */

import { DOMWatcher } from '../../src/content/DOMWatcher/DOMWatcher'
import { IBackgroundFilter } from '../../src/content/Filter/BackgroundFilter'
import { BackgroundCandidate, invalidateSelectorCache } from '../../src/content/Filter/backgroundScan'
import { IImageFilter } from '../../src/content/Filter/ImageFilter'
import { IVideoFilter } from '../../src/content/Filter/VideoFilter'

/** Longer than the watcher's scan debounce. */
const AFTER_DEBOUNCE_MS = 200

/** jsdom lays nothing out, so an element a scan should accept needs a box. */
const sizeAll = (selector: string): void => {
  document.querySelectorAll(selector).forEach(element => {
    element.getBoundingClientRect = () => ({
      width: 300, height: 400, top: 0, left: 0, right: 300, bottom: 400, x: 0, y: 0, toJSON: () => ({})
    })
  })
}

const buildBackgroundFilter = (): IBackgroundFilter => ({
  analyzeCandidates: jest.fn(),
  setSettings: jest.fn(),
  revealElement: jest.fn(),
  revealSweptBackgrounds: jest.fn()
})

/** Every url the filter was handed, across all the scans so far. */
const scanned = (filter: IBackgroundFilter): string[] =>
  (filter.analyzeCandidates as jest.Mock).mock.calls
    .flatMap(([candidates]: [BackgroundCandidate[]]) => candidates.map(candidate => candidate.url))

/** MutationObserver delivers on a microtask; the scan it queues runs on a timer. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  jest.advanceTimersByTime(AFTER_DEBOUNCE_MS)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const buildFilters = (): { imageFilter: IImageFilter, videoFilter: IVideoFilter } => ({
  imageFilter: { analyzeImage: jest.fn(), setSettings: jest.fn() } as unknown as IImageFilter,
  videoFilter: { analyzeVideo: jest.fn(), setSettings: jest.fn() } as unknown as IVideoFilter
})

describe('content => DOMWatcher', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('analyzes media that was already in the document when watching started', () => {
    const { imageFilter, videoFilter } = buildFilters()
    const image = document.createElement('img')
    image.src = 'https://example.com/a.jpg'
    const video = document.createElement('video')
    video.src = 'https://example.com/a.mp4'
    document.body.appendChild(image)
    document.body.appendChild(video)

    new DOMWatcher(imageFilter, videoFilter).watch()

    expect(imageFilter.analyzeImage).toHaveBeenCalledWith(image, false)
    expect(videoFilter.analyzeVideo).toHaveBeenCalledWith(video, false)
  })

  test('analyzes media added after watching started', async () => {
    const { imageFilter, videoFilter } = buildFilters()
    new DOMWatcher(imageFilter, videoFilter).watch()

    const video = document.createElement('video')
    video.src = 'https://example.com/late.mp4'
    document.body.appendChild(video)

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(videoFilter.analyzeVideo).toHaveBeenCalledWith(video, false)
  })

  test('leaves an empty document alone', () => {
    const { imageFilter, videoFilter } = buildFilters()

    new DOMWatcher(imageFilter, videoFilter).watch()

    expect(imageFilter.analyzeImage).not.toHaveBeenCalled()
    expect(videoFilter.analyzeVideo).not.toHaveBeenCalled()
  })
})

describe('content => DOMWatcher => background images', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    invalidateSelectorCache()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('reports a background already on the page when watching started', async () => {
    const { imageFilter, videoFilter } = buildFilters()
    const backgroundFilter = buildBackgroundFilter()
    document.body.innerHTML = '<div style="background-image: url(https://cdn.test/a.jpg)"></div>'
    sizeAll('div')

    new DOMWatcher(imageFilter, videoFilter, {
      filter: backgroundFilter, mode: 'inline', minSize: 41
    }).watch()
    await settle()

    expect(scanned(backgroundFilter)).toEqual(['https://cdn.test/a.jpg'])
  })

  test('reports a background painted onto an element after watching started', async () => {
    const { imageFilter, videoFilter } = buildFilters()
    const backgroundFilter = buildBackgroundFilter()
    document.body.innerHTML = '<div id="slide"></div>'
    sizeAll('div')

    new DOMWatcher(imageFilter, videoFilter, {
      filter: backgroundFilter, mode: 'inline', minSize: 41
    }).watch()
    await settle()

    // The shape element recycling produces: one element, repainted in place.
    const slide = document.querySelector('#slide') as HTMLElement
    slide.setAttribute('style', 'background-image: url(https://cdn.test/late.jpg)')
    sizeAll('div')
    await settle()

    expect(scanned(backgroundFilter)).toContain('https://cdn.test/late.jpg')
  })

  test('coalesces a burst of mutations into a single scan', async () => {
    const { imageFilter, videoFilter } = buildFilters()
    const backgroundFilter = buildBackgroundFilter()

    new DOMWatcher(imageFilter, videoFilter, {
      filter: backgroundFilter, mode: 'inline', minSize: 41
    }).watch()
    await settle()

    const before = (backgroundFilter.analyzeCandidates as jest.Mock).mock.calls.length
    for (let i = 0; i < 10; i++) {
      const node = document.createElement('div')
      node.setAttribute('style', `background-image: url(https://cdn.test/burst-${i}.jpg)`)
      document.body.appendChild(node)
    }
    sizeAll('div')
    await settle()

    expect((backgroundFilter.analyzeCandidates as jest.Mock).mock.calls.length).toBe(before + 1)
    expect(scanned(backgroundFilter)).toContain('https://cdn.test/burst-9.jpg')
  })

  test('does nothing about backgrounds when the scan is off', async () => {
    const { imageFilter, videoFilter } = buildFilters()
    const backgroundFilter = buildBackgroundFilter()
    document.body.innerHTML = '<div style="background-image: url(https://cdn.test/a.jpg)"></div>'
    sizeAll('div')

    new DOMWatcher(imageFilter, videoFilter, {
      filter: backgroundFilter, mode: 'off', minSize: 41
    }).watch()
    await settle()

    expect(backgroundFilter.analyzeCandidates).not.toHaveBeenCalled()
  })

  test('still analyzes tagged media when the background scan is off', async () => {
    const { imageFilter, videoFilter } = buildFilters()
    const image = document.createElement('img')
    image.src = 'https://cdn.test/a.jpg'
    document.body.appendChild(image)

    new DOMWatcher(imageFilter, videoFilter, {
      filter: buildBackgroundFilter(), mode: 'off', minSize: 41
    }).watch()

    expect(imageFilter.analyzeImage).toHaveBeenCalledWith(image, false)
  })
})
