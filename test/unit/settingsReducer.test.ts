import { setAutoDlFrames, setBackgroundScanMode, setInterImageAwareness, setTextFilter } from '../../src/popup/redux/actions/settings'
import { settings } from '../../src/popup/redux/reducers/settings'
import { SettingsActionTypes } from '../../src/popup/redux/actions/settings'

const initial = (): ReturnType<typeof settings> =>
  settings(undefined, { type: '@@INIT' } as unknown as SettingsActionTypes)

describe('popup => settings reducer', () => {
  test('inter-image awareness ships on, with both gates set', () => {
    const state = initial()

    expect(state.interImageAwarenessEnabled).toBe(true)
    expect(state.interImageAwarenessMinCount).toBe(6)
    expect(state.interImageAwarenessMinRatio).toBe(0.3)
  })

  test('each field can be set without disturbing the others', () => {
    const off = settings(initial(), setInterImageAwareness({ interImageAwarenessEnabled: false }))
    expect(off.interImageAwarenessEnabled).toBe(false)
    expect(off.interImageAwarenessMinCount).toBe(6)

    const retuned = settings(off, setInterImageAwareness({ interImageAwarenessMinCount: 10 }))
    expect(retuned.interImageAwarenessMinCount).toBe(10)
    expect(retuned.interImageAwarenessEnabled).toBe(false)
    expect(retuned.interImageAwarenessMinRatio).toBe(0.3)
  })

  test('state persisted before a setting existed is filled in, not left undefined', () => {
    // What chrome.storage hands back for a user who last saved before these
    // fields were added: complete for its own era, missing everything since.
    const stale = {
      enabled: true,
      logging: false,
      filterEffect: 'blur',
      trainedModel: 'MobileNet_v1.2',
      classifierBackend: 'onnx',
      filterStrictness: 70,
      websites: []
    } as unknown as ReturnType<typeof settings>

    const state = settings(stale, { type: '@@INIT' } as unknown as SettingsActionTypes)

    expect(state.interImageAwarenessEnabled).toBe(true)
    expect(state.interImageAwarenessMinCount).toBe(6)
    expect(state.dynamicSampleRatio).toBe(0.06)
    // Values the stored state did carry survive the hydrate.
    expect(state.filterStrictness).toBe(70)
    expect(state.classifierBackend).toBe('onnx')
  })

  test('background scanning ships on the tier that skips the whole-page style walk', () => {
    expect(initial().backgroundScanMode).toBe('stylesheet')
  })

  test('the background scan tier can be changed without disturbing other settings', () => {
    const state = settings(initial(), setBackgroundScanMode('computed'))

    expect(state.backgroundScanMode).toBe('computed')
    expect(state.filterEffect).toBe('blur')
    expect(state.interImageAwarenessEnabled).toBe(true)
  })

  test('frame auto-download ships off, and stays off for state saved before it existed', () => {
    expect(initial().autoDlFramesEnabled).toBe(false)

    const stale = { ...initial() } as Partial<ReturnType<typeof settings>>
    delete stale.autoDlFramesEnabled
    const hydrated = settings(stale as ReturnType<typeof settings>, { type: '@@INIT' } as unknown as SettingsActionTypes)
    expect(hydrated.autoDlFramesEnabled).toBe(false)
  })

  test('frame auto-download fields can be set without disturbing each other', () => {
    const on = settings(initial(), setAutoDlFrames({ autoDlFramesEnabled: true }))
    const tuned = settings(on, setAutoDlFrames({ autoDlSignatureThreshold: 0.3 }))

    expect(tuned.autoDlFramesEnabled).toBe(true)
    expect(tuned.autoDlSignatureThreshold).toBe(0.3)
    expect(tuned.autoDlMaxPairsPerVideo).toBe(3)
    expect(tuned.autoDlMaxPairsPerSession).toBe(20)
  })

  test('the text filter ships off and empty, and stays so for state saved before it existed', () => {
    const state = initial()
    expect(state.textFilterEnabled).toBe(false)
    expect(state.textFilterWords).toEqual([])
    expect(state.textFilterPatterns).toEqual([])
    expect(state.textFilterCaseSensitive).toBe(false)

    const stale = { ...initial() } as Partial<ReturnType<typeof settings>>
    delete stale.textFilterEnabled
    delete stale.textFilterWords
    delete stale.textFilterPatterns
    delete stale.textFilterCaseSensitive
    const hydrated = settings(stale as ReturnType<typeof settings>, { type: '@@INIT' } as unknown as SettingsActionTypes)
    expect(hydrated.textFilterEnabled).toBe(false)
    expect(hydrated.textFilterWords).toEqual([])
    expect(hydrated.textFilterPatterns).toEqual([])
  })

  test('text filter fields can be set without disturbing each other', () => {
    const on = settings(initial(), setTextFilter({ textFilterEnabled: true }))
    const saved = settings(on, setTextFilter({ textFilterWords: ['bad'], textFilterPatterns: ['wor+d'] }))

    expect(saved.textFilterEnabled).toBe(true)
    expect(saved.textFilterWords).toEqual(['bad'])
    expect(saved.textFilterPatterns).toEqual(['wor+d'])
    expect(saved.textFilterCaseSensitive).toBe(false)
  })
})
