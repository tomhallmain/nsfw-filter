import {
  compileTextEntries,
  createRegexMatcher,
  MAX_TEXT_FILTER_ENTRIES,
  MAX_TEXT_FILTER_ENTRY_LENGTH,
  parseEntryLines,
  replaceRanges,
  textEntryError
} from '../../src/content/Filter/textMatch'

const filter = (
  text: string,
  { words = [], patterns = [], caseSensitive = false }: { words?: string[], patterns?: string[], caseSensitive?: boolean }
): string => {
  const regexes = [
    ...compileTextEntries(words, 'word', caseSensitive).regexes,
    ...compileTextEntries(patterns, 'regex', caseSensitive).regexes
  ]
  return replaceRanges(text, createRegexMatcher(regexes)(text)) ?? text
}

describe('content => text filter matching', () => {
  test('each match is replaced and the surrounding text kept', () => {
    expect(filter('this is badword here, badword again', { patterns: ['badword'] }))
      .toBe('this is [filtered] here, [filtered] again')
  })

  test('text with no match is reported as unchanged', () => {
    const matcher = createRegexMatcher(compileTextEntries(['nothing'], 'regex', false).regexes)
    expect(replaceRanges('clean text', matcher('clean text'))).toBeNull()
  })

  test('overlapping and touching matches from different entries become one marker', () => {
    expect(filter('xx foobar yy', { patterns: ['foob', 'obar'] })).toBe('xx [filtered] yy')
    expect(filter('xx foobar yy', { patterns: ['foo', 'bar'] })).toBe('xx [filtered] yy')
    expect(filter('xx foo bar yy', { words: ['foo'], patterns: ['o b'] })).toBe('xx [filtered]ar yy')
  })

  test('an entry matching inside the marker has no effect', () => {
    expect(filter('one bad word', { patterns: ['bad', 'filter'] })).toBe('one [filtered] word')
  })

  test('backreferences in a pattern still work', () => {
    expect(filter('a hahaha b', { patterns: ['(ha)\\1+'] })).toBe('a [filtered] b')
  })

  test('zero-length matches are ignored', () => {
    expect(filter('plain text', { patterns: ['\\b'] })).toBe('plain text')
    expect(filter('a bad b', { patterns: ['\\b', 'bad'] })).toBe('a [filtered] b')
  })

  test('matching ignores case unless case-sensitive', () => {
    expect(filter('BadWord', { patterns: ['badword'] })).toBe('[filtered]')
    expect(filter('BadWord', { patterns: ['badword'], caseSensitive: true })).toBe('BadWord')
    expect(filter('BadWord', { words: ['badword'] })).toBe('[filtered]')
    expect(filter('BadWord', { words: ['badword'], caseSensitive: true })).toBe('BadWord')
  })

  describe('words', () => {
    test('regex syntax characters match literally', () => {
      expect(filter('I like c++ a lot', { words: ['c++'] })).toBe('I like [filtered] a lot')
      expect(filter('axb and a.b', { words: ['a.b'] })).toBe('axb and [filtered]')
    })

    test('a hyphenated word compiles under the u flag', () => {
      expect(textEntryError('x-y', 'word', false)).toBeNull()
      expect(filter('x-y z', { words: ['x-y'] })).toBe('[filtered] z')
    })

    test('only whole words match', () => {
      expect(filter('a class act', { words: ['ass'] })).toBe('a class act')
      expect(filter('an ass.', { words: ['ass'] })).toBe('an [filtered].')
    })

    test('boundaries work for non-ASCII words, where \\b does not', () => {
      expect(/\bcafé\b/i.test('a café')).toBe(false)
      expect(filter('a café here, cafés', { words: ['café'] })).toBe('a [filtered] here, cafés')
      expect(filter('скажи привет!', { words: ['привет'] })).toBe('скажи [filtered]!')
    })

    test('a phrase matches across any run of whitespace', () => {
      expect(filter('a bad\n   word', { words: ['bad word'] })).toBe('a [filtered]')
    })
  })

  describe('validation', () => {
    test('an invalid pattern is reported without dropping the valid ones', () => {
      const { regexes, errors } = compileTextEntries(['ok', '(bad', 'fine'], 'regex', false)

      expect(regexes).toHaveLength(2)
      expect(errors).toHaveLength(1)
      expect(errors[0].index).toBe(1)
    })

    test('a pattern matching empty text is rejected', () => {
      expect(textEntryError('a*', 'regex', false)).toBe('Matches empty text')
      expect(textEntryError('.*', 'regex', false)).toBe('Matches empty text')
    })

    test('length and count caps are enforced', () => {
      expect(textEntryError('a'.repeat(MAX_TEXT_FILTER_ENTRY_LENGTH + 1), 'word', false)).not.toBeNull()

      const tooMany = Array.from({ length: MAX_TEXT_FILTER_ENTRIES + 1 }, (_, i) => `w${i}`)
      const { regexes, errors } = compileTextEntries(tooMany, 'word', false)
      expect(regexes).toHaveLength(MAX_TEXT_FILTER_ENTRIES)
      expect(errors.map(error => error.index)).toEqual([MAX_TEXT_FILTER_ENTRIES])
    })

    test('lines are trimmed and blank lines dropped', () => {
      expect(parseEntryLines('  one \n\n two\n   \n')).toEqual(['one', 'two'])
    })
  })
})
