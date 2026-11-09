import { BackgroundScanMode } from '../../../../content/Filter/backgroundScan'
import { ClassifierBackend } from '../../../../utils/models'

import {
  TOGGLE_LOGGING,
  TOGGLE_DIV_FILTERING,
  TOGGLE_ENABLED,
  SET_FILTER_EFFECT,
  SET_CLASSIFIER_BACKEND,
  SET_FILTER_STRICTNESS,
  SET_WEBSITE_LIST,
  SET_DYNAMIC_MEDIA_SETTINGS,
  SET_INTER_IMAGE_AWARENESS,
  SET_BACKGROUND_SCAN_MODE,
  SET_AUTO_DL_FRAMES,
  SET_TEXT_FILTER
} from './settingsTypes'

export const toggleLogging = () => ({ type: TOGGLE_LOGGING } as const)
export const toggleDivFiltering = () => ({ type: TOGGLE_DIV_FILTERING } as const)
export const toggleEnabled = () => ({ type: TOGGLE_ENABLED } as const)

export const setFilterEffect = (filterEffect: 'hide' | 'blur' | 'grayscale') => ({
  type: SET_FILTER_EFFECT,
  payload: { filterEffect }
} as const)

export const setClassifierBackend = (classifierBackend: ClassifierBackend) => ({
  type: SET_CLASSIFIER_BACKEND,
  payload: { classifierBackend }
} as const)

export const setFilterStrictness = (filterStrictness: number) => ({
  type: SET_FILTER_STRICTNESS,
  payload: { filterStrictness }
} as const)

export const setWebsiteList = (websites: string[]) => ({
  type: SET_WEBSITE_LIST,
  payload: { websites }
} as const)

export const setDynamicMediaSettings = (
  dynamicMediaSettings: {
    dynamicSampleRatio?: number
    dynamicPositiveRatio?: number
    dynamicMinSamples?: number
    dynamicMaxSamples?: number
    dynamicMaxConcurrentGlobal?: number
    dynamicMaxConcurrentPerTab?: number
    dynamicQueueLimitPerTab?: number
  }
) => ({
  type: SET_DYNAMIC_MEDIA_SETTINGS,
  payload: dynamicMediaSettings
} as const)

export const setInterImageAwareness = (
  interImageAwareness: {
    interImageAwarenessEnabled?: boolean
    interImageAwarenessMinCount?: number
    interImageAwarenessMinRatio?: number
  }
) => ({
  type: SET_INTER_IMAGE_AWARENESS,
  payload: interImageAwareness
} as const)

export const setBackgroundScanMode = (backgroundScanMode: BackgroundScanMode) => ({
  type: SET_BACKGROUND_SCAN_MODE,
  payload: { backgroundScanMode }
} as const)

export const setAutoDlFrames = (
  autoDlFrames: {
    autoDlFramesEnabled?: boolean
    autoDlSignatureThreshold?: number
    autoDlMaxPairsPerVideo?: number
    autoDlMaxPairsPerSession?: number
  }
) => ({
  type: SET_AUTO_DL_FRAMES,
  payload: autoDlFrames
} as const)

export const setTextFilter = (
  textFilter: {
    textFilterEnabled?: boolean
    textFilterWords?: string[]
    textFilterPatterns?: string[]
    textFilterCaseSensitive?: boolean
  }
) => ({
  type: SET_TEXT_FILTER,
  payload: textFilter
} as const)
