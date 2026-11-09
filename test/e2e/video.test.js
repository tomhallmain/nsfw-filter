// <video> support. The fixture is grey frames recorded by the browser itself
// (fixtures/make-video.js), so these prove the plumbing: discovery, frame
// sampling, and that every classifiable video reaches a terminal status.
// Blocking unsafe footage needs unsafe footage and is covered by the unit tests.

// Videos at or below this size on either side are left untagged.
const MIN_VIDEO_SIZE = 41

const SETTLE_TIMEOUT = 60000

// A verdict on a frame is only observable as the status going through
// 'processing': a video with nothing decoded yet is left alone, not classified.
const recordStatuses = async (page) => await page.evaluateOnNewDocument(() => {
  window.__nsfwStatuses = []
  new MutationObserver(records => {
    for (const { target } of records) {
      if (target.tagName !== 'VIDEO') continue
      window.__nsfwStatuses.push(`${target.id}:${target.getAttribute('data-nsfw-filter-status')}`)
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-nsfw-filter-status'] })
})

const settled = async (page) => {
  await page.waitForFunction((min) =>
    [...document.querySelectorAll('video')]
      .filter(video => video.width > min && video.height > min)
      .every(video => {
        const status = video.getAttribute('data-nsfw-filter-status')
        return status !== null && status !== 'processing'
      }),
  { timeout: SETTLE_TIMEOUT, polling: 250 }, MIN_VIDEO_SIZE)
}

const read = async (page, id) => await page.evaluate((id) => {
  const video = document.getElementById(id)
  return {
    status: video.getAttribute('data-nsfw-filter-status'),
    visibility: getComputedStyle(video).visibility
  }
}, id)

const statuses = async (page, id) =>
  await page.evaluate((id) => window.__nsfwStatuses.filter(entry => entry.startsWith(`${id}:`)), id)

// One frame is classified at a time per page, so a video waits behind every
// other video before its own verdict comes back.
const classified = async (page, id) => await page.waitForFunction(
  (id) => window.__nsfwStatuses.includes(`${id}:processing`),
  { timeout: SETTLE_TIMEOUT, polling: 250 },
  id
)

// A posterless video is tagged 'sfw' before it is sampled, and reloading its
// media starts that over, so the status alone says nothing about where a video
// is: only a status that is not 'processing' with the element back on screen
// means a round finished. Waiting for that also rides out the sample a playing
// video takes every ten seconds of media time.
// The snapshot comes back from the same evaluation that accepted it: a playing
// video samples again every ten seconds of media time, so reading it over a
// second round trip can land in the next hide.
const settledStatus = async (page, id) => {
  const settled = await page.waitForFunction((id) => {
    const video = document.getElementById(id)
    const status = video.getAttribute('data-nsfw-filter-status')
    const visibility = getComputedStyle(video).visibility
    if (status === null || status === 'processing' || visibility !== 'visible') return false

    return { status, visibility }
  }, { timeout: SETTLE_TIMEOUT, polling: 250 }, id)

  return await settled.jsonValue()
}

describe('Videos on the page', () => {
  let page

  beforeAll(async () => {
    page = await global.__BROWSER__.newPage()
    // Sampling skips a hidden document, and a background tab is hidden.
    await page.bringToFront()
    await recordStatuses(page)
    await page.goto(`${global.__BASE_URL__}video.html`, { waitUntil: 'load' })
    // Muted playback is what a real video does and what makes frames decode.
    await page.evaluate(async () => {
      await Promise.all(
        [...document.querySelectorAll('video')].map(async video => await video.play().catch(() => undefined))
      )
    })
    await settled(page)
  }, SETTLE_TIMEOUT)

  afterAll(async () => {
    await page.close()
  })

  test('classifies a video from a sampled frame', async () => {
    await classified(page, 'plain')
    const plain = await settledStatus(page, 'plain')

    expect(plain.status).toBe('sfw')
    expect(plain.visibility).toBe('visible')
  })

  test('settles a video that has a poster', async () => {
    await classified(page, 'postered')
    const postered = await settledStatus(page, 'postered')
    expect(postered.status).toBe('sfw')
    expect(postered.visibility).toBe('visible')
  })

  test('leaves a video below MIN_VIDEO_SIZE untagged and visible', async () => {
    const tiny = await read(page, 'tiny')
    expect(tiny.status).toBeNull()
    expect(tiny.visibility).toBe('visible')
    expect(await statuses(page, 'tiny')).not.toContain('tiny:processing')
  })

  // Served from another origin without CORS headers. The offscreen document
  // fetches the bytes itself, so the video is still classified, and it must
  // never be left hidden either way.
  test('settles and shows a video from a host that sends no CORS headers', async () => {
    const foreign = await settledStatus(page, 'foreign')
    expect(['sfw', 'error']).toContain(foreign.status)
    expect(foreign.visibility).toBe('visible')
  })

  test('picks up and classifies a video added after load', async () => {
    await page.evaluate((base) => {
      const video = document.createElement('video')
      video.id = 'added'
      video.src = `${base}video.webm`
      video.width = 320
      video.height = 240
      video.muted = true
      video.playsInline = true
      document.body.appendChild(video)
      video.play().catch(() => undefined)
    }, global.__BASE_URL__)

    await classified(page, 'added')
    const added = await settledStatus(page, 'added')

    expect(added.status).toBe('sfw')
    expect(added.visibility).toBe('visible')
  })

  test('leaves no video stuck hidden or unprocessed', async () => {
    const stuck = await page.waitForFunction((min) => {
      const videos = [...document.querySelectorAll('video')]
      const pending = videos.some(video => {
        const status = video.getAttribute('data-nsfw-filter-status')
        const classifiable = video.width > min && video.height > min
        return (classifiable && status === null) || status === 'processing'
      })
      if (pending) return false

      return videos.filter(video => getComputedStyle(video).visibility === 'hidden').map(video => video.id)
    }, { timeout: SETTLE_TIMEOUT, polling: 250 }, MIN_VIDEO_SIZE)

    expect(await stuck.jsonValue()).toEqual([])
  })
})
