/**
 * @jest-environment jsdom
 */

import { compileTextEntries, createRegexMatcher, TextMatcher } from '../../src/content/Filter/textMatch'
import { filterPageText, filterPageTextWhenParsed } from '../../src/content/Filter/textPass'

const matcherFor = (...patterns: string[]): TextMatcher =>
  createRegexMatcher(compileTextEntries(patterns, 'regex', false).regexes)

const textOf = (selector: string, root: ParentNode = document): string | null | undefined =>
  root.querySelector(selector)?.textContent

describe('content => one-time text pass', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  test('matching text is replaced and other text is left alone', () => {
    document.body.innerHTML = '<p id="hit">a bad word</p><p id="miss">all clean</p>'

    expect(filterPageText(matcherFor('bad'))).toBe(1)
    expect(textOf('#hit')).toBe('a [filtered] word')
    expect(textOf('#miss')).toBe('all clean')
  })

  test('text nodes are changed in place, keeping their identity', () => {
    document.body.innerHTML = '<p id="p">a bad word</p>'
    const node = document.getElementById('p')?.firstChild

    filterPageText(matcherFor('bad'))

    expect(document.getElementById('p')?.firstChild).toBe(node)
    expect(document.getElementById('p')?.childNodes).toHaveLength(1)
  })

  test('text that is not rendered is skipped', () => {
    document.head.innerHTML = '<title>bad title</title><style>.bad {}</style>'
    document.body.innerHTML = [
      '<script>var bad = 1</script>',
      '<noscript>bad</noscript>',
      '<template id="t"><p>bad</p></template>',
      '<textarea id="ta">bad</textarea>',
      '<svg><title id="svgTitle">bad</title><text id="svgText">bad</text></svg>'
    ].join('')

    filterPageText(matcherFor('bad'))

    expect(document.title).toBe('bad title')
    expect(textOf('style')).toBe('.bad {}')
    expect(textOf('script')).toBe('var bad = 1')
    expect(textOf('noscript')).toBe('bad')
    expect((document.getElementById('t') as HTMLTemplateElement).content.textContent).toBe('bad')
    expect((document.getElementById('ta') as HTMLTextAreaElement).value).toBe('bad')
    expect(textOf('#svgTitle')).toBe('bad')
    expect(textOf('#svgText')).toBe('[filtered]')
  })

  test('editable content is skipped, islands marked not editable included', () => {
    document.body.innerHTML = [
      '<div id="editor" contenteditable="true">bad <span id="island" contenteditable="false">bad</span></div>',
      '<div id="plain" contenteditable="plaintext-only">bad</div>',
      '<div id="bare" contenteditable>bad</div>',
      '<div id="off" contenteditable="false">bad</div>',
      '<div id="inherit" contenteditable="inherit">bad</div>'
    ].join('')

    filterPageText(matcherFor('bad'))

    expect(textOf('#editor')).toBe('bad bad')
    expect(textOf('#island')).toBe('bad')
    expect(textOf('#plain')).toBe('bad')
    expect(textOf('#bare')).toBe('bad')
    expect(textOf('#off')).toBe('[filtered]')
    expect(textOf('#inherit')).toBe('[filtered]')
  })

  test('an option whose text is its form value is skipped', () => {
    document.body.innerHTML = '<select><option id="valued" value="v">bad</option><option id="bare">bad</option></select>'

    filterPageText(matcherFor('bad'))

    expect(textOf('#valued')).toBe('[filtered]')
    expect(textOf('#bare')).toBe('bad')
    expect((document.getElementById('bare') as HTMLOptionElement).value).toBe('bad')
  })

  test('text hidden with CSS is filtered', () => {
    document.body.innerHTML = '<div id="hidden" style="display: none">bad</div>'

    filterPageText(matcherFor('bad'))

    expect(textOf('#hidden')).toBe('[filtered]')
  })

  test('text inside an open shadow root is filtered', () => {
    document.body.innerHTML = '<div id="host"></div>'
    const root = (document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' })
    root.innerHTML = '<p id="inner">a bad word</p>'

    filterPageText(matcherFor('bad'))

    expect(textOf('#inner', root)).toBe('a [filtered] word')
  })

  test('the pass runs once: text added afterwards is left alone', async () => {
    document.body.innerHTML = '<p id="first">bad</p>'
    filterPageTextWhenParsed(matcherFor('bad'))

    const later = document.createElement('p')
    later.textContent = 'bad'
    document.body.appendChild(later)
    await Promise.resolve()

    expect(textOf('#first')).toBe('[filtered]')
    expect(later.textContent).toBe('bad')
  })

  test('the pass waits for DOMContentLoaded while the document is still parsing', () => {
    document.body.innerHTML = '<p id="p">bad</p>'
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' })

    try {
      filterPageTextWhenParsed(matcherFor('bad'))
      expect(textOf('#p')).toBe('bad')

      document.dispatchEvent(new Event('DOMContentLoaded'))
      expect(textOf('#p')).toBe('[filtered]')
    } finally {
      delete (document as unknown as { readyState?: string }).readyState
    }
  })
})
