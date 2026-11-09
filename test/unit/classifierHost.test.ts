import { ClassifierHost, REBUILD_COOLDOWN_MS } from '../../src/background/classifier/classifierHost'
import { blockedResult, visibleResult } from '../../src/background/classifier/ClassificationResult'
import {
  ClassifierBackend,
  ClassifierSettings,
  MediaClassifier
} from '../../src/background/classifier/MediaClassifier'
import { ILogger } from '../../src/utils/Logger'

type StubClassifier = MediaClassifier & {
  dispose: jest.Mock
  setSettings: jest.Mock
  classifyImage: jest.Mock
}

const buildSettings = (overrides: Partial<ClassifierSettings> = {}): ClassifierSettings => ({
  filterStrictness: 55,
  logging: false,
  classifierBackend: 'nsfwjs',
  ...overrides
})

const buildLogger = (): ILogger => ({
  status: false,
  log: jest.fn(),
  error: jest.fn(),
  enable: jest.fn(),
  disable: jest.fn()
})

const buildClassifier = (backend: ClassifierBackend, ready: Promise<void>): StubClassifier => ({
  backend,
  ready,
  classifyImage: jest.fn(async () => visibleResult()),
  classifyVideo: jest.fn(async () => visibleResult()),
  classifyGif: jest.fn(async () => visibleResult()),
  setSettings: jest.fn(),
  dispose: jest.fn()
}) as unknown as StubClassifier

describe('background => ClassifierHost', () => {
  let consoleError: jest.SpyInstance
  let consoleWarn: jest.SpyInstance

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  test('builds lazily, on first use rather than on construction', () => {
    const factory = jest.fn(() => buildClassifier('nsfwjs', Promise.resolve()))
    const host = new ClassifierHost(factory, buildLogger(), buildSettings())

    expect(host).toBeDefined()

    expect(factory).not.toHaveBeenCalled()
  })

  test('rebuilds after a failed load instead of staying broken', async () => {
    const working = buildClassifier('nsfwjs', Promise.resolve())
    let failed: StubClassifier | undefined
    const factory = jest.fn()
      .mockImplementationOnce(() => {
        // Built inside the factory so the host owns the rejection from the
        // start, the way a real failing load behaves.
        failed = buildClassifier('nsfwjs', Promise.reject(new Error('model load failed')))
        return failed
      })
      .mockImplementationOnce(() => working)

    let clock = 1000
    const host = new ClassifierHost(factory, buildLogger(), buildSettings(), () => clock)

    await expect(host.classify('https://example.com/a.jpg', 'image')).rejects.toThrow('model load failed')

    clock += REBUILD_COOLDOWN_MS + 1
    working.classifyImage.mockResolvedValue(blockedResult('class_1', '#e11d48', 0.9))
    const result = await host.classify('https://example.com/a.jpg', 'image')

    expect(result.blocked).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(failed?.dispose).toHaveBeenCalled()
  })

  test('holds off on rebuilding until the cooldown passes', async () => {
    const factory = jest.fn(() => buildClassifier('nsfwjs', Promise.reject(new Error('model load failed'))))
    let clock = 1000
    const host = new ClassifierHost(factory, buildLogger(), buildSettings(), () => clock)

    await expect(host.classify('https://example.com/a.jpg', 'image')).rejects.toThrow('model load failed')

    clock += REBUILD_COOLDOWN_MS - 1
    await expect(host.classify('https://example.com/b.jpg', 'image')).rejects.toThrow('model load failed')
    expect(factory).toHaveBeenCalledTimes(1)

    clock += 2
    await expect(host.classify('https://example.com/c.jpg', 'image')).rejects.toThrow('model load failed')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  test('starts one load for concurrent callers', async () => {
    const factory = jest.fn(() => buildClassifier('nsfwjs', Promise.resolve()))
    const host = new ClassifierHost(factory, buildLogger(), buildSettings())

    await Promise.all([
      host.classify('https://example.com/a.jpg', 'image'),
      host.classify('https://example.com/b.jpg', 'image'),
      host.classify('https://example.com/c.jpg', 'image')
    ])

    expect(factory).toHaveBeenCalledTimes(1)
  })

  test('reuses a loaded classifier and forwards new settings to it', async () => {
    const classifier = buildClassifier('nsfwjs', Promise.resolve())
    const factory = jest.fn(() => classifier)
    const host = new ClassifierHost(factory, buildLogger(), buildSettings())

    await host.ensure(buildSettings())
    await host.ensure(buildSettings({ filterStrictness: 80 }))

    expect(factory).toHaveBeenCalledTimes(1)
    expect(classifier.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ filterStrictness: 80 }))
  })

  test('disposes the previous classifier only once the new backend is ready', async () => {
    const nsfwjs = buildClassifier('nsfwjs', Promise.resolve())
    let resolveOnnx = (): void => undefined
    const onnx = buildClassifier('onnx', new Promise<void>(resolve => { resolveOnnx = () => resolve() }))
    const factory = jest.fn()
      .mockReturnValueOnce(nsfwjs)
      .mockReturnValueOnce(onnx)

    const host = new ClassifierHost(factory, buildLogger(), buildSettings())
    await host.ensure(buildSettings())

    const switching = host.ensure(buildSettings({ classifierBackend: 'onnx' }))
    expect(nsfwjs.dispose).not.toHaveBeenCalled()

    resolveOnnx()
    await switching
    expect(nsfwjs.dispose).toHaveBeenCalled()
  })

  test('falls back to nsfwjs when the selected backend cannot start', async () => {
    const onnx = buildClassifier('onnx', Promise.reject(new Error('ort session failed')))
    const nsfwjs = buildClassifier('nsfwjs', Promise.resolve())
    const factory = jest.fn()
      .mockReturnValueOnce(onnx)
      .mockReturnValueOnce(nsfwjs)

    const host = new ClassifierHost(factory, buildLogger(), buildSettings({ classifierBackend: 'onnx' }))
    await host.ensure(buildSettings({ classifierBackend: 'onnx' }))

    expect(factory).toHaveBeenNthCalledWith(1, 'onnx', expect.anything(), expect.anything())
    expect(factory).toHaveBeenNthCalledWith(2, 'nsfwjs', expect.anything(), expect.anything())
  })

  test('routes each media type to its own classify method', async () => {
    const classifier = buildClassifier('nsfwjs', Promise.resolve())
    const host = new ClassifierHost(() => classifier, buildLogger(), buildSettings())

    await host.classify('https://example.com/a.jpg', 'image')
    await host.classify('https://example.com/a.mp4', 'video')
    await host.classify('https://example.com/a.gif', 'gif')

    expect(classifier.classifyImage).toHaveBeenCalledWith('https://example.com/a.jpg')
    expect(classifier.classifyVideo).toHaveBeenCalledWith('https://example.com/a.mp4')
    expect(classifier.classifyGif).toHaveBeenCalledWith('https://example.com/a.gif')
  })
})
