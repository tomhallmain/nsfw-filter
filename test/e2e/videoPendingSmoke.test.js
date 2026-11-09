const VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'

describe('Video pending placeholder smoke test', () => {
    test('shows pending placeholder and then resolves', async () => {
        const page = await global.__BROWSER__.newPage()

        try {
            await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })

            await page.evaluate((url) => {
                for (let i = 0; i < 8; i++) {
                    const video = document.createElement('video')
                    video.setAttribute('id', `nsfw-filter-e2e-video-${i}`)
                    video.setAttribute('muted', 'true')
                    video.setAttribute('playsinline', 'true')
                    video.src = `${url}?v=${i}`
                    document.body.appendChild(video)
                }
            }, VIDEO_URL)

            await page.waitForFunction(() => {
                const pendingNodes = document.querySelectorAll('[data-nsfw-filter-pending-for="video"]')
                return pendingNodes.length > 0
            }, { timeout: 5000 })

            await page.waitForFunction(() => {
                const videos = Array.from(document.querySelectorAll('video[id^="nsfw-filter-e2e-video-"]'))
                if (videos.length === 0) return false

                const hasProcessing = videos.some(video => video.getAttribute('data-nsfw-filter-status') === 'processing')
                const pendingNodes = document.querySelectorAll('[data-nsfw-filter-pending-for="video"]')
                return hasProcessing === false && pendingNodes.length === 0
            }, { timeout: 20000 })
        } finally {
            await page.close()
        }
    })
})
