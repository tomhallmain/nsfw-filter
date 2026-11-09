/**
 * @jest-environment jsdom
 */

import {
  blindStyleSheets,
  invalidateSelectorCache,
  scanForBackgrounds
} from '../../src/content/Filter/backgroundScan'

const MIN_SIZE = 41

/** jsdom serves the document from this origin, so every resolved URL is rooted here. */
const ORIGIN = 'http://localhost'

/** jsdom lays nothing out, so every element a scan should accept needs a box. */
const size = (element: Element, width: number, height: number): void => {
  element.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({})
  })
}

const sizeAll = (selector: string, width = 300, height = 400): void => {
  document.querySelectorAll(selector).forEach(element => size(element, width, height))
}

const urls = (root: Element, mode: 'inline' | 'stylesheet' | 'computed'): string[] =>
  scanForBackgrounds(root, mode, { minSize: MIN_SIZE }).map(candidate => candidate.url).sort()

describe('content => backgroundScan', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    invalidateSelectorCache()
  })

  test('finds an inline background on a div standing in for an image', () => {
    // A photo carried entirely by a div: no <img> anywhere, the URL in the
    // style attribute, and a cropped background-size/position over it.
    document.body.innerHTML =
      '<div class="Bdrs(8px) StretchedBox" role="img" aria-label="Photo 1" ' +
      'style="background-image: url(&quot;https://images-ssl.cdn.test/u/abc/def.jpg&quot;); ' +
      'background-position: 50.3759% 0%; background-size: 126.233% auto;"></div>'
    sizeAll('div')

    const found = scanForBackgrounds(document.documentElement, 'inline', { minSize: MIN_SIZE })

    expect(found).toHaveLength(1)
    expect(found[0].url).toBe('https://images-ssl.cdn.test/u/abc/def.jpg')
    expect(found[0].pseudo).toBeUndefined()
    expect(found[0].element).toBe(document.querySelector('div'))
  })

  test('ignores an element whose only inline background is a gradient', () => {
    document.body.innerHTML =
      '<div style="background-image: linear-gradient(to top, rgb(0, 0, 0) 0%, rgba(255, 255, 255, 0) 100%);"></div>'
    sizeAll('div')

    expect(urls(document.documentElement, 'inline')).toEqual([])
  })

  test('skips boxes below the minimum and boxes that have not been laid out', () => {
    document.body.innerHTML =
      '<i id="icon" style="background-image: url(/icon.png)"></i>' +
      '<div id="unlaid" style="background-image: url(/later.jpg)"></div>' +
      '<div id="photo" style="background-image: url(/photo.jpg)"></div>'
    size(document.querySelector('#icon') as Element, 16, 16)
    size(document.querySelector('#photo') as Element, 300, 400)
    // #unlaid keeps jsdom's zero box, standing in for an element the browser
    // has not measured yet.

    expect(urls(document.documentElement, 'inline')).toEqual([`${ORIGIN}/photo.jpg`])
  })

  test('inline mode does not see a background that only a stylesheet rule sets', () => {
    document.head.innerHTML = '<style>.card { background-image: url("/from-sheet.jpg"); }</style>'
    document.body.innerHTML = '<div class="card"></div>'
    sizeAll('div')

    expect(urls(document.documentElement, 'inline')).toEqual([])
    expect(urls(document.documentElement, 'stylesheet')).toEqual([`${ORIGIN}/from-sheet.jpg`])
  })

  test('a rule reached through a comma-separated selector list still matches', () => {
    document.head.innerHTML = '<style>.hero, .tile { background-image: url("/tile.jpg"); }</style>'
    document.body.innerHTML = '<div class="tile"></div>'
    sizeAll('div')

    expect(urls(document.documentElement, 'stylesheet')).toEqual([`${ORIGIN}/tile.jpg`])
  })

  test('a selector nested inside a media query is harvested like a top-level one', () => {
    document.head.innerHTML =
      '<style>@media (min-width: 100px) { .card { background-image: url("/wide.jpg"); } }</style>'
    document.body.innerHTML = '<div class="card"></div><div class="other"></div>'
    sizeAll('div')

    // jsdom resolves no media query, so the value has to come from a stub; what
    // is under test is that `.card` was harvested from inside the @media block
    // and used to query, which is the part a browser would not do differently.
    const original = window.getComputedStyle
    window.getComputedStyle = ((element: Element) => (
      element.classList.contains('card')
        ? { backgroundImage: 'url("/wide.jpg")', position: 'static' }
        : { backgroundImage: 'none', position: 'static' }
    )) as typeof window.getComputedStyle

    try {
      expect(urls(document.documentElement, 'stylesheet')).toEqual([`${ORIGIN}/wide.jpg`])
    } finally {
      window.getComputedStyle = original
    }
  })

  test('reports one candidate when an element is reached by more than one tier', () => {
    document.head.innerHTML = '<style>.card { background-image: url("/same.jpg"); }</style>'
    document.body.innerHTML = '<div class="card" style="background-image: url(/same.jpg)"></div>'
    sizeAll('div')

    expect(scanForBackgrounds(document.documentElement, 'computed', { minSize: MIN_SIZE })).toHaveLength(1)
  })

  test('counts a stylesheet it cannot read rather than failing the scan', () => {
    document.head.innerHTML = '<style>.card { background-image: url("/readable.jpg"); }</style>'
    document.body.innerHTML = '<div class="card"></div>'
    sizeAll('div')

    const sheet = document.styleSheets[0]
    Object.defineProperty(sheet, 'cssRules', {
      get () { throw new Error('SecurityError: cross-origin stylesheet') }
    })
    invalidateSelectorCache()

    expect(urls(document.documentElement, 'stylesheet')).toEqual([])
    expect(blindStyleSheets()).toBe(1)
  })

  test('a selector the query rejects does not abort the rest of the scan', () => {
    document.head.innerHTML =
      '<style>.card { background-image: url("/good.jpg"); }</style>'
    document.body.innerHTML = '<div class="card"></div>'
    sizeAll('div')

    const original = Element.prototype.querySelectorAll
    let calls = 0
    Element.prototype.querySelectorAll = function (this: Element, selector: string) {
      calls++
      if (calls === 1) throw new Error('SyntaxError')
      return original.call(this, selector) as NodeListOf<Element>
    } as typeof Element.prototype.querySelectorAll

    try {
      expect(urls(document.documentElement, 'stylesheet')).toEqual([`${ORIGIN}/good.jpg`])
    } finally {
      Element.prototype.querySelectorAll = original
    }
  })

  test('scanning is scoped to the root it is given', () => {
    document.body.innerHTML =
      '<section id="a"><div style="background-image: url(/in.jpg)"></div></section>' +
      '<section id="b"><div style="background-image: url(/out.jpg)"></div></section>'
    sizeAll('div')

    const root = document.querySelector('#a') as Element
    expect(urls(root, 'inline')).toEqual([`${ORIGIN}/in.jpg`])
  })

  test('off finds nothing at all', () => {
    document.body.innerHTML = '<div style="background-image: url(/photo.jpg)"></div>'
    sizeAll('div')

    expect(scanForBackgrounds(document.documentElement, 'off', { minSize: MIN_SIZE })).toEqual([])
  })
})
