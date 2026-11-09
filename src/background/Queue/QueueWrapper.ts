import { ClassificationResult } from '../classifier/ClassificationResult'

import { PredictionQueue } from './PredictionQueue'
import { TabIdUrl } from './QueueBase'

type IQueueWrapper = {
  predict: (url: string, tabId: TabIdUrl) => Promise<ClassificationResult>
  clearByTabId: (tabId: number) => void
  addTabIdUrl: (tabIdUrl: TabIdUrl) => void
  updateTabIdUrl: (tabIdUrl: TabIdUrl) => void
  setActiveTabId: (tabId: number) => void
}

export class QueueWrapper extends PredictionQueue implements IQueueWrapper {
  public async predict (url: string, tabIdUrl: TabIdUrl): Promise<ClassificationResult> {
    return await new Promise((resolve, reject) => {
      if (this.cache.has(url)) {
        resolve(this.cache.get(url) as ClassificationResult)
        return
      }

      if (this.requestMap.has(url)) {
        this.requestMap.get(url)?.push([{ resolve, reject }])
      } else {
        this.requestMap.set(url, [[{ resolve, reject }]])
        this.predictionQueue.add({ url, tabIdUrl })
      }
    })
  }

  public addTabIdUrl (tabIdUrl: TabIdUrl): void {
    const { tabId, tabUrl } = tabIdUrl
    this.currentTabIdUrls.set(tabId, tabUrl)
  }

  public updateTabIdUrl (tabIdUrl: TabIdUrl): void {
    const { tabId, tabUrl } = tabIdUrl
    this.currentTabIdUrls.set(tabId, tabUrl)
  }

  public clearByTabId (tabId: number): void {
    if (this.currentTabIdUrls.has(tabId)) {
      this.currentTabIdUrls.delete(tabId)
    }
  }

  public setActiveTabId (tabId: number): void {
    this.activeTabId = tabId
  }
}
