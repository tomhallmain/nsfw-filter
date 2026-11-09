import { ILogger } from '../../utils/Logger'
import { DEFAULT_CLASSIFIER_BACKEND, isClassifierBackend } from '../../utils/models'

import { AutoDlSession } from './autoDlFrames'
import { ClassifierBackend, ClassifierSettings, MediaClassifier } from './MediaClassifier'
import { NsfwjsMediaClassifier, VIT_MODEL_SPEC } from './NsfwjsMediaClassifier'
import { OnnxMediaClassifier } from './OnnxMediaClassifier'

export const createClassifier = (
  backend: ClassifierBackend,
  logger: ILogger,
  settings: ClassifierSettings,
  autoDl: AutoDlSession | null = null
): MediaClassifier => {
  if (backend === 'onnx') {
    return new OnnxMediaClassifier(logger, settings, autoDl)
  }
  if (backend === 'vit') {
    return new NsfwjsMediaClassifier(logger, settings, autoDl, VIT_MODEL_SPEC)
  }
  return new NsfwjsMediaClassifier(logger, settings, autoDl)
}

export const resolveBackend = (settings: ClassifierSettings): ClassifierBackend =>
  isClassifierBackend(settings.classifierBackend) ? settings.classifierBackend : DEFAULT_CLASSIFIER_BACKEND
