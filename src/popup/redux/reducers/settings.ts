import { BackgroundScanMode } from '../../../content/Filter/backgroundScan'
import { ClassifierBackend, DEFAULT_CLASSIFIER_BACKEND, isClassifierBackend } from '../../../utils/models'
import { SettingsActionTypes } from '../actions/settings'
import {
  TOGGLE_LOGGING,
  TOGGLE_ENABLED,
  SET_FILTER_EFFECT,
  SET_CLASSIFIER_BACKEND,
  SET_FILTER_STRICTNESS,
  SET_WEBSITE_LIST,
  SET_DYNAMIC_MEDIA_SETTINGS,
  SET_INTER_IMAGE_AWARENESS,
  SET_BACKGROUND_SCAN_MODE,
  SET_AUTO_DL_FRAMES
} from '../actions/settings/settingsTypes'

export type SettingsState = {
  enabled: boolean
  logging: boolean
  filterEffect: 'hide' | 'blur' | 'grayscale'
  classifierBackend: ClassifierBackend
  filterStrictness: number
  websites: string[]
  dynamicSampleRatio: number
  dynamicPositiveRatio: number
  dynamicMinSamples: number
  dynamicMaxSamples: number
  dynamicMaxConcurrentGlobal: number
  dynamicMaxConcurrentPerTab: number
  dynamicQueueLimitPerTab: number
  interImageAwarenessEnabled: boolean
  interImageAwarenessMinCount: number
  interImageAwarenessMinRatio: number
  backgroundScanMode: BackgroundScanMode
  autoDlFramesEnabled: boolean
  autoDlSignatureThreshold: number
  autoDlMaxPairsPerVideo: number
  autoDlMaxPairsPerSession: number
}

const initialState: SettingsState = {
  enabled: true,
  logging: process.env.NODE_ENV === 'development',
  filterEffect: 'blur',
  classifierBackend: DEFAULT_CLASSIFIER_BACKEND,
  filterStrictness: 55,
  websites: [],
  dynamicSampleRatio: 0.06,
  dynamicPositiveRatio: 0.12,
  dynamicMinSamples: 2,
  dynamicMaxSamples: 10,
  dynamicMaxConcurrentGlobal: 2,
  dynamicMaxConcurrentPerTab: 1,
  dynamicQueueLimitPerTab: 30,
  interImageAwarenessEnabled: true,
  // Both gates must clear, so this floor is what a small page is judged on.
  // Kept high enough that a couple of stray misclassifications cannot sweep a
  // page on their own; the ratio is what protects large pages.
  interImageAwarenessMinCount: 6,
  interImageAwarenessMinRatio: 0.3,
  // Reaches inline background-image attributes plus anything a readable
  // stylesheet rule paints, without resolving styles for every element on the
  // page the way 'computed' does.
  backgroundScanMode: 'stylesheet',
  // Writes video frames to the user's Downloads folder, so it must stay off
  // until the user turns it on.
  autoDlFramesEnabled: false,
  autoDlSignatureThreshold: 0.5,
  autoDlMaxPairsPerVideo: 3,
  autoDlMaxPairsPerSession: 20
}

export function settings (state = initialState, action: SettingsActionTypes): SettingsState {
  // Persisted state from older versions omits any key added since it was
  // written, so check every one -- naming individual keys here means each new
  // setting silently reads as undefined until someone remembers to add it.
  const partial = state as Partial<SettingsState>
  const keys = Object.keys(initialState) as Array<keyof SettingsState>
  const needsHydrate = keys.some(key => partial[key] === undefined)
  let s = needsHydrate ? { ...initialState, ...state } : state
  // A backend removed in a later version (or a downgrade) would leave an id the
  // offscreen document can't load; reset it so classification never wedges.
  if (!isClassifierBackend(s.classifierBackend)) s = { ...s, classifierBackend: DEFAULT_CLASSIFIER_BACKEND }

  switch (action.type) {
    case TOGGLE_ENABLED:
      return { ...s, enabled: !s.enabled }
    case TOGGLE_LOGGING:
      return { ...s, logging: !s.logging }
    case SET_FILTER_EFFECT:
      return { ...s, filterEffect: action.payload.filterEffect }
    case SET_CLASSIFIER_BACKEND:
      return { ...s, classifierBackend: action.payload.classifierBackend }
    case SET_FILTER_STRICTNESS:
      return { ...s, filterStrictness: action.payload.filterStrictness }
    case SET_WEBSITE_LIST:
      return { ...s, websites: action.payload.websites }
    case SET_DYNAMIC_MEDIA_SETTINGS:
      return { ...s, ...action.payload }
    case SET_INTER_IMAGE_AWARENESS:
      return { ...s, ...action.payload }
    case SET_AUTO_DL_FRAMES:
      return { ...s, ...action.payload }
    case SET_BACKGROUND_SCAN_MODE:
      return { ...s, backgroundScanMode: action.payload.backgroundScanMode }
    default:
      return s
  }
}
