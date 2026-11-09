/**
 * @jest-environment jsdom
 */

import { BackgroundFilter } from '../../src/content/Filter/BackgroundFilter'
import { blurFilterForScore, SWEEP_FILTER } from '../../src/content/Filter/blurEffect'
import { PageTally } from '../../src/content/Filter/pageSensitivity'
import { resetPseudoEffects } from '../../src/content/Filter/pseudoEffects'
import { PredictionResponse } from '../../src/utils/messages'

type Verdict = 'nsfw' | 'sfw' | 'fail'

const SCORE = 0.9

/** The url prefix picks the verdict, so a test can mix outcomes on one page. */
const installChrome = (): void => {
  const sendMessage = jest.fn((request: { url: string }, callback: (r: PredictionResponse) => void) => {
    const verdict = request.url.split('/').pop()!.split('-')[0] as Verdict
    callback(verdict === 'fail'
      ? new PredictionResponse(false, request.url, 'classifier down')
      : new PredictionResponse(verdict === 'nsfw', request.url, undefined, 'image', 'class_1', '#dc2626', SCORE))
  })

  ;(global as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage, lastError: undefined }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const buildFilter = (
  effect: 'blur' | 'hide' | 'grayscale' = 'blur',
  tally?: PageTally,
  interImageAwareness?: { minCount: number, minRatio: number }
): BackgroundFilter => {
  const filter = new BackgroundFilter(tally)
  filter.setSettings({ filterEffect: effect, interImageAwareness })
  return filter
}

const addHost = (html: string): HTMLElement => {
  document.body.insertAdjacentHTML('beforeend', html)
  return document.body.lastElementChild as HTMLElement
}

const overlayOf = (host: HTMLElement): HTMLElement | null =>
  host.querySelector('[data-nsfw-filter-bg-overlay="1"]')

const analyze = async (
  filter: BackgroundFilter,
  element: HTMLElement,
  url: string,
  pseudo?: '::before' | '::after'
): Promise<void> => {
  filter.analyzeCandidates([{ element, url, pseudo }])
  await flush()
}

describe('content => BackgroundFilter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    resetPseudoEffects()
    installChrome()
  })

  test('blurs a leaf element in place, without wrapping or reparenting it', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-1.jpg)"></div>')
    const parent = host.parentElement

    await analyze(buildFilter('blur'), host, 'https://cdn.test/nsfw-1.jpg')

    expect(host.style.filter).toBe(blurFilterForScore(SCORE))
    expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('nsfw')
    expect(host.getAttribute('data-nsfw-filter-bg-mode')).toBe('direct')
    expect(host.parentElement).toBe(parent)
    expect(overlayOf(host)).toBeNull()
    // The element's own background is what gets blurred, so it must stay put.
    expect(host.style.backgroundImage).toContain('nsfw-1.jpg')
  })

  test('hides a leaf element behind the configured hide effect', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-2.jpg)"></div>')

    await analyze(buildFilter('hide'), host, 'https://cdn.test/nsfw-2.jpg')

    expect(host.style.visibility).toBe('hidden')
    expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('nsfw')
  })

  test('conceals a leaf element while the verdict is still in flight', () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-3.jpg)"></div>')

    // No flush: this is the state between the request and the response.
    buildFilter('blur').analyzeCandidates([{ element: host, url: 'https://cdn.test/nsfw-3.jpg' }])

    expect(host.style.visibility).toBe('hidden')
  })

  test('shows a leaf element again once it comes back clear', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/sfw-1.jpg)"></div>')

    await analyze(buildFilter('blur'), host, 'https://cdn.test/sfw-1.jpg')

    expect(host.style.visibility).toBe('visible')
    expect(host.style.filter).toBe('')
    expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('sfw')
  })

  test('an element with children gets an overlay so its text is not blurred too', async () => {
    const host = addHost(
      '<div style="background-image: url(https://cdn.test/nsfw-4.jpg)">' +
      '<h2>Caption</h2><button>Open</button></div>'
    )

    await analyze(buildFilter('blur'), host, 'https://cdn.test/nsfw-4.jpg')

    const overlay = overlayOf(host)
    expect(overlay).not.toBeNull()
    expect(host.getAttribute('data-nsfw-filter-bg-mode')).toBe('overlay')
    // A filter on the host would reach the heading and the button as well.
    expect(host.style.filter).toBe('')
    expect(overlay?.style.filter).toBe(blurFilterForScore(SCORE))
    expect(overlay?.style.backgroundImage).toContain('nsfw-4.jpg')
    // The original must not show through the overlay's soft edges.
    expect(host.style.backgroundImage).toBe('none')
    expect(host.getAttribute('data-nsfw-filter-bg-restore')).toContain('nsfw-4.jpg')
  })

  test('an overlaid element is made a containing block only when it is not already positioned', async () => {
    const staticHost = addHost('<div style="background-image: url(https://cdn.test/nsfw-5.jpg)"><span>x</span></div>')
    const absoluteHost = addHost('<div style="position: absolute; background-image: url(https://cdn.test/nsfw-6.jpg)"><span>x</span></div>')

    const filter = buildFilter('blur')
    await analyze(filter, staticHost, 'https://cdn.test/nsfw-5.jpg')
    await analyze(filter, absoluteHost, 'https://cdn.test/nsfw-6.jpg')

    expect(staticHost.style.position).toBe('relative')
    expect(staticHost.getAttribute('data-nsfw-filter-bg-positioned')).toBe('1')
    expect(absoluteHost.style.position).toBe('absolute')
    expect(absoluteHost.getAttribute('data-nsfw-filter-bg-positioned')).toBeNull()
  })

  test('an element with children is covered while the verdict is in flight', () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-7.jpg)"><span>x</span></div>')

    buildFilter('blur').analyzeCandidates([{ element: host, url: 'https://cdn.test/nsfw-7.jpg' }])

    const overlay = overlayOf(host)
    expect(overlay).not.toBeNull()
    expect(overlay?.style.backgroundImage).toBe('none')
    expect(overlay?.style.backgroundColor).not.toBe('transparent')
  })

  test('a cleared overlaid element gets its own background back and loses the overlay', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/sfw-2.jpg)"><span>x</span></div>')

    await analyze(buildFilter('blur'), host, 'https://cdn.test/sfw-2.jpg')

    expect(overlayOf(host)).toBeNull()
    expect(host.style.backgroundImage).toContain('sfw-2.jpg')
    expect(host.style.position).toBe('')
    expect(host.getAttribute('data-nsfw-filter-bg-restore')).toBeNull()
  })

  test('a ::before background is filtered through a stylesheet rule, not the element', async () => {
    const host = addHost('<div class="card"><span>x</span></div>')

    await analyze(buildFilter('blur'), host, 'https://cdn.test/nsfw-8.jpg', '::before')

    expect(host.getAttribute('data-nsfw-filter-bg-before-status')).toBe('nsfw')
    expect(host.getAttribute('data-nsfw-filter-bg-before-mode')).toBe('pseudo')
    expect(host.style.filter).toBe('')
    expect(overlayOf(host)).toBeNull()

    const key = host.getAttribute('data-nsfw-filter-bg-key')
    const css = document.querySelector('style[data-nsfw-filter-pseudo]')?.textContent ?? ''
    expect(css).toContain(`[data-nsfw-filter-bg-key="${key ?? ''}"]::before`)
    expect(css).toContain('blur(')
    expect(css).toContain('!important')
  })

  test('an element paints its own background and a ::before one without the two colliding', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-9.jpg)"></div>')
    const filter = buildFilter('blur')

    await analyze(filter, host, 'https://cdn.test/nsfw-9.jpg')
    await analyze(filter, host, 'https://cdn.test/sfw-3.jpg', '::after')

    expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('nsfw')
    expect(host.getAttribute('data-nsfw-filter-bg-after-status')).toBe('sfw')
    expect(host.getAttribute('data-nsfw-filter-bg-src')).toBe('https://cdn.test/nsfw-9.jpg')
    expect(host.getAttribute('data-nsfw-filter-bg-after-src')).toBe('https://cdn.test/sfw-3.jpg')
  })

  test('the same url is not classified twice', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-10.jpg)"></div>')
    const filter = buildFilter('blur')

    await analyze(filter, host, 'https://cdn.test/nsfw-10.jpg')
    await analyze(filter, host, 'https://cdn.test/nsfw-10.jpg')

    const { sendMessage } = (global as unknown as { chrome: { runtime: { sendMessage: jest.Mock } } }).chrome.runtime
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  test('a recycled element is reclassified when its background changes', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/sfw-4.jpg)"></div>')
    const filter = buildFilter('blur')

    await analyze(filter, host, 'https://cdn.test/sfw-4.jpg')
    expect(host.style.filter).toBe('')

    await analyze(filter, host, 'https://cdn.test/nsfw-11.jpg')
    expect(host.style.filter).toBe(blurFilterForScore(SCORE))
    expect(host.getAttribute('data-nsfw-filter-bg-src')).toBe('https://cdn.test/nsfw-11.jpg')
  })

  test('a failed classification leaves the background shown and marked unjudged', async () => {
    jest.useFakeTimers()
    const host = addHost('<div style="background-image: url(https://cdn.test/fail-1.jpg)"></div>')

    try {
      await analyze(buildFilter('blur'), host, 'https://cdn.test/fail-1.jpg')

      // Filter treats a failure as a possibly-sleeping service worker first and
      // reconnects before giving up, so the verdict only arrives after those.
      jest.advanceTimersByTime(10000)
      await flush()

      expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('error')
      expect(host.style.visibility).toBe('visible')
      expect(host.style.filter).toBe('')
    } finally {
      jest.useRealTimers()
    }
  })

  test('revealElement undoes every treatment on the element', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-12.jpg)"><span>x</span></div>')
    const filter = buildFilter('blur')

    await analyze(filter, host, 'https://cdn.test/nsfw-12.jpg')
    await analyze(filter, host, 'https://cdn.test/nsfw-13.jpg', '::before')

    filter.revealElement(host)

    expect(overlayOf(host)).toBeNull()
    expect(host.style.backgroundImage).toContain('nsfw-12.jpg')
    expect(host.style.filter).toBe('')
    expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('sfw')
    expect(host.getAttribute('data-nsfw-filter-bg-before-status')).toBe('sfw')
    expect(document.querySelector('style[data-nsfw-filter-pseudo]')?.textContent).toBe('')
  })

  test('a page that trips the sensitivity threshold sweeps backgrounds it had cleared', async () => {
    const tally = new PageTally()
    const filter = buildFilter('blur', tally, { minCount: 2, minRatio: 0.3 })

    const cleared = addHost('<div style="background-image: url(https://cdn.test/sfw-5.jpg)"></div>')
    await analyze(filter, cleared, 'https://cdn.test/sfw-5.jpg')
    expect(cleared.style.filter).toBe('')

    for (let i = 0; i < 2; i++) {
      const blocked = addHost(`<div style="background-image: url(https://cdn.test/nsfw-2${i}.jpg)"></div>`)
      await analyze(filter, blocked, `https://cdn.test/nsfw-2${i}.jpg`)
    }

    expect(cleared.getAttribute('data-nsfw-filter-bg-status')).toBe('page-sensitive')
    expect(cleared.style.filter).toBe(SWEEP_FILTER)
  })

  test('revealSweptBackgrounds drops the sweep but keeps individual verdicts', async () => {
    const tally = new PageTally()
    const filter = buildFilter('blur', tally, { minCount: 2, minRatio: 0.3 })

    const cleared = addHost('<div style="background-image: url(https://cdn.test/sfw-6.jpg)"></div>')
    await analyze(filter, cleared, 'https://cdn.test/sfw-6.jpg')

    const blocked: HTMLElement[] = []
    for (let i = 0; i < 2; i++) {
      const host = addHost(`<div style="background-image: url(https://cdn.test/nsfw-3${i}.jpg)"></div>`)
      await analyze(filter, host, `https://cdn.test/nsfw-3${i}.jpg`)
      blocked.push(host)
    }

    expect(filter.revealSweptBackgrounds()).toBe(1)
    expect(cleared.getAttribute('data-nsfw-filter-bg-status')).toBe('sfw')
    expect(cleared.style.filter).toBe('')
    expect(blocked[0].getAttribute('data-nsfw-filter-bg-status')).toBe('nsfw')
    expect(blocked[0].style.filter).toBe(blurFilterForScore(SCORE))
  })

  test('a verdict that lands after the background changed is discarded', async () => {
    const host = addHost('<div style="background-image: url(https://cdn.test/nsfw-14.jpg)"></div>')
    const pending: Array<() => void> = []

    ;(global as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: (request: { url: string }, callback: (r: PredictionResponse) => void) => {
          pending.push(() => callback(
            new PredictionResponse(true, request.url, undefined, 'image', 'class_1', '#dc2626', SCORE)
          ))
        },
        lastError: undefined
      }
    }

    const filter = buildFilter('blur')
    filter.analyzeCandidates([{ element: host, url: 'https://cdn.test/nsfw-14.jpg' }])

    // The page repaints the element before the first verdict returns.
    host.setAttribute('data-nsfw-filter-bg-src', 'https://cdn.test/other.jpg')
    pending[0]()
    await flush()

    expect(host.style.filter).toBe('')
  })

  test('a failed target is not re-requested by the scans that keep passing over it', async () => {
    jest.useFakeTimers()
    const host = addHost('<div style="background-image: url(https://cdn.test/fail-2.jpg)"></div>')
    const filter = buildFilter('blur')
    const { sendMessage } = (global as unknown as { chrome: { runtime: { sendMessage: jest.Mock } } }).chrome.runtime

    try {
      await analyze(filter, host, 'https://cdn.test/fail-2.jpg')
      jest.advanceTimersByTime(10000)
      await flush()
      expect(host.getAttribute('data-nsfw-filter-bg-status')).toBe('error')

      const afterFailure = sendMessage.mock.calls.length
      for (let i = 0; i < 5; i++) await analyze(filter, host, 'https://cdn.test/fail-2.jpg')

      expect(sendMessage.mock.calls.length).toBe(afterFailure)
    } finally {
      jest.useRealTimers()
    }
  })

  test('the retry path does reach a failed target again', async () => {
    jest.useFakeTimers()
    const host = addHost('<div style="background-image: url(https://cdn.test/fail-3.jpg)"></div>')
    const { sendMessage } = (global as unknown as { chrome: { runtime: { sendMessage: jest.Mock } } }).chrome.runtime

    try {
      await analyze(buildFilter('blur'), host, 'https://cdn.test/fail-3.jpg')
      jest.advanceTimersByTime(10000)
      await flush()

      const afterFailure = sendMessage.mock.calls.length
      jest.advanceTimersByTime(11000)
      await flush()

      expect(sendMessage.mock.calls.length).toBeGreaterThan(afterFailure)
    } finally {
      jest.useRealTimers()
    }
  })
})
