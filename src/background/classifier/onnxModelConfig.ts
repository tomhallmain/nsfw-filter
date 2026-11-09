/**
 * Runtime config for the packaged ONNX model (loaded from models/onnx/config.json).
 * Override any field in that file without rebuilding classifier code.
 */

export type OnnxNormalizeConfig = {
  /** Per-channel mean applied after scaling pixels to [0, 1]. */
  mean: [number, number, number]
  /** Per-channel std applied after mean subtraction. */
  std: [number, number, number]
}

/**
 * One output class. Order must match the model’s logit / softmax axis.
 * `sfw: true` means the class is treated as safe for the default block decision;
 * all other classes contribute to the positive (NSFW) score.
 * `borderColor` is used when that NSFW class is the top positive prediction
 * and the filter effect is blur/grayscale.
 * `shade` is documentation-only (JSON has no comments); ignored at runtime.
 * `smallMaxSide` + `smallWeight`: when max(media width, height) <= smallMaxSide,
 * that class’s probability is multiplied by smallWeight (0–1) before scoring.
 */
export type OnnxClassDefinition = {
  name: string
  sfw: boolean
  borderColor?: string
  shade?: string
  /** Longer side (px) at or below which `smallWeight` applies. */
  smallMaxSide?: number
  /** Multiplier for this class’s contribution on small media (0 = ignore, 1 = full). */
  smallWeight?: number
}

export type OnnxClassScore = {
  index: number
  name: string
  sfw: boolean
  probability: number
  borderColor?: string
}

/** Default palette for positive classes (cycled if more classes than colors). */
export const DEFAULT_NSFW_BORDER_COLORS = [
  '#dc2626', // red
  '#57534e', // stone
  '#ca8a04', // yellow
  '#16a34a', // green
  '#000000', // black
  '#7c3aed', // violet
  '#db2777', // pink
  '#2563eb', // blue
  '#ea580c' // orange
]

export type OnnxModelConfig = {
  /** Free-form label for logs (e.g. "resnet34"). */
  architecture: string
  /** Square resize target in pixels. */
  inputSize: number
  /**
   * Ordered class list (length = model output width).
   * Prefer this over legacy numClasses / nsfwClassIndex.
   */
  classes: OnnxClassDefinition[]
  /** ONNX input tensor name; empty = use session.inputNames[0]. */
  inputName: string
  /** ONNX output tensor name; empty = use session.outputNames[0]. */
  outputName: string
  /** Model filename under models/onnx/. */
  modelFile: string
  layout: 'NCHW' | 'NHWC'
  normalize: OnnxNormalizeConfig
  /**
   * Fallback small-image weighting for positive classes that don't set their
   * own `smallMaxSide`/`smallWeight`. Without this, a class with no per-class
   * override gets full weight at every size, so a small/low-quality image
   * only needs to clear the normal block threshold, not a higher one. Set
   * either to `undefined` to leave unconfigured classes at full weight (the
   * pre-existing per-class-only behavior).
   */
  smallImageDefaultMaxSide?: number
  smallImageDefaultWeight?: number
}

/** Legacy fields still accepted in config.json and normalized into `classes`. */
type OnnxModelConfigFile = Partial<OnnxModelConfig> & {
  numClasses?: number
  nsfwClassIndex?: number
  /** Explicit positive (NSFW) indices; alternative to per-class `sfw` flags. */
  nsfwClassIndices?: number[]
  /** Explicit SFW indices; all other classes are positive. */
  sfwClassIndices?: number[]
  classLabels?: string[]
}

/**
 * Default 11-class schema in model output order (alphabetical training labels).
 * Index in this array = logit index. Only `drawings` and `neutral` are SFW.
 */
export const DEFAULT_ONNX_CLASSES: OnnxClassDefinition[] = [
  { name: 'class_1', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[0] },
  { name: 'class_2', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[1] },
  { name: 'drawings', sfw: true },
  { name: 'class_3', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[2] },
  { name: 'class_4', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[3] },
  { name: 'class_5', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[4] },
  { name: 'neutral', sfw: true },
  { name: 'class_6', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[5] },
  { name: 'class_7', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[6] },
  { name: 'class_8', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[7] },
  { name: 'class_9', sfw: false, borderColor: DEFAULT_NSFW_BORDER_COLORS[8] }
]

export const DEFAULT_ONNX_MODEL_CONFIG: OnnxModelConfig = {
  architecture: 'resnet34',
  inputSize: 320,
  classes: DEFAULT_ONNX_CLASSES,
  inputName: 'input',
  outputName: 'output',
  modelFile: 'resnet34_model.onnx',
  layout: 'NCHW',
  normalize: {
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225]
  }
  // No smallImageDefault* here: this fallback config is used when no
  // config.json is reachable at all, and stays minimal like the rest of it.
  // The shipped dist/models/onnx/config.json opts in explicitly instead.
}

const buildClassesFromLegacy = (file: OnnxModelConfigFile): OnnxClassDefinition[] | null => {
  const labels = file.classLabels
  const numClasses = file.numClasses ?? labels?.length
  if (numClasses === undefined || numClasses <= 0) return null

  const sfwSet = new Set<number>()
  if (Array.isArray(file.sfwClassIndices)) {
    for (const i of file.sfwClassIndices) sfwSet.add(i)
  } else if (Array.isArray(file.nsfwClassIndices)) {
    for (let i = 0; i < numClasses; i++) {
      if (!file.nsfwClassIndices.includes(i)) sfwSet.add(i)
    }
  } else if (typeof file.nsfwClassIndex === 'number') {
    for (let i = 0; i < numClasses; i++) {
      if (i !== file.nsfwClassIndex) sfwSet.add(i)
    }
  } else {
    // Default: only index 0 is SFW when using bare numClasses.
    sfwSet.add(0)
  }

  const classes: OnnxClassDefinition[] = []
  let positivePaletteIndex = 0
  for (let i = 0; i < numClasses; i++) {
    const sfw = sfwSet.has(i)
    classes.push({
      name: labels?.[i] ?? `class_${i}`,
      sfw,
      borderColor: sfw
        ? undefined
        : DEFAULT_NSFW_BORDER_COLORS[positivePaletteIndex++ % DEFAULT_NSFW_BORDER_COLORS.length]
    })
  }
  return classes
}

export const mergeOnnxModelConfig = (partial: OnnxModelConfigFile | null | undefined): OnnxModelConfig => {
  const file = partial ?? {}
  let classes = file.classes

  if (!Array.isArray(classes) || classes.length === 0) {
    classes = buildClassesFromLegacy(file) ?? DEFAULT_ONNX_CLASSES
  }

  let positivePaletteIndex = 0
  classes = classes.map((entry, index) => {
    const sfw = entry?.sfw === true
    let borderColor = typeof entry?.borderColor === 'string' ? entry.borderColor : undefined
    if (!sfw && (borderColor === undefined || borderColor.length === 0)) {
      borderColor = DEFAULT_NSFW_BORDER_COLORS[positivePaletteIndex % DEFAULT_NSFW_BORDER_COLORS.length]
      positivePaletteIndex++
    }
    const cls: OnnxClassDefinition = {
      name: typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : `class_${index}`,
      sfw,
      borderColor: sfw ? undefined : borderColor
    }
    if (!sfw && typeof entry?.smallMaxSide === 'number' && entry.smallMaxSide > 0) {
      cls.smallMaxSide = entry.smallMaxSide
    }
    if (!sfw && typeof entry?.smallWeight === 'number' && Number.isFinite(entry.smallWeight)) {
      cls.smallWeight = Math.min(1, Math.max(0, entry.smallWeight))
    }
    if (typeof entry?.shade === 'string' && entry.shade.length > 0) {
      cls.shade = entry.shade
    }
    return cls
  })

  // Purely opt-in, like per-class smallMaxSide/smallWeight: a config that
  // doesn't set these leaves the blanket default off, not silently on.
  const smallImageDefaultMaxSide = typeof file.smallImageDefaultMaxSide === 'number' && Number.isFinite(file.smallImageDefaultMaxSide)
    ? file.smallImageDefaultMaxSide
    : undefined
  const smallImageDefaultWeight = typeof file.smallImageDefaultWeight === 'number' && Number.isFinite(file.smallImageDefaultWeight)
    ? Math.min(1, Math.max(0, file.smallImageDefaultWeight))
    : undefined

  return {
    architecture: file.architecture ?? DEFAULT_ONNX_MODEL_CONFIG.architecture,
    inputSize: file.inputSize ?? DEFAULT_ONNX_MODEL_CONFIG.inputSize,
    classes,
    inputName: file.inputName ?? DEFAULT_ONNX_MODEL_CONFIG.inputName,
    outputName: file.outputName ?? DEFAULT_ONNX_MODEL_CONFIG.outputName,
    modelFile: file.modelFile ?? DEFAULT_ONNX_MODEL_CONFIG.modelFile,
    layout: file.layout === 'NHWC' ? 'NHWC' : 'NCHW',
    normalize: {
      ...DEFAULT_ONNX_MODEL_CONFIG.normalize,
      ...(file.normalize ?? {})
    },
    smallImageDefaultMaxSide,
    smallImageDefaultWeight
  }
}

export const getPositiveClassIndices = (config: OnnxModelConfig): number[] => {
  const indices: number[] = []
  for (let i = 0; i < config.classes.length; i++) {
    if (!config.classes[i].sfw) indices.push(i)
  }
  return indices
}

export const getSfwClassIndices = (config: OnnxModelConfig): number[] => {
  const indices: number[] = []
  for (let i = 0; i < config.classes.length; i++) {
    if (config.classes[i].sfw) indices.push(i)
  }
  return indices
}

/** Softmax probabilities aligned with `config.classes`. */
export const scoresFromLogits = (logits: number[], config: OnnxModelConfig): OnnxClassScore[] => {
  const n = config.classes.length
  const values = logits.slice(0, Math.max(n, logits.length))

  if (values.length === 1) {
    const v = values[0]
    const p = v > 1 || v < 0 ? 1 / (1 + Math.exp(-v)) : v
    const cls = config.classes[0] ?? { name: 'class_0', sfw: false }
    return [{ index: 0, name: cls.name, sfw: cls.sfw, probability: p, borderColor: cls.borderColor }]
  }

  const limited = values.slice(0, n)
  const max = Math.max(...limited)
  const exps = limited.map(v => Math.exp(v - max))
  const sum = exps.reduce((a, b) => a + b, 0)

  return limited.map((unused, index) => {
    const cls = config.classes[index] ?? { name: `class_${index}`, sfw: false }
    return {
      index,
      name: cls.name,
      sfw: cls.sfw,
      probability: exps[index] / sum,
      borderColor: cls.borderColor
    }
  })
}

/** Highest-probability non-SFW class, if any. */
export const topPositiveClass = (scores: OnnxClassScore[]): OnnxClassScore | undefined => {
  let best: OnnxClassScore | undefined
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i]
    if (score.sfw) continue
    if (best === undefined || score.probability > best.probability) best = score
  }
  return best
}

/** Sum of probabilities over non-SFW classes (block score). */
export const positiveScoreFromClassScores = (scores: OnnxClassScore[]): number => {
  let positive = 0
  for (let i = 0; i < scores.length; i++) {
    if (!scores[i].sfw) positive += scores[i].probability
  }
  return positive
}

/**
 * Down-weight positive classes when the media’s longer side is small, so a
 * small/low-quality image needs higher raw confidence to still cross the
 * block threshold. A class’s own `smallMaxSide`/`smallWeight` wins when set;
 * otherwise `config.smallImageDefaultMaxSide`/`smallImageDefaultWeight`
 * applies, so classes nobody has tuned individually still get a baseline
 * small-image penalty instead of full weight at every size. Probabilities
 * are not renormalized — only the block contribution shrinks.
 */
export const applySmallImageWeights = (
  scores: OnnxClassScore[],
  mediaWidth: number,
  mediaHeight: number,
  config: OnnxModelConfig
): OnnxClassScore[] => {
  const maxSide = Math.max(mediaWidth, mediaHeight)
  if (!(maxSide > 0)) return scores

  let changed = false
  const adjusted = scores.map((score, index) => {
    const cls = config.classes[index]
    if (cls === undefined || cls.sfw) return score

    const smallMaxSide = cls.smallMaxSide ?? config.smallImageDefaultMaxSide
    const smallWeight = cls.smallWeight ?? config.smallImageDefaultWeight
    if (typeof smallMaxSide !== 'number' || typeof smallWeight !== 'number' || maxSide > smallMaxSide) {
      return score
    }

    changed = true
    return {
      ...score,
      probability: score.probability * smallWeight
    }
  })

  return changed ? adjusted : scores
}
