import { isPageSensitive, PageTally } from '../../src/content/Filter/pageSensitivity'

const thresholds = { minCount: 6, minRatio: 0.3 }

describe('content => pageSensitivity', () => {
  test('needs the absolute floor, however lopsided the ratio', () => {
    // 5 of 5 is every image on the page, and still under the floor.
    expect(isPageSensitive(5, 5, thresholds)).toBe(false)
    expect(isPageSensitive(6, 6, thresholds)).toBe(true)
  })

  test('needs the ratio, however large the count', () => {
    expect(isPageSensitive(6, 300, thresholds)).toBe(false)
    expect(isPageSensitive(6, 12, thresholds)).toBe(true)
  })

  test('treats the ratio as inclusive at the boundary', () => {
    expect(isPageSensitive(30, 100, thresholds)).toBe(true)
    expect(isPageSensitive(29, 100, thresholds)).toBe(false)
  })

  test('an unanalyzed page is never sensitive', () => {
    expect(isPageSensitive(0, 0, thresholds)).toBe(false)
  })

  test('PageTally notifies on every verdict, whichever filter recorded it', () => {
    const tally = new PageTally()
    const seen: boolean[] = []
    tally.onVerdict(() => seen.push(tally.isSensitive(thresholds)))

    for (let i = 0; i < 6; i++) tally.record(true)

    expect(seen).toEqual([false, false, false, false, false, true])
  })
})
