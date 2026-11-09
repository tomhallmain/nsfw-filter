type ChromeStub = {
  runtime: {
    getContexts: jest.Mock
    sendMessage: jest.Mock
    lastError: { message: string } | undefined
  }
  offscreen: {
    createDocument: jest.Mock
    closeDocument: jest.Mock
  }
}

const loadLifecycle = async (): Promise<typeof import('../../src/background/offscreenLifecycle')> => {
  let lifecycle: typeof import('../../src/background/offscreenLifecycle') | undefined
  jest.isolateModules(() => {
    lifecycle = require('../../src/background/offscreenLifecycle')
  })
  return lifecycle as typeof import('../../src/background/offscreenLifecycle')
}

describe('background => offscreenLifecycle', () => {
  let chromeStub: ChromeStub

  const setDocumentCount = (count: number): void => {
    chromeStub.runtime.getContexts.mockResolvedValue(new Array(count).fill({}))
  }

  const answerPing = (): void => {
    chromeStub.runtime.sendMessage.mockImplementation((_request: unknown, callback: (r: unknown) => void) => {
      callback({ alive: true })
    })
  }

  const failPing = (): void => {
    chromeStub.runtime.sendMessage.mockImplementation((_request: unknown, callback: (r: unknown) => void) => {
      // Chrome exposes lastError only for the duration of the callback.
      chromeStub.runtime.lastError = { message: 'Receiving end does not exist.' }
      callback(undefined)
      chromeStub.runtime.lastError = undefined
    })
  }

  beforeEach(() => {
    chromeStub = {
      runtime: {
        getContexts: jest.fn().mockResolvedValue([]),
        sendMessage: jest.fn(),
        lastError: undefined
      },
      offscreen: {
        createDocument: jest.fn().mockResolvedValue(undefined),
        closeDocument: jest.fn().mockResolvedValue(undefined)
      }
    }
    ;(global as unknown as { chrome: ChromeStub }).chrome = chromeStub
  })

  test('creates a document when none exists, and reports it as created', async () => {
    const { ensureOffscreenDocument } = await loadLifecycle()

    await expect(ensureOffscreenDocument()).resolves.toBe(true)
    expect(chromeStub.offscreen.createDocument).toHaveBeenCalledTimes(1)
  })

  test('keeps a responsive document and does not recreate it', async () => {
    const { ensureOffscreenDocument } = await loadLifecycle()
    setDocumentCount(1)
    answerPing()

    await expect(ensureOffscreenDocument()).resolves.toBe(false)
    expect(chromeStub.offscreen.createDocument).not.toHaveBeenCalled()
    expect(chromeStub.offscreen.closeDocument).not.toHaveBeenCalled()
  })

  test('pings at most once per health-check interval', async () => {
    const { ensureOffscreenDocument } = await loadLifecycle()
    setDocumentCount(1)
    answerPing()

    await ensureOffscreenDocument()
    await ensureOffscreenDocument()
    await ensureOffscreenDocument()

    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('closes and recreates a document that stops answering', async () => {
    const { ensureOffscreenDocument } = await loadLifecycle()
    setDocumentCount(1)
    failPing()

    await expect(ensureOffscreenDocument()).resolves.toBe(true)
    expect(chromeStub.offscreen.closeDocument).toHaveBeenCalledTimes(1)
    expect(chromeStub.offscreen.createDocument).toHaveBeenCalledTimes(1)
  })

  test('creates one document for concurrent callers', async () => {
    const { ensureOffscreenDocument } = await loadLifecycle()

    await Promise.all([
      ensureOffscreenDocument(),
      ensureOffscreenDocument(),
      ensureOffscreenDocument()
    ])

    expect(chromeStub.offscreen.createDocument).toHaveBeenCalledTimes(1)
  })

  test('markOffscreenUnhealthy forces the next call to ping again', async () => {
    const { ensureOffscreenDocument, markOffscreenUnhealthy } = await loadLifecycle()
    setDocumentCount(1)
    answerPing()

    await ensureOffscreenDocument()
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledTimes(1)

    markOffscreenUnhealthy()
    await ensureOffscreenDocument()
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledTimes(2)
  })
})
