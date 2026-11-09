import { createStore } from 'redux'

import { createChromeStore } from '../popup/redux/chrome-storage'
import { rootReducer } from '../popup/redux/reducers'
import { SettingsState } from '../popup/redux/reducers/settings'
import { ILogger, Logger } from '../utils/Logger'
import {
  CONTEXT_TARGET,
  ContextTargetMessage,
  AutoDlFile,
  PredictionResponse,
  UNHIDE_IMAGE
} from '../utils/messages'

import { isAutoDlFramePairMessage, saveAutoDlFramePair } from './autoDlDownloads'
import { ClassifierSettings } from './classifier/MediaClassifier'
import { DynamicMediaScheduler, DynamicMediaSchedulerSettings } from './media/DynamicMediaScheduler'
import { OffscreenModel } from './OffscreenModel'
import { ensureOffscreenDocument, OFFSCREEN_DOCUMENT_PATH } from './offscreenLifecycle'
import { DEFAULT_TAB_ID } from './Queue/QueueBase'
import { QueueWrapper as Queue } from './Queue/QueueWrapper'
import { buildTabIdUrl } from './tabUtils'
import { IReduxedStorage } from './types'

type Runtime = {
  logger: ILogger
  store: IReduxedStorage
  model: OffscreenModel
  queue: Queue
  dynamicMediaScheduler: DynamicMediaScheduler
}

type IncomingMessage = {
  target?: string
  type?: string
  url?: unknown
  mediaType?: 'image' | 'video' | 'gif'
  filtered?: boolean
}

// @types/chrome is older than MV3 action / contextMenus promise APIs.
type ActionApi = {
  setBadgeText: (details: { text: string }) => Promise<void> | void
  setBadgeBackgroundColor: (details: { color: string }) => Promise<void> | void
}
type ContextMenusApi = {
  removeAll: (callback?: () => void) => void
  create: (createProperties: Record<string, unknown>) => void
  update: (id: string, updateProperties: Record<string, unknown>) => Promise<void> | void
  onClicked: {
    addListener: (callback: (info: { menuItemId: string | number, frameId?: number }, tab?: chrome.tabs.Tab) => void) => void
  }
}

// "downloads" is an optional permission: chrome.downloads is undefined until
// the user grants it by turning on frame auto-download in the popup.
type DownloadsApi = {
  download: (
    options: { url: string, filename: string, saveAs: boolean, conflictAction: 'uniquify' },
    callback: (downloadId?: number) => void
  ) => void
}

const actionApi = (chrome as unknown as { action: ActionApi }).action
const contextMenusApi = (chrome as unknown as { contextMenus: ContextMenusApi }).contextMenus
const getDownloadsApi = (): DownloadsApi | undefined => (chrome as unknown as { downloads?: DownloadsApi }).downloads

const UNHIDE_MENU_ID = 'nsfw-filter-unhide'

const buildClassifierSettings = (settings: SettingsState): ClassifierSettings => ({
  filterStrictness: settings.filterStrictness,
  logging: settings.logging,
  classifierBackend: settings.classifierBackend,
  dynamicSampleRatio: settings.dynamicSampleRatio,
  dynamicPositiveRatio: settings.dynamicPositiveRatio,
  dynamicMinSamples: settings.dynamicMinSamples,
  dynamicMaxSamples: settings.dynamicMaxSamples,
  dynamicMaxSampleDurationSeconds: 45,
  autoDlFramesEnabled: settings.autoDlFramesEnabled,
  autoDlSignatureThreshold: settings.autoDlSignatureThreshold,
  autoDlMaxPairsPerVideo: settings.autoDlMaxPairsPerVideo,
  autoDlMaxPairsPerSession: settings.autoDlMaxPairsPerSession
})

const getDynamicSettings = (settings: SettingsState): Partial<DynamicMediaSchedulerSettings> => ({
  sampleRatio: settings.dynamicSampleRatio,
  positiveRatio: settings.dynamicPositiveRatio,
  minSamples: settings.dynamicMinSamples,
  maxSamples: settings.dynamicMaxSamples,
  maxConcurrentGlobal: settings.dynamicMaxConcurrentGlobal,
  maxConcurrentPerTab: settings.dynamicMaxConcurrentPerTab,
  queueLimitPerTab: settings.dynamicQueueLimitPerTab
})

const refreshActionBadge = (enabled: boolean): void => {
  try {
    Promise.resolve(actionApi.setBadgeText({ text: enabled ? '' : 'OFF' })).catch(() => undefined)
    Promise.resolve(actionApi.setBadgeBackgroundColor({ color: '#71717f' })).catch(() => undefined)
  } catch {
    // Older runtimes without action API.
  }
}

const downloadFile = (api: DownloadsApi) => async (file: AutoDlFile): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    api.download({ url: file.dataUrl, filename: file.filename, saveAs: false, conflictAction: 'uniquify' }, (downloadId) => {
      const lastError = chrome.runtime.lastError
      if (lastError !== undefined && lastError !== null) reject(new Error(lastError.message ?? 'Download failed'))
      else if (downloadId === undefined) reject(new Error('Download did not start'))
      else resolve()
    })
  })
}

const createUnhideMenu = (): void => {
  contextMenusApi.removeAll(() => {
    contextMenusApi.create({
      id: UNHIDE_MENU_ID,
      title: 'Unhide this image (NSFW Filter)',
      contexts: ['image'],
      visible: false
    })
  })
}

let runtimePromise: Promise<Runtime> | null = null

const initRuntime = async (): Promise<Runtime> => {
  await ensureOffscreenDocument()

  const store = await createChromeStore({ createStore })(rootReducer) as IReduxedStorage
  const settings = store.getState().settings
  refreshActionBadge(settings.enabled)

  const logger = new Logger()
  if (settings.logging === true) logger.enable()

  const model = new OffscreenModel()
  model.setSettings(buildClassifierSettings(settings))

  const queue = new Queue(model, logger, store)
  const dynamicMediaScheduler = new DynamicMediaScheduler(model, logger, getDynamicSettings(settings))

  let lastClassifierKey = JSON.stringify(buildClassifierSettings(settings))
  let badgeEnabled = settings.enabled
  store.subscribe(() => {
    const next = store.getState().settings
    if (next.enabled !== badgeEnabled) {
      badgeEnabled = next.enabled
      refreshActionBadge(next.enabled)
    }

    const classifierSettings = buildClassifierSettings(next)
    const classifierKey = JSON.stringify(classifierSettings)
    if (classifierKey !== lastClassifierKey) {
      lastClassifierKey = classifierKey
      model.setSettings(classifierSettings)
      dynamicMediaScheduler.setSettings(getDynamicSettings(next))
      queue.clearCache()
      dynamicMediaScheduler.clearCache()
    }
  })

  try {
    const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({}, resolve))
    for (const tab of tabs) queue.addTabIdUrl(buildTabIdUrl(tab))
  } catch (error) {
    logger.error(error as Error)
  }

  return { logger, store, model, queue, dynamicMediaScheduler }
}

const getRuntime = async (): Promise<Runtime> => {
  if (runtimePromise === null) runtimePromise = initRuntime()

  try {
    return await runtimePromise
  } catch (error) {
    runtimePromise = null
    throw error
  }
}

const applySettingsFromStore = (runtime: Runtime): void => {
  const settings = runtime.store.getState().settings

  refreshActionBadge(settings.enabled)
  if (settings.logging) runtime.logger.enable()
  else runtime.logger.disable()
  runtime.model.setSettings(buildClassifierSettings(settings))
  runtime.dynamicMediaScheduler.setSettings(getDynamicSettings(settings))
  runtime.queue.clearCache()
  runtime.dynamicMediaScheduler.clearCache()
}

chrome.runtime.onMessage.addListener((message: ContextTargetMessage) => {
  if (message?.type !== CONTEXT_TARGET) return
  Promise.resolve(contextMenusApi.update(UNHIDE_MENU_ID, { visible: message.filtered === true })).catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isAutoDlFramePairMessage(message)) return

  getRuntime()
    .then(async ({ store, logger }) => {
      const downloads = getDownloadsApi()
      await saveAutoDlFramePair(message, sender.url, {
        offscreenUrl: chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
        isEnabled: async () => store.getState().settings.autoDlFramesEnabled,
        download: downloads === undefined ? undefined : downloadFile(downloads),
        log: text => logger.log(text)
      })
    })
    .catch(() => undefined)
})

contextMenusApi.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== UNHIDE_MENU_ID || tab?.id === undefined) return
  chrome.tabs.sendMessage(tab.id, { type: UNHIDE_IMAGE }, { frameId: info.frameId }, () => {
    if (chrome.runtime.lastError !== undefined) { /* handled */ }
  })
})

chrome.runtime.onMessage.addListener((request: IncomingMessage, sender, sendResponse: (value: PredictionResponse) => void) => {
  if (request?.target === 'offscreen') return
  if (request?.target === 'background') return
  if (request?.type === 'SIGN_CONNECT') return
  if (request?.type === CONTEXT_TARGET) return
  if (typeof request?.url !== 'string') return

  const { url } = request
  const mediaType = request.mediaType ?? 'image'

  getRuntime()
    .then(({ store, queue, dynamicMediaScheduler }) => {
      if (store.getState().settings.enabled !== true) {
        sendResponse(new PredictionResponse(false, url, undefined, mediaType))
        return
      }

      const tabIdUrl = buildTabIdUrl(sender.tab)
      queue.addTabIdUrl(tabIdUrl)

      const predictionPromise = (mediaType === 'video' || mediaType === 'gif')
        ? dynamicMediaScheduler.predict(url, tabIdUrl, mediaType)
        : queue.predict(url, tabIdUrl)

      predictionPromise
        .then(result => sendResponse(PredictionResponse.fromClassification(result, url, mediaType)))
        .catch(err => sendResponse(new PredictionResponse(false, url, err.message, mediaType)))
    })
    .catch(err => sendResponse(new PredictionResponse(false, url, err?.message, mediaType)))

  return true
})

chrome.tabs.onCreated.addListener((tab) => {
  getRuntime().then(({ queue }) => queue.addTabIdUrl(buildTabIdUrl(tab))).catch(() => undefined)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  getRuntime().then(({ queue, dynamicMediaScheduler }) => {
    queue.clearByTabId(tabId)
    dynamicMediaScheduler.clearByTabId(tabId)
  }).catch(() => undefined)
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return

  getRuntime().then(({ queue, dynamicMediaScheduler }) => {
    dynamicMediaScheduler.clearByTabId(tab.id ?? DEFAULT_TAB_ID)
    queue.updateTabIdUrl(buildTabIdUrl(tab))
  }).catch(() => undefined)
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  getRuntime().then(({ queue }) => queue.setActiveTabId(activeInfo.tabId)).catch(() => undefined)
})

chrome.runtime.onConnect.addListener(port => port.onDisconnect.addListener(() => {
  getRuntime()
    .then(applySettingsFromStore)
    .catch(() => undefined)
}))

chrome.runtime.onInstalled.addListener(() => { getRuntime().catch(() => undefined) })
chrome.runtime.onStartup.addListener(() => { getRuntime().catch(() => undefined) })
createUnhideMenu()
getRuntime().catch(() => undefined)
