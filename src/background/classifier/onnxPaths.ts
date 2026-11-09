/** Packaged ONNX model + ORT Web asset locations (under extension root). */

export const ONNX_MODEL_DIR = 'models/onnx/'
export const ONNX_CONFIG_FILE = 'config.json'
export const ONNX_ORT_WASM_DIR = 'models/onnx/ort/'

export const getOnnxModelDirUrl = (): string =>
  chrome.runtime.getURL(ONNX_MODEL_DIR)

export const getOnnxConfigUrl = (): string =>
  chrome.runtime.getURL(`${ONNX_MODEL_DIR}${ONNX_CONFIG_FILE}`)

export const getOnnxModelUrl = (modelFile: string): string =>
  chrome.runtime.getURL(`${ONNX_MODEL_DIR}${modelFile}`)

export const getOrtWasmPaths = (): string =>
  chrome.runtime.getURL(ONNX_ORT_WASM_DIR)
