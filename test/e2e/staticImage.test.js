// Regression guard for the flash fix: an image present in the markup at
// document_start must be hidden, classified, and revealed by the content
// script's initial sweep. Served locally so the result is deterministic.
describe('Static images present at load', () => {
  let page

  beforeAll(async () => {
    page = await global.__BROWSER__.newPage()
    await page.goto(global.__BASE_URL__, { waitUntil: 'domcontentloaded' })
    // Settle until every tagged image is past the 'processing' state.
    await global.getDocumentImageAttributes(page)
  })

  afterAll(async () => {
    await page.close()
  })

  const read = async (id) => await page.evaluate((id) => {
    const img = document.getElementById(id)
    return {
      status: img.getAttribute('data-nsfw-filter-status'),
      visibility: getComputedStyle(img).visibility
    }
  }, id)

  test('classifies a pre-existing SFW image and reveals it', async () => {
    const target = await read('target')
    expect(target.status).toBe('sfw')
    expect(target.visibility).toBe('visible')
  })

  // Untagged rather than 'sfw': the page-wide sweep blurs every image tagged
  // 'sfw', and icons too small to classify should not be swept.
  test('leaves an image below MIN_IMAGE_SIZE untagged and visible', async () => {
    const tiny = await read('tiny')
    expect(tiny.status).toBeNull()
    expect(tiny.visibility).toBe('visible')
  })

  test('leaves no image stuck hidden or unprocessed', async () => {
    const leftovers = await page.evaluate(() =>
      [...document.images].filter(img => {
        const status = img.getAttribute('data-nsfw-filter-status')
        const classifiable = img.width > 41 && img.height > 41
        return (classifiable && status === null) || status === 'processing' ||
          getComputedStyle(img).visibility === 'hidden'
      }).length
    )
    expect(leftovers).toBe(0)
  })
})
