import { AutoDlDownloadDeps, saveAutoDlFramePair, validateAutoDlFiles } from '../../src/background/autoDlDownloads'
import { AUTO_DL_FRAME_PAIR, AutoDlFile, AutoDlFramePairMessage } from '../../src/utils/messages'

const OFFSCREEN_URL = 'chrome-extension://abc/src/offscreen.html'
const DIR = 'nsfw-filter-frames/0123abcd-k1'

const png = (name: string): AutoDlFile => ({ filename: `${DIR}/${name}`, dataUrl: 'data:image/png;base64,AAAA' })
const json = (name: string): AutoDlFile => ({ filename: `${DIR}/${name}`, dataUrl: 'data:application/json;charset=utf-8,%7B%7D' })
const message = (files: AutoDlFile[]): AutoDlFramePairMessage => ({ target: 'background', type: AUTO_DL_FRAME_PAIR, files })

const deps = (overrides: Partial<AutoDlDownloadDeps> = {}): AutoDlDownloadDeps & { saved: string[] } => {
  const saved: string[] = []
  return {
    saved,
    offscreenUrl: OFFSCREEN_URL,
    isEnabled: async () => true,
    download: async file => { saved.push(file.filename) },
    log: () => undefined,
    ...overrides
  }
}

describe('background => autoDlDownloads', () => {
  test('refuses names outside the frames folder or with a mismatched type', () => {
    const bad: AutoDlFile[][] = [
      [{ filename: '../evil.png', dataUrl: 'data:image/png;base64,AAAA' }],
      [{ filename: `${DIR}/../../evil.png`, dataUrl: 'data:image/png;base64,AAAA' }],
      [{ filename: `${DIR}/frame-1.exe`, dataUrl: 'data:image/png;base64,AAAA' }],
      [{ filename: `${DIR}/frame-1.png`, dataUrl: 'https://example.com/x.png' }],
      [{ filename: `${DIR}/frame-1.png`, dataUrl: 'data:application/json;charset=utf-8,%7B%7D' }],
      [png('frame-1.png'), png('frame-2.png'), json('pair-1-2.json'), json('pair-2-3.json')],
      []
    ]
    for (const files of bad) expect(validateAutoDlFiles(files)).toBeNull()
    expect(validateAutoDlFiles('nope')).toBeNull()
  })

  test('downloads every file of a valid pair from the offscreen document', async () => {
    const d = deps()
    const files = [png('frame-1.png'), png('frame-2.png'), json('pair-1-2.json')]
    expect(await saveAutoDlFramePair(message(files), OFFSCREEN_URL, d)).toBe(3)
    expect(d.saved).toEqual(files.map(f => f.filename))
  })

  test('ignores other senders, a disabled setting, and a missing permission', async () => {
    const files = [png('frame-2.png'), json('pair-1-2.json')]

    const wrongSender = deps()
    expect(await saveAutoDlFramePair(message(files), 'https://example.com/', wrongSender)).toBe(0)
    expect(wrongSender.saved).toHaveLength(0)

    const disabled = deps({ isEnabled: async () => false })
    expect(await saveAutoDlFramePair(message(files), OFFSCREEN_URL, disabled)).toBe(0)
    expect(disabled.saved).toHaveLength(0)

    expect(await saveAutoDlFramePair(message(files), OFFSCREEN_URL, deps({ download: undefined }))).toBe(0)
  })

  test('one failed download does not stop the rest', async () => {
    const saved: string[] = []
    const d = deps({
      download: async file => {
        if (file.filename.endsWith('frame-1.png')) throw new Error('disk full')
        saved.push(file.filename)
      }
    })
    const files = [png('frame-1.png'), png('frame-2.png'), json('pair-1-2.json')]
    expect(await saveAutoDlFramePair(message(files), OFFSCREEN_URL, d)).toBe(2)
    expect(saved).toHaveLength(2)
  })
})
