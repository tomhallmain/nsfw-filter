import { OffscreenModel } from '../../src/background/OffscreenModel'
import { ClassifierSettings } from '../../src/background/classifier/MediaClassifier'
import { ensureOffscreenDocument, markOffscreenUnhealthy } from '../../src/background/offscreenLifecycle'
import { postToOffscreen, sendToOffscreen } from '../../src/background/offscreenMessaging'

jest.mock('../../src/background/offscreenLifecycle', () => ({
  ensureOffscreenDocument: jest.fn(),
  markOffscreenUnhealthy: jest.fn()
}))

jest.mock('../../src/background/offscreenMessaging', () => ({
  sendToOffscreen: jest.fn(),
  postToOffscreen: jest.fn()
}))

const ensureMock = ensureOffscreenDocument as jest.MockedFunction<typeof ensureOffscreenDocument>
const unhealthyMock = markOffscreenUnhealthy as jest.MockedFunction<typeof markOffscreenUnhealthy>
const sendMock = sendToOffscreen as jest.MockedFunction<typeof sendToOffscreen>
const postMock = postToOffscreen as jest.MockedFunction<typeof postToOffscreen>

const settings: ClassifierSettings = {
  filterStrictness: 80,
  logging: false,
  classifierBackend: 'onnx'
}

describe('background => OffscreenModel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ensureMock.mockResolvedValue(false)
  })

  test('maps a blocked verdict back to a classification result', async () => {
    sendMock.mockResolvedValue({
      result: true,
      topNsfwClass: 'class_1',
      borderColor: '#e11d48',
      score: 0.92
    })

    const result = await new OffscreenModel().predict('https://example.com/a.jpg')

    expect(result).toEqual({
      blocked: true,
      topNsfwClass: 'class_1',
      borderColor: '#e11d48',
      score: 0.92
    })
  })

  test('surfaces a classifier error without touching document health', async () => {
    sendMock.mockResolvedValue({ result: false, error: 'Model is not loaded' })

    await expect(new OffscreenModel().predict('https://example.com/a.jpg'))
      .rejects.toThrow('Model is not loaded')
    expect(unhealthyMock).not.toHaveBeenCalled()
  })

  test('marks the document unhealthy when the round trip itself fails', async () => {
    sendMock.mockRejectedValue(new Error('Offscreen CLASSIFY timed out after 20000ms'))

    await expect(new OffscreenModel().predict('https://example.com/a.jpg'))
      .rejects.toThrow('timed out')
    expect(unhealthyMock).toHaveBeenCalledTimes(1)
  })

  test('gives video and image predictions their own budgets', async () => {
    sendMock.mockResolvedValue({ result: false })
    const model = new OffscreenModel()

    await model.predict('https://example.com/a.jpg', 'image')
    await model.predict('https://example.com/a.mp4', 'video')

    const [imageTimeout, videoTimeout] = sendMock.mock.calls.map(call => call[1])
    expect(videoTimeout).toBeGreaterThan(imageTimeout)
  })

  test('re-pushes settings to a document it just created', async () => {
    sendMock.mockResolvedValue({ result: false })
    const model = new OffscreenModel()
    model.setSettings(settings)
    postMock.mockClear()

    ensureMock.mockResolvedValue(true)
    await model.predict('https://example.com/a.jpg')

    expect(postMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SET_SETTINGS',
      settings
    }))
  })

  test('leaves an existing document alone', async () => {
    sendMock.mockResolvedValue({ result: false })
    const model = new OffscreenModel()
    model.setSettings(settings)
    postMock.mockClear()

    await model.predict('https://example.com/a.jpg')

    expect(postMock).not.toHaveBeenCalled()
  })
})
