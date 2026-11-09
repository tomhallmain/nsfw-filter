// The classifiers the user can pick between in the popup. The id is what gets
// persisted in settings and sent to the offscreen document, so it must stay
// stable; renaming one silently resets that user's choice to the default.
//
// `nsfwjs` is the original 5-class MobileNet graph (the slider tunes per-class
// thresholds). `onnx` runs a user-supplied ONNX model from
// models/onnx/ and falls back to nsfwjs when that model is missing or fails.

export const CLASSIFIER_BACKENDS = ['nsfwjs', 'onnx'] as const

export type ClassifierBackend = typeof CLASSIFIER_BACKENDS[number]

export const DEFAULT_CLASSIFIER_BACKEND: ClassifierBackend = 'nsfwjs'

export const CLASSIFIER_BACKEND_LABELS: Record<ClassifierBackend, string> = {
  nsfwjs: 'MobileNet (NSFWJS)',
  onnx: 'Custom ONNX'
}

export const isClassifierBackend = (value: unknown): value is ClassifierBackend =>
  typeof value === 'string' && (CLASSIFIER_BACKENDS as readonly string[]).includes(value)
