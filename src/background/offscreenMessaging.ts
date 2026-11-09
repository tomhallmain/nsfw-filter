import { OffscreenRequest, withTimeout } from '../utils/messages'

/**
 * Transport to the offscreen document. Deliberately knows nothing about the
 * document's lifecycle so that `offscreenLifecycle` can use it for the health
 * check without recursing back into itself.
 */
export const sendToOffscreen = async <T>(request: OffscreenRequest, timeoutMs: number): Promise<T> => {
  const roundTrip = new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: T | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError !== null && lastError !== undefined) {
        reject(new Error(lastError.message ?? 'Offscreen document is unreachable'))
        return
      }

      if (response === undefined) {
        reject(new Error('No response from offscreen document'))
        return
      }

      resolve(response)
    })
  })

  return await withTimeout(roundTrip, timeoutMs, `Offscreen ${request.type}`)
}

/**
 * One-way push for requests the document does not answer. Chrome delivers
 * messages from one sender to one receiver in order, so a push landing before
 * a later `sendToOffscreen` call is applied before it.
 */
export const postToOffscreen = (request: OffscreenRequest): void => {
  chrome.runtime.sendMessage(request, () => {
    // Reading lastError marks the absent reply as handled.
    if (chrome.runtime.lastError !== undefined) { /* handled */ }
  })
}
