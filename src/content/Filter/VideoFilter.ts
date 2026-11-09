import { PredictionRequest, PredictionResponse } from '../../utils/messages'
import { queryAllDeep } from '../shadowRoots'

import { applyDirectClassBorder, clearDirectClassBorder } from './borderFrame'
import { blurFilterForScore } from './blurEffect'
import { Filter, isCrossContextBlobUrl } from './Filter'
import { MediaFilterSettingsType } from './ImageFilter'
import { PageTally } from './pageSensitivity'

/**
 * An HLS or DASH manifest is a text playlist, not media: the classifier can't
 * decode it, and the player turns it into a blob: source anyway.
 */
const STREAM_MANIFEST_PATH = /\.(m3u8|mpd)$/i
const STREAM_MANIFEST_TYPE = /mpegurl|dash\+xml/i

const isStreamManifest = (video: HTMLVideoElement, url: string): boolean => {
  try {
    if (STREAM_MANIFEST_PATH.test(new URL(url, document.baseURI).pathname)) return true
  } catch {
    return false
  }

  const sources = video.getElementsByTagName('source')
  for (let i = 0; i < sources.length; i++) {
    if (sources[i].src === url && STREAM_MANIFEST_TYPE.test(sources[i].type)) return true
  }
  return false
}

/** Sources no request can ever classify; they are never sent to the background. */
const isUnclassifiableSource = (video: HTMLVideoElement, url: string): boolean =>
  isCrossContextBlobUrl(url) || isStreamManifest(video, url)

/**
 * A flagged image counts as a video's cover when it covers at least this share
 * of the video's box.
 */
const COVER_MIN_OVERLAP = 0.8

/**
 * How far above the video the search for a cover image starts. It only bounds
 * the search; overlap decides what counts as a cover.
 */
const COVER_SEARCH_DEPTH = 6

const FLAGGED_IMAGE = 'img[data-nsfw-filter-status="nsfw"]'

/** Share of `target`'s area that `cover` overlaps, 0 when `target` has no box. */
const overlapShare = (target: DOMRect, cover: DOMRect): number => {
  const area = target.width * target.height
  if (area <= 0) return 0

  const width = Math.min(target.right, cover.right) - Math.max(target.left, cover.left)
  const height = Math.min(target.bottom, cover.bottom) - Math.max(target.top, cover.top)
  return width > 0 && height > 0 ? (width * height) / area : 0
}

type NsfwTreatment = {
  topNsfwClass?: string
  borderColor?: string
  score?: number
}

export type IVideoFilter = {
  analyzeVideo: (video: HTMLVideoElement, srcAttribute: boolean) => void
  setSettings: (settings: MediaFilterSettingsType) => void
}

export class VideoFilter extends Filter implements IVideoFilter {
  private settings: MediaFilterSettingsType
  private readonly MIN_VIDEO_SIZE: number
  private readonly DYNAMIC_ANALYSIS_DISABLED_HOSTS: RegExp[]

  constructor (tally?: PageTally) {
    super(tally)
    this.settings = { filterEffect: 'hide' }
    this.MIN_VIDEO_SIZE = 41
    this.DYNAMIC_ANALYSIS_DISABLED_HOSTS = [
      /(^|\.)youtube\.com$/i,
      /(^|\.)youtu\.be$/i,
      /(^|\.)netflix\.com$/i,
      /(^|\.)hulu\.com$/i,
      /(^|\.)disneyplus\.com$/i,
      /(^|\.)primevideo\.com$/i,
      /(^|\.)twitch\.tv$/i,
      /(^|\.)vimeo\.com$/i
    ]
  }

  public setSettings (settings: MediaFilterSettingsType): void {
    this.settings = settings
  }

  public analyzeVideo (video: HTMLVideoElement, _srcAttribute: boolean = false): void {
    if (this.isDynamicAnalysisDisabledForCurrentHost()) {
      video.dataset.nsfwFilterStatus = 'sfw'
      this.clearPending(video)
      clearDirectClassBorder(video)
      video.style.filter = 'none'
      video.style.visibility = 'visible'
      return
    }

    const mediaUrl = this.getVideoSource(video)
    const status = video.dataset.nsfwFilterStatus
    if (
      (mediaUrl !== video.dataset.nsfwFilterSrc || status === undefined || status === 'error') &&
      this.isValidForChecking(video)
    ) {
      if (mediaUrl.length === 0) return

      if (status === 'nsfw') this.clearAppliedEffect(video)

      if (isUnclassifiableSource(video, mediaUrl)) {
        this.markUnsupported(video)
        return
      }

      video.dataset.nsfwFilterSrc = mediaUrl
      video.dataset.nsfwFilterStatus = 'processing'
      this.showPending(video)
      this.analyze(video, mediaUrl)
    }
  }

  private analyze (video: HTMLVideoElement, mediaUrl: string): void {
    const request = new PredictionRequest(mediaUrl, 'video')

    this.requestToAnalyzeImage(request)
      .then(response => {
        const { result, url, borderColor, topNsfwClass, score } = response
        if (this.getVideoSource(video) !== url) {
          this.clearPending(video)
          return
        }

        if (response.failed) {
          this.markUnclassified(video)
          return
        }

        if (result) {
          this.recordVerdict(true)
          this.applyNsfw(video, { topNsfwClass, borderColor, score })
          if (this.settings.filterEffect === 'hide') return
        } else {
          this.recordVerdict(false)
          video.dataset.nsfwFilterStatus = 'sfw'
          delete video.dataset.nsfwFilterClass
          clearDirectClassBorder(video)
        }

        this.showVideo(video)
      })
      .catch(() => {
        this.markUnclassified(video)
      })
  }

  private applyNsfw (video: HTMLVideoElement, { topNsfwClass, borderColor, score }: NsfwTreatment): void {
    video.dataset.nsfwFilterStatus = 'nsfw'
    if (topNsfwClass !== undefined) video.dataset.nsfwFilterClass = topNsfwClass
    this.muteVideoAudio(video)

    if (this.settings.filterEffect === 'hide') {
      video.pause()
      video.style.visibility = 'hidden'
      this.clearPending(video)
      return
    }

    // No DOM wrapper for videos (breaks players). Outline is applied
    // directly; category tint stays image-only for the same reason.
    if (this.settings.filterEffect === 'blur') {
      video.style.filter = blurFilterForScore(score)
    } else {
      video.style.filter = 'grayscale(1)'
    }
    applyDirectClassBorder(video, borderColor)
  }

  /**
   * Re-check every video that can't be classified against the flagged images
   * around it. Called when an image comes back NSFW, since a cover can be
   * judged after the video beneath it was given up on.
   */
  public recheckCovers (): void {
    queryAllDeep<HTMLVideoElement>('video[data-nsfw-filter-status="error"]')
      .forEach(video => this.inheritCoverVerdict(video))
  }

  /**
   * A video that can't be classified takes on its cover's NSFW verdict: the
   * `poster`, or a flagged image covering most of the video's box. A cover
   * shows one moment of the video, so only a positive verdict carries over; a
   * clean cover says nothing about the rest. An inherited verdict is marked
   * with a `cover` basis and is not counted toward page sensitivity, because
   * the cover already counted.
   */
  private inheritCoverVerdict (video: HTMLVideoElement): void {
    if (!this.awaitsCoverVerdict(video)) return

    if (this.findFlaggedCover(video) !== null) {
      this.applyCoverVerdict(video, {})
      return
    }

    const poster = video.poster
    if (poster.length === 0 || /^(?:blob|data):/i.test(poster)) return

    const source = video.dataset.nsfwFilterSrc
    this.requestToAnalyzeImage(new PredictionRequest(poster, 'image'))
      .then(response => {
        if (!this.posterVerdictApplies(video, source, poster, response)) return
        const { topNsfwClass, borderColor, score } = response
        this.applyCoverVerdict(video, { topNsfwClass, borderColor, score })
      })
      .catch(() => undefined)
  }

  private awaitsCoverVerdict (video: HTMLVideoElement): boolean {
    const source = video.dataset.nsfwFilterSrc
    return video.dataset.nsfwFilterStatus === 'error' &&
      source !== undefined &&
      isUnclassifiableSource(video, source)
  }

  /** The video may have moved on while its poster was being judged. */
  private posterVerdictApplies (
    video: HTMLVideoElement,
    source: string | undefined,
    poster: string,
    response: PredictionResponse
  ): boolean {
    return response.result &&
      !response.failed &&
      video.poster === poster &&
      video.dataset.nsfwFilterSrc === source &&
      this.awaitsCoverVerdict(video)
  }

  private findFlaggedCover (video: HTMLVideoElement): HTMLImageElement | null {
    const box = video.getBoundingClientRect()

    let scope: Element = video
    for (let i = 0; i < COVER_SEARCH_DEPTH && scope.parentElement !== null; i++) {
      scope = scope.parentElement
    }

    const flagged = scope.querySelectorAll<HTMLImageElement>(FLAGGED_IMAGE)
    for (let i = 0; i < flagged.length; i++) {
      if (overlapShare(box, flagged[i].getBoundingClientRect()) >= COVER_MIN_OVERLAP) return flagged[i]
    }
    return null
  }

  private applyCoverVerdict (video: HTMLVideoElement, treatment: NsfwTreatment): void {
    video.dataset.nsfwFilterBasis = 'cover'
    this.applyNsfw(video, treatment)
  }

  /**
   * A player reusing one <video> across items still carries the previous
   * source's effect, which no later verdict path removes. Audio is left as is:
   * unmuting could override a mute the user or the site set.
   */
  private clearAppliedEffect (video: HTMLVideoElement): void {
    video.style.filter = ''
    clearDirectClassBorder(video)
    delete video.dataset.nsfwFilterClass
    delete video.dataset.nsfwFilterBasis
  }

  /**
   * No verdict was reached. The video plays, but is recorded as unjudged so it
   * stays eligible for another attempt -- writing 'sfw' here would be
   * indistinguishable from a real verdict and would never be revisited.
   */
  private markUnclassified (video: HTMLVideoElement): void {
    video.dataset.nsfwFilterStatus = 'error'
    delete video.dataset.nsfwFilterClass
    clearDirectClassBorder(video)
    this.showVideo(video)
    this.retryAfterFailure(video, () => this.analyzeVideo(video, false))
  }

  /**
   * A source no request can classify (see `isUnclassifiableSource`). Unlike a
   * transient failure, this never retries: shown unfiltered, unless its cover
   * is flagged, and left alone until the src genuinely changes.
   */
  private markUnsupported (video: HTMLVideoElement): void {
    video.dataset.nsfwFilterSrc = this.getVideoSource(video)
    video.dataset.nsfwFilterStatus = 'error'
    delete video.dataset.nsfwFilterClass
    delete video.dataset.nsfwFilterBasis
    clearDirectClassBorder(video)
    this.showVideo(video)
    this.inheritCoverVerdict(video)
  }

  private isValidForChecking (video: HTMLVideoElement): boolean {
    return (
      (video.width > this.MIN_VIDEO_SIZE && video.height > this.MIN_VIDEO_SIZE) ||
      (video.videoWidth > this.MIN_VIDEO_SIZE && video.videoHeight > this.MIN_VIDEO_SIZE) ||
      video.width === 0 ||
      video.height === 0
    )
  }

  private getVideoSource (video: HTMLVideoElement): string {
    if (video.currentSrc.length > 0) return video.currentSrc
    if (video.src.length > 0) return video.src

    const source = video.querySelector('source')
    return source?.src ?? ''
  }

  private showVideo (video: HTMLVideoElement): void {
    this.clearPending(video)
    video.style.visibility = 'visible'
  }

  private showPending (video: HTMLVideoElement): void {
    this.clearPending(video)

    const placeholder = document.createElement('div')
    placeholder.dataset.nsfwFilterPendingFor = 'video'
    placeholder.style.display = 'flex'
    placeholder.style.alignItems = 'center'
    placeholder.style.justifyContent = 'center'
    placeholder.style.textAlign = 'center'
    placeholder.style.fontSize = '12px'
    placeholder.style.fontFamily = 'Arial, sans-serif'
    placeholder.style.color = '#dbdbdb'
    placeholder.style.background = '#1f1f1f'
    placeholder.style.border = '1px solid #333333'
    placeholder.style.borderRadius = '4px'
    placeholder.style.width = `${this.resolveWidth(video)}px`
    placeholder.style.height = `${this.resolveHeight(video)}px`
    placeholder.textContent = 'Checking media...'

    // parentNode, not parentElement: a video can sit directly under a shadow root.
    video.parentNode?.insertBefore(placeholder, video)
    video.style.visibility = 'hidden'
    video.dataset.nsfwFilterPendingId = Math.random().toString(36).slice(2)
    placeholder.dataset.nsfwFilterPendingId = video.dataset.nsfwFilterPendingId
  }

  private clearPending (video: HTMLVideoElement): void {
    const placeholderId = video.dataset.nsfwFilterPendingId
    if (placeholderId === undefined) return

    // Search the whole tree the video is in (the document, or its shadow root),
    // not its parent: a later wrapper around the video would hide a sibling from
    // parentElement.querySelector. A detached video leaves its placeholder behind
    // in the document.
    const tree = video.isConnected ? video.getRootNode() as Document | ShadowRoot : document
    tree.querySelector(`[data-nsfw-filter-pending-id="${placeholderId}"]`)?.remove()

    delete video.dataset.nsfwFilterPendingId
  }

  private resolveWidth (video: HTMLVideoElement): number {
    const fromRect = Math.floor(video.getBoundingClientRect().width)
    if (fromRect > 0) return fromRect
    if (video.clientWidth > 0) return video.clientWidth
    if (video.width > 0) return video.width
    return 160
  }

  private resolveHeight (video: HTMLVideoElement): number {
    const fromRect = Math.floor(video.getBoundingClientRect().height)
    if (fromRect > 0) return fromRect
    if (video.clientHeight > 0) return video.clientHeight
    if (video.height > 0) return video.height
    return 90
  }

  private muteVideoAudio (video: HTMLVideoElement): void {
    if (this.hasAudioTrack(video)) {
      video.muted = true
      video.volume = 0
    }
  }

  private hasAudioTrack (video: HTMLVideoElement): boolean {
    const browserVideo = video as HTMLVideoElement & {
      mozHasAudio?: boolean
      webkitAudioDecodedByteCount?: number
      audioTracks?: { length: number }
    }

    if (browserVideo.audioTracks !== undefined) return browserVideo.audioTracks.length > 0
    if (typeof browserVideo.mozHasAudio === 'boolean') return browserVideo.mozHasAudio
    if (typeof browserVideo.webkitAudioDecodedByteCount === 'number') return browserVideo.webkitAudioDecodedByteCount > 0

    // If track presence is unknown, mute conservatively for safety.
    return true
  }

  private isDynamicAnalysisDisabledForCurrentHost (): boolean {
    const hostname = window.location.hostname.toLowerCase()
    return this.DYNAMIC_ANALYSIS_DISABLED_HOSTS.some(pattern => pattern.test(hostname))
  }

}
