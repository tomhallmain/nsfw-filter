import { DEFAULT_TAB_ID, TabIdUrl } from './Queue/QueueBase'

export const buildTabIdUrl = (tab: chrome.tabs.Tab | undefined): TabIdUrl => ({
  tabId: tab?.id ?? DEFAULT_TAB_ID,
  tabUrl: tab?.url ?? `${DEFAULT_TAB_ID}`
})
