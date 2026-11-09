/**
 * ONNX Runtime is loaded via <script src="ort.wasm.min.js"> in offscreen.html
 * (not webpack-bundled — ORT's min build uses syntax webpack 4 cannot parse).
 */
export type OrtTensor = {
  data: ArrayLike<number>
}

export type OrtInferenceSession = {
  inputNames: string[]
  outputNames: string[]
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>
}

export type OrtNamespace = {
  env: {
    wasm: {
      numThreads: number
      simd: boolean
      proxy?: boolean
      wasmPaths: string
    }
  }
  Tensor: new (type: string, data: Float32Array | number[], dims: number[]) => OrtTensor
  InferenceSession: {
    create: (
      path: string,
      options?: {
        executionProviders?: string[]
        graphOptimizationLevel?: string
        enableCpuMemArena?: boolean
        enableMemPattern?: boolean
      }
    ) => Promise<OrtInferenceSession>
  }
}

export const getOrt = (): OrtNamespace => {
  const ort = (globalThis as unknown as { ort?: OrtNamespace }).ort
  if (ort === undefined) {
    throw new Error('onnxruntime-web is not loaded (expected ort.wasm.min.js in offscreen.html)')
  }
  return ort
}
