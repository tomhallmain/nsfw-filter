/**
 * @jest-environment jsdom
 */

import { ImageFilter } from '../../src/content/Filter/ImageFilter'
import { PageTally } from '../../src/content/Filter/pageSensitivity'
import { VideoFilter } from '../../src/content/Filter/VideoFilter'
import { PredictionResponse } from '../../src/utils/messages'

type Verdict = 'nsfw' | 'sfw' | 'fail'

/** The url prefix picks the verdict, so a test can mix outcomes on one page. */
const installChrome = (): void => {
  const sendMessage = jest.fn((request: { url: string }, callback: (r: PredictionResponse) => void) => {
    const verdict = request.url.split('/').pop()!.split('-')[0] as Verdict
    callback(verdict === 'fail'
      ? new PredictionResponse(false, request.url, 'classifier down')
      : new PredictionResponse(verdict === 'nsfw', request.url, undefined, 'image', 'class_1', '#dc2626', 0.9))
  })

  ;(global as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError: undefined }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Adds `count` images and runs each through the filter, oldest first. */
const analyzeImages = async (filter: ImageFilter, prefix: string, count: number): Promise<HTMLImageElement[]> => {
  const images: HTMLImageElement[] = []

  for (let i = 0; i < count; i++) {
    const image = document.createElement('img')
    image.src = `https://example.com/${prefix}-${i}.jpg`
    document.body.appendChild(image)
    images.push(image)
    filter.analyzeImage(image, false)
    await flush()
  }

  return images
}

const statuses = (images: HTMLImageElement[]): Array<string | undefined> =>
  images.map(image => image.dataset.nsfwFilterStatus)

const THRESHOLDS = { minCount: 6, minRatio: 0.3 }

const buildFilter = (tally?: PageTally): ImageFilter => {
  const filter = new ImageFilter(tally)
  filter.setSettings({ filterEffect: 'blur', interImageAwareness: THRESHOLDS })
  return filter
}

/** Adds `count` videos and runs each through the filter, oldest first. */
const analyzeVideos = async (filter: VideoFilter, prefix: string, count: number): Promise<void> => {
  for (let i = 0; i < count; i++) {
    const video = document.createElement('video')
    video.src = `https://example.com/${prefix}-${i}.mp4`
    document.body.appendChild(video)
    filter.analyzeVideo(video, false)
    await flush()
  }
}

describe('content => inter-image awareness', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('sweeps already-cleared images once the page trips', async () => {
    installChrome()
    const filter = buildFilter()

    const safe = await analyzeImages(filter, 'sfw', 4)
    expect(statuses(safe)).toEqual(['sfw', 'sfw', 'sfw', 'sfw'])

    // 6 blocked of 10 analyzed clears both the floor and the 30% ratio.
    const unsafe = await analyzeImages(filter, 'nsfw', 6)

    expect(statuses(unsafe)).toEqual(Array(6).fill('nsfw'))
    expect(statuses(safe)).toEqual(Array(4).fill('page-sensitive'))
    expect(safe[0].style.filter).toBe('blur(16px)')
  })

  test('images cleared after the trip land swept rather than revealed', async () => {
    installChrome()
    const filter = buildFilter()

    await analyzeImages(filter, 'nsfw', 6)
    const late = await analyzeImages(filter, 'sfw', 1)

    expect(statuses(late)).toEqual(['page-sensitive'])
    expect(late[0].style.filter).toBe('blur(16px)')
  })

  test('stays inert while the protection level is off', async () => {
    installChrome()
    const filter = new ImageFilter()
    filter.setSettings({ filterEffect: 'blur' })

    const safe = await analyzeImages(filter, 'sfw', 4)
    await analyzeImages(filter, 'nsfw', 6)

    expect(statuses(safe)).toEqual(Array(4).fill('sfw'))
  })

  test('failed classifications do not count toward the ratio', async () => {
    installChrome()
    const filter = buildFilter()

    // 5 blocked is under the floor; 20 failures must not make it look worse.
    await analyzeImages(filter, 'fail', 20)
    const safe = await analyzeImages(filter, 'sfw', 1)
    await analyzeImages(filter, 'nsfw', 5)

    expect(statuses(safe)).toEqual(['sfw'])
  })

  test('blocked video trips the sweep even though no image crossed it', async () => {
    installChrome()
    const tally = new PageTally()
    const imageFilter = buildFilter(tally)
    const videoFilter = new VideoFilter(tally)
    videoFilter.setSettings({ filterEffect: 'blur' })

    const safe = await analyzeImages(imageFilter, 'sfw', 4)
    expect(statuses(safe)).toEqual(Array(4).fill('sfw'))

    await analyzeVideos(videoFilter, 'nsfw', 6)

    expect(statuses(safe)).toEqual(Array(4).fill('page-sensitive'))
  })

  test('revealing shows the swept images and reports how many', async () => {
    installChrome()
    const filter = buildFilter()

    const safe = await analyzeImages(filter, 'sfw', 4)
    const unsafe = await analyzeImages(filter, 'nsfw', 6)
    expect(statuses(safe)).toEqual(Array(4).fill('page-sensitive'))

    expect(filter.revealSweptImages()).toBe(4)

    expect(statuses(safe)).toEqual(Array(4).fill('sfw'))
    expect(safe[0].style.filter).toBe('')
    // Individually flagged images keep their treatment.
    expect(statuses(unsafe)).toEqual(Array(6).fill('nsfw'))
  })

  test('a revealed page does not re-trip as later verdicts arrive', async () => {
    installChrome()
    const filter = buildFilter()

    const safe = await analyzeImages(filter, 'sfw', 4)
    await analyzeImages(filter, 'nsfw', 6)
    filter.revealSweptImages()

    // Every one of these clears both gates again on its own.
    await analyzeImages(filter, 'nsfw', 6)
    const late = await analyzeImages(filter, 'sfw', 1)

    expect(statuses(safe)).toEqual(Array(4).fill('sfw'))
    expect(statuses(late)).toEqual(['sfw'])
  })

  test('revealing an untripped page is a no-op that reports nothing', async () => {
    installChrome()
    const filter = buildFilter()

    const safe = await analyzeImages(filter, 'sfw', 3)

    expect(filter.revealSweptImages()).toBe(0)
    expect(statuses(safe)).toEqual(Array(3).fill('sfw'))
  })
})
