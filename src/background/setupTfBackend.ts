import { env, ready, setBackend } from '@tensorflow/tfjs-core'
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm'

export const setupTfBackend = async (): Promise<void> => {
  // MV3 blocks blob: workers used by the threaded-SIMD build. Force the
  // non-threaded path via the env flag (setWasmPath is deprecated).
  env().set('WASM_HAS_MULTITHREAD_SUPPORT', false)
  setThreadsCount(1)
  setWasmPaths(chrome.runtime.getURL('models/'))

  const ok = await setBackend('wasm')
  if (!ok) {
    throw new Error('Failed to initialize TensorFlow.js WASM backend')
  }
  await ready()
}

export const getModelPath = (): string => chrome.runtime.getURL('models/')
