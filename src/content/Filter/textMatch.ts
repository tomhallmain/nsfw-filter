/**
 * Turns the user's text-filter entries into a matcher: a function from a
 * string to the ranges in it that should be replaced. No DOM here, so the
 * popup uses the same compile and validation rules as the content script.
 *
 * Two kinds of entry, kept in separate lists:
 *
 * - **Words** are matched literally, as a whole word or phrase. Only regex
 *   syntax characters are escaped. Words compile with the `u` flag, and `u`
 *   rejects escapes that aren't needed (`/\-/u` is a syntax error), so
 *   escaping anything more would make ordinary words like `x-y` fail to
 *   compile.
 * - **Word boundaries** use `\p{L}`/`\p{N}` lookarounds because `\b` only
 *   knows ASCII word characters: `\bcafé\b` doesn't match "café", and
 *   `\bпривет\b` matches no Cyrillic text at all.
 * - A run of whitespace inside a phrase matches any run of whitespace, so a
 *   phrase still matches when the page breaks a line between its words.
 * - **Regex patterns** compile as typed with `g` (plus `i` unless
 *   case-sensitive) and without `u`, because `u` makes common patterns such
 *   as `\-` invalid.
 *
 * Every entry runs against the original text, and the ranges are merged
 * before anything is replaced. This stops one entry from matching inside
 * another's replacement (a `filter` pattern can't turn `[filtered]` into
 * `[[filtered]ed]`). Joining entries into one alternation would avoid that
 * too, but it renumbers capture groups and breaks backreferences like `\1`.
 *
 * Zero-length matches (`a*`, `\b`) are ignored at runtime, because a
 * replacement at every position would fill the text with markers. Validation
 * also rejects regex entries that match the empty string, but that only
 * catches some of them: `\b` doesn't match `''`, yet matches zero-length
 * inside text.
 *
 * Regex entries run synchronously on the page's main thread and can't be
 * timed out, so a catastrophically backtracking pattern like `(a+)+$` can
 * hang a tab. The length and count caps limit this risk but don't remove it.
 * Words can't backtrack that way: each is an escaped literal between fixed
 * lookarounds.
 */

export const TEXT_FILTER_REPLACEMENT = '[filtered]'

/** Caps on each list, for page performance; storage could hold far more. */
export const MAX_TEXT_FILTER_ENTRIES = 200
export const MAX_TEXT_FILTER_ENTRY_LENGTH = 500

export type TextEntryKind = 'word' | 'regex'

/** Half-open `[start, end)` offsets into the matched string. */
export type TextRange = [number, number]

/**
 * Finds what to replace. A classifier can take the regex matcher's place
 * without changing how ranges are applied to the page.
 */
export type TextMatcher = (text: string) => TextRange[]

export type TextEntryError = {
  /** Position in the list that was compiled. */
  index: number
  message: string
}

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/** Splits a text area's value into entries: one per line, trimmed, blanks dropped. */
export const parseEntryLines = (value: string): string[] =>
  value.split('\n').map(line => line.trim()).filter(line => line !== '')

const wordSource = (word: string): string =>
  `(?<!${WORD_CHAR})${word.replace(REGEX_SYNTAX, '\\$&').replace(/\s+/g, '\\s+')}(?!${WORD_CHAR})`

const buildRegex = (entry: string, kind: TextEntryKind, caseSensitive: boolean): RegExp => {
  const caseFlag = caseSensitive ? '' : 'i'
  return kind === 'word'
    ? new RegExp(wordSource(entry), `gu${caseFlag}`)
    : new RegExp(entry, `g${caseFlag}`)
}

/** Why one entry can't be used, or `null` if it can. */
export const textEntryError = (entry: string, kind: TextEntryKind, caseSensitive: boolean): string | null => {
  if (entry.length > MAX_TEXT_FILTER_ENTRY_LENGTH) {
    return `Longer than ${MAX_TEXT_FILTER_ENTRY_LENGTH} characters`
  }

  let regex: RegExp
  try {
    regex = buildRegex(entry, kind, caseSensitive)
  } catch (error) {
    return (error as Error).message
  }

  // A global regex keeps lastIndex between calls; test from the start.
  regex.lastIndex = 0
  if (regex.test('')) return 'Matches empty text'
  return null
}

/** Compiles every usable entry, reporting the rest without dropping the others. */
export const compileTextEntries = (
  entries: string[],
  kind: TextEntryKind,
  caseSensitive: boolean
): { regexes: RegExp[], errors: TextEntryError[] } => {
  const regexes: RegExp[] = []
  const errors: TextEntryError[] = []

  entries.forEach((entry, index) => {
    if (index >= MAX_TEXT_FILTER_ENTRIES) {
      errors.push({ index, message: `Past the limit of ${MAX_TEXT_FILTER_ENTRIES} entries` })
      return
    }

    const message = textEntryError(entry, kind, caseSensitive)
    if (message !== null) errors.push({ index, message })
    else regexes.push(buildRegex(entry, kind, caseSensitive))
  })

  return { regexes, errors }
}

export const createRegexMatcher = (regexes: RegExp[]): TextMatcher => text => {
  const ranges: TextRange[] = []

  for (const regex of regexes) {
    regex.lastIndex = 0
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (match[0].length === 0) {
        // exec would return the same empty match forever without this.
        regex.lastIndex++
        continue
      }
      ranges.push([match.index, match.index + match[0].length])
    }
  }

  return ranges
}

/**
 * Replaces each run of overlapping or touching ranges with one marker.
 * Returns `null` when nothing is replaced, so callers can skip the write.
 */
export const replaceRanges = (text: string, ranges: TextRange[]): string | null => {
  const sorted = ranges
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
  if (sorted.length === 0) return null

  let result = ''
  let cursor = 0
  let [start, end] = sorted[0]

  for (let i = 1; i <= sorted.length; i++) {
    const next = sorted[i]
    if (next !== undefined && next[0] <= end) {
      end = Math.max(end, next[1])
      continue
    }

    result += text.slice(cursor, start) + TEXT_FILTER_REPLACEMENT
    cursor = end
    if (next !== undefined) [start, end] = next
  }

  return result + text.slice(cursor)
}
