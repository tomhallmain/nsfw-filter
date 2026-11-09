import {
  AutoDlSession,
  autoDlSettingsFrom,
  AutoDlSettings,
  DEFAULT_AUTO_DL_SETTINGS,
  hashUrl,
  mediaOrigin,
  SampledFrame
} from '../../src/background/classifier/autoDlFrames'
import { validateAutoDlFiles } from '../../src/background/autoDlDownloads'
import { ILogger } from '../../src/utils/Logger'
import { AutoDlFile } from '../../src/utils/messages'

const URL_A = 'https://cdn.example.com/videos/clip.mp4?token=secret'
const MODEL = { backend: 'onnx' as const, model: 'resnet34 (resnet34_model.onnx)' }

const buildLogger = (): ILogger & { lines: string[] } => {
  const lines: string[] = []
  return { status: true, lines, log: line => { lines.push(line) }, error: () => undefined, enable: () => undefined, disable: () => undefined }
}

const settings = (overrides: Partial<AutoDlSettings> = {}): AutoDlSettings =>
  ({ ...DEFAULT_AUTO_DL_SETTINGS, enabled: true, ...overrides })

const frame = (index: number, positiveScore: number): SampledFrame => ({
  index,
  timeSeconds: index * 2,
  size: 2,
  pixels: new Uint8ClampedArray(16),
  signature: { positiveScore, classes: [{ name: 'Neutral', probability: 1 - positiveScore }, { name: 'Porn', probability: positiveScore }] }
})

const setup = (encode: (pixels: Uint8ClampedArray, size: number) => string = () => 'data:image/png;base64,AAAA') => {
  const sent: AutoDlFile[][] = []
  const logger = buildLogger()
  const session = new AutoDlSession(encode, files => sent.push(files), logger, () => 1000)
  return { session, sent, logger }
}

const names = (files: AutoDlFile[]): string[] => files.map(f => f.filename.split('/').pop() as string)
const sidecar = (files: AutoDlFile[]): any => {
  const json = files.find(f => f.filename.endsWith('.json')) as AutoDlFile
  return JSON.parse(decodeURIComponent(json.dataUrl.slice(json.dataUrl.indexOf(',') + 1)))
}

describe('background => autoDlFrames', () => {
  test('is off by default and yields no tracker', () => {
    const { session } = setup()
    expect(autoDlSettingsFrom({ filterStrictness: 55, logging: false }).enabled).toBe(false)
    expect(session.startVideo(URL_A, { ...DEFAULT_AUTO_DL_SETTINGS }, MODEL)).toBeNull()
  })

  test('saves both frames of a swing at or above the threshold, and nothing below it', () => {
    const { session, sent } = setup()
    const tracker = session.startVideo(URL_A, settings({ threshold: 0.5 }), MODEL)!

    tracker.observe(frame(0, 0.1))
    tracker.observe(frame(1, 0.55)) // delta 0.45
    expect(sent).toHaveLength(0)

    tracker.observe(frame(2, 0.05)) // delta 0.5
    expect(sent).toHaveLength(1)
    expect(names(sent[0])).toEqual(['frame-1.png', 'frame-2.png', 'pair-1-2.json'])
  })

  test('a frame already saved as the previous "after" is not written again', () => {
    const { session, sent } = setup()
    const tracker = session.startVideo(URL_A, settings(), MODEL)!

    tracker.observe(frame(0, 0.0))
    tracker.observe(frame(1, 0.9))
    tracker.observe(frame(2, 0.1))

    expect(names(sent[0])).toEqual(['frame-0.png', 'frame-1.png', 'pair-0-1.json'])
    expect(names(sent[1])).toEqual(['frame-2.png', 'pair-1-2.json'])
    expect(sidecar(sent[1]).before.file).toBe('frame-1.png')
  })

  test('a frame without a signature breaks adjacency', () => {
    const { session, sent } = setup()
    const tracker = session.startVideo(URL_A, settings(), MODEL)!

    tracker.observe(frame(0, 0.0))
    tracker.observe(null)
    tracker.observe(frame(2, 0.9))
    expect(sent).toHaveLength(0)
  })

  test('caps pairs per video and per session', () => {
    const { session, sent } = setup()
    const capped = settings({ maxPairsPerVideo: 2, maxPairsPerSession: 3 })

    const first = session.startVideo(URL_A, capped, MODEL)!
    for (let i = 0; i < 6; i++) first.observe(frame(i, i % 2))
    expect(sent).toHaveLength(2)

    const second = session.startVideo('https://other.example/v.mp4', capped, MODEL)!
    for (let i = 0; i < 6; i++) second.observe(frame(i, i % 2))
    expect(sent).toHaveLength(3)

    expect(session.startVideo('https://third.example/v.mp4', capped, MODEL)).toBeNull()
  })

  test('the sidecar and filenames do not contain the source URL', () => {
    const { session, sent } = setup()
    const tracker = session.startVideo(URL_A, settings(), MODEL)!
    tracker.observe(frame(0, 0.0))
    tracker.observe(frame(1, 0.8))

    const files = sent[0]
    for (const file of files) expect(file.filename).not.toContain('example.com')
    const meta = sidecar(files)
    expect(JSON.stringify(meta)).not.toContain('secret')
    expect(JSON.stringify(meta)).not.toContain('/videos/')
    expect(meta).toMatchObject({
      videoId: hashUrl(URL_A),
      mediaOrigin: 'https://cdn.example.com',
      backend: 'onnx',
      threshold: 0.5,
      before: { sampleIndex: 0, timeSeconds: 0, positiveScore: 0 },
      after: { sampleIndex: 1, timeSeconds: 2, positiveScore: 0.8 }
    })
    expect(meta.delta).toBeCloseTo(0.8)
    expect(meta.after.classes).toHaveLength(2)
  })

  test('an encoding failure skips the pair without throwing or using budget', () => {
    let fail = true
    const { session, sent, logger } = setup(() => {
      if (fail) throw new Error('tainted')
      return 'data:image/png;base64,AAAA'
    })
    const tracker = session.startVideo(URL_A, settings({ maxPairsPerVideo: 1 }), MODEL)!

    expect(() => { tracker.observe(frame(0, 0)); tracker.observe(frame(1, 1)) }).not.toThrow()
    expect(sent).toHaveLength(0)
    expect(logger.lines.some(line => line.includes('tainted'))).toBe(true)

    fail = false
    tracker.observe(frame(2, 0))
    expect(sent).toHaveLength(1)
    // Frame 1 never reached disk, so it is written as this pair's "before".
    expect(names(sent[0])).toEqual(['frame-1.png', 'frame-2.png', 'pair-1-2.json'])
  })

  test('everything the tracker produces passes the service worker validation', () => {
    const { session, sent } = setup()
    const tracker = session.startVideo(URL_A, settings(), MODEL)!
    tracker.observe(frame(10, 0))
    tracker.observe(frame(11, 1))
    tracker.observe(frame(12, 0))

    expect(sent).toHaveLength(2)
    for (const files of sent) expect(validateAutoDlFiles(files)).toEqual(files)
  })

  test('mediaOrigin keeps scheme and host only', () => {
    expect(mediaOrigin('https://a.example:8443/p?q=1')).toBe('https://a.example:8443')
    expect(mediaOrigin('blob:https://a.example/uuid')).toBe('blob:')
    expect(mediaOrigin('not a url')).toBe('unknown')
  })
})
