/** Pure sampling helpers shared by offscreen classifiers (TF / future ONNX). */

/**
 * The parts of WebCodecs' ImageDecoder that GIF sampling uses. Declared here
 * because the DOM lib this project builds against has no type for it.
 */
export type GifTracks = {
  ready?: Promise<unknown>
  selectedTrack?: { frameCount?: number }
  length?: number
  [index: number]: { frameCount?: number } | undefined
}

export type GifDecoder = {
  tracks?: GifTracks
  decode: (options: { frameIndex: number }) => Promise<{ image: ImageBitmap }>
  close: () => void
}

export type SamplingConfig = {
  sampleRatio: number
  positiveRatio: number
  minSamples: number
  maxSamples: number
  maxSampleDurationSeconds: number
}

export const computeSampleCount = (totalItems: number, config: SamplingConfig): number => {
  let sampleCount = Math.max(1, Math.floor(totalItems * config.sampleRatio))
  sampleCount = Math.max(sampleCount, config.minSamples)
  sampleCount = Math.min(sampleCount, config.maxSamples)
  return Math.min(sampleCount, totalItems)
}

export const computeSampleIndices = (totalItems: number, config: SamplingConfig): number[] => {
  if (totalItems <= 0) return []

  const sampleCount = computeSampleCount(totalItems, config)
  const step = Math.max(1, Math.floor(totalItems / sampleCount))
  const indices: number[] = []

  for (let index = 0; index < totalItems && indices.length < sampleCount; index += step) {
    indices.push(index)
  }

  if (indices.length === 0) indices.push(0)
  return indices
}

export const computeSampleTimes = (durationSeconds: number, config: SamplingConfig): number[] => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0]

  const boundedDuration = Math.max(0.1, Math.min(durationSeconds, config.maxSampleDurationSeconds))
  const totalItems = Math.max(1, Math.floor(boundedDuration))
  const indices = computeSampleIndices(totalItems, config)

  return indices.map(index => {
    const percent = totalItems <= 1 ? 0 : index / totalItems
    const proposed = boundedDuration * percent
    return Math.min(Math.max(proposed, 0), Math.max(0, boundedDuration - 0.05))
  })
}

export const timeoutPromise = async <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    promise
      .then(result => {
        clearTimeout(timeoutId)
        resolve(result)
      })
      .catch(error => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}
