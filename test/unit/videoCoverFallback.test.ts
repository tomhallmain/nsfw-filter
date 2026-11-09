/**
 * @jest-environment jsdom
 */

import { blurFilterForScore } from '../../src/content/Filter/blurEffect'
import { ImageFilter } from '../../src/content/Filter/ImageFilter'
import { PageTally } from '../../src/content/Filter/pageSensitivity'
import { VideoFilter } from '../../src/content/Filter/VideoFilter'
import { PredictionResponse } from '../../src/utils/messages'

const BLOB = 'blob:https://example.com/5b0e1c9a-0000-4000-8000-000000000000'
const FLAGGED_COVER = 'https://example.com/flagged-cover.jpg'
const CLEAN_COVER = 'https://example.com/clean-cover.jpg'
const POSTER_SCORE = 0.8

type Pending = Map<string, Array<(response: PredictionResponse) => void>>

/**
 * URLs containing "flagged" come back NSFW, anything else clean. With
 * `deferred`, answers wait for `answer()`.
 */
const installChrome = (deferred = false): { sendMessage: jest.Mock, pending: Pending } => {
  const pending: Pending = new Map()
  const respond = (url: string): PredictionResponse => url.includes('flagged')
    ? new PredictionResponse(true, url, undefined, 'image', 'Porn', '#e11d48', POSTER_SCORE)
    : new PredictionResponse(false, url)

  const sendMessage = jest.fn((request: { url: string }, callback: (r: PredictionResponse) => void) => {
    if (deferred) {
      pending.set(request.url, [...(pending.get(request.url) ?? []), callback])
    } else {
      callback(respond(request.url))
    }
  })

  ;(global as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError: undefined }
  }

  return { sendMessage, pending }
}

const answer = async (pending: Pending, url: string, response: PredictionResponse): Promise<void> => {
  for (const callback of pending.get(url) ?? []) callback(response)
  pending.delete(url)
  await flush()
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const requestedUrls = (sendMessage: jest.Mock): string[] =>
  sendMessage.mock.calls.map(([request]: [{ url: string }]) => request.url)

type Box = { left: number, top: number, width: number, height: number }

/** jsdom lays nothing out, so each element's box is set by hand. */
const place = (element: Element, { left, top, width, height }: Box): void => {
  element.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({})
  })
}

const PLAYER_BOX: Box = { left: 0, top: 0, width: 400, height: 700 }

/**
 * A card with a cover image and a video on top of it, in separate branches of
 * the card, the way players commonly layer a still under a video.
 */
const buildCard = (coverUrl: string, coverBox: Box = PLAYER_BOX): { video: HTMLVideoElement, cover: HTMLImageElement } => {
  const card = document.createElement('div')
  const coverBranch = document.createElement('div')
  const playerBranch = document.createElement('div')
  const playerInner = document.createElement('div')

  const cover = document.createElement('img')
  cover.src = coverUrl
  place(cover, coverBox)

  const video = document.createElement('video')
  video.src = BLOB
  place(video, PLAYER_BOX)

  coverBranch.appendChild(cover)
  playerInner.appendChild(video)
  playerBranch.appendChild(playerInner)
  card.appendChild(coverBranch)
  card.appendChild(playerBranch)
  document.body.appendChild(card)

  return { video, cover }
}

/** The page wiring from content.ts: a flagged image re-checks unclassifiable video. */
const buildFilters = (tally = new PageTally()): { imageFilter: ImageFilter, videoFilter: VideoFilter } => {
  const imageFilter = new ImageFilter(tally)
  const videoFilter = new VideoFilter(tally)
  imageFilter.setSettings({ filterEffect: 'blur' })
  videoFilter.setSettings({ filterEffect: 'blur' })
  imageFilter.onFlagged(() => videoFilter.recheckCovers())
  return { imageFilter, videoFilter }
}

describe('content => an unclassifiable video inherits its cover\'s NSFW verdict', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('cover flagged before the video is seen: the video is treated', async () => {
    const { sendMessage } = installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    const { video, cover } = buildCard(FLAGGED_COVER)

    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(video.dataset.nsfwFilterBasis).toBe('cover')
    expect(video.style.filter).toBe(blurFilterForScore(undefined))
    expect(requestedUrls(sendMessage)).not.toContain(BLOB)
  })

  test('cover flagged after the video was given up on: the video is treated', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    const { video, cover } = buildCard(FLAGGED_COVER)

    videoFilter.analyzeVideo(video, false)
    await flush()
    expect(video.dataset.nsfwFilterStatus).toBe('error')

    imageFilter.analyzeImage(cover, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(video.dataset.nsfwFilterBasis).toBe('cover')
  })

  test('hide mode pauses and hides a video with a flagged cover', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    videoFilter.setSettings({ filterEffect: 'hide' })
    const { video, cover } = buildCard(FLAGGED_COVER)
    const pause = jest.spyOn(video, 'pause').mockImplementation(() => undefined)

    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(pause).toHaveBeenCalled()
    expect(video.style.visibility).toBe('hidden')
  })

  test('a clean cover leaves the video unjudged and unfiltered', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    const { video, cover } = buildCard(CLEAN_COVER)

    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('error')
    expect(video.dataset.nsfwFilterBasis).toBeUndefined()
    expect(video.style.filter).toBe('')
  })

  test('a flagged image beside the video, not under it, is not its cover', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    const { video, cover } = buildCard(FLAGGED_COVER, { left: 420, top: 0, width: 400, height: 700 })

    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('error')
  })

  test('a flagged image covering too little of the video is not its cover', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    // Covers half the video's height: 50% of its area.
    const { video, cover } = buildCard(FLAGGED_COVER, { left: 0, top: 0, width: 400, height: 350 })

    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('error')
  })

  test('a video with no box of its own never matches a cover', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    const { video, cover } = buildCard(FLAGGED_COVER)
    place(video, { left: 0, top: 0, width: 0, height: 0 })

    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('error')
  })

  test('an inherited verdict is not counted toward page sensitivity', async () => {
    installChrome()
    const tally = new PageTally()
    const { imageFilter, videoFilter } = buildFilters(tally)
    const { video, cover } = buildCard(FLAGGED_COVER)
    const record = jest.spyOn(tally, 'record')

    imageFilter.analyzeImage(cover, false)
    await flush()
    expect(record).toHaveBeenCalledTimes(1)

    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterBasis).toBe('cover')
    expect(record).toHaveBeenCalledTimes(1)
  })

  test('a new, classifiable source clears the inherited treatment', async () => {
    installChrome()
    const { imageFilter, videoFilter } = buildFilters()
    const { video, cover } = buildCard(FLAGGED_COVER)
    imageFilter.analyzeImage(cover, false)
    await flush()
    videoFilter.analyzeVideo(video, false)
    await flush()
    expect(video.dataset.nsfwFilterBasis).toBe('cover')

    video.src = 'https://example.com/clean-clip.mp4'
    videoFilter.analyzeVideo(video, true)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('sfw')
    expect(video.dataset.nsfwFilterBasis).toBeUndefined()
    expect(video.style.filter).toBe('')
  })
})

describe('content => an unclassifiable video inherits its poster\'s NSFW verdict', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const posterVideo = (poster: string): HTMLVideoElement => {
    const video = document.createElement('video')
    video.src = BLOB
    video.poster = poster
    document.body.appendChild(video)
    return video
  }

  test('a flagged poster is classified as an image and treats the video', async () => {
    const { sendMessage } = installChrome()
    const { videoFilter } = buildFilters()
    const video = posterVideo(FLAGGED_COVER)

    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(sendMessage.mock.calls[0][0]).toMatchObject({ url: FLAGGED_COVER, mediaType: 'image' })
    expect(video.dataset.nsfwFilterStatus).toBe('nsfw')
    expect(video.dataset.nsfwFilterBasis).toBe('cover')
    expect(video.style.filter).toBe(blurFilterForScore(POSTER_SCORE))
  })

  test('a clean poster leaves the video unjudged', async () => {
    installChrome()
    const { videoFilter } = buildFilters()
    const video = posterVideo(CLEAN_COVER)

    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(video.dataset.nsfwFilterStatus).toBe('error')
    expect(video.style.filter).toBe('')
  })

  test('a data: poster is not sent anywhere', async () => {
    const { sendMessage } = installChrome()
    const { videoFilter } = buildFilters()
    const video = posterVideo('data:image/gif;base64,R0lGODlhAQABAAAAACw=')

    videoFilter.analyzeVideo(video, false)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('a poster verdict arriving after the video changed source is ignored', async () => {
    const { pending } = installChrome(true)
    const { videoFilter } = buildFilters()
    const video = posterVideo(FLAGGED_COVER)
    videoFilter.analyzeVideo(video, false)
    await flush()

    video.src = 'blob:https://example.com/6c1f2dab-0000-4000-8000-000000000000'
    video.removeAttribute('poster')
    videoFilter.analyzeVideo(video, true)
    await flush()

    await answer(pending, FLAGGED_COVER,
      new PredictionResponse(true, FLAGGED_COVER, undefined, 'image', 'Porn', '#e11d48', POSTER_SCORE))

    expect(video.dataset.nsfwFilterStatus).toBe('error')
    expect(video.style.filter).toBe('')
  })
})

describe('content => streaming manifests are unclassifiable up front', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test.each([
    ['an .m3u8 URL', 'https://example.com/stream/master.m3u8?token=abc', ''],
    ['an .mpd URL', 'https://example.com/stream/manifest.mpd', ''],
    ['an HLS <source> type', 'https://example.com/stream/playlist', 'application/x-mpegURL'],
    ['an Apple HLS <source> type', 'https://example.com/stream/playlist', 'application/vnd.apple.mpegURL'],
    ['a DASH <source> type', 'https://example.com/stream/playlist', 'application/dash+xml']
  ])('%s is never requested and never retried', async (_name, url, type) => {
    const { sendMessage } = installChrome()
    const video = document.createElement('video')
    const source = document.createElement('source')
    source.src = url
    if (type.length > 0) source.type = type
    video.appendChild(source)
    document.body.appendChild(video)

    new VideoFilter().analyzeVideo(video, false)
    jest.advanceTimersByTime(60000)
    await flush()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(video.dataset.nsfwFilterStatus).toBe('error')
    expect(video.style.visibility).toBe('visible')
  })

  test('an ordinary video file is still requested', async () => {
    const { sendMessage } = installChrome()
    const video = document.createElement('video')
    video.src = 'https://example.com/clip.mp4'
    document.body.appendChild(video)

    new VideoFilter().analyzeVideo(video, false)
    await flush()

    expect(requestedUrls(sendMessage)).toEqual(['https://example.com/clip.mp4'])
  })
})
