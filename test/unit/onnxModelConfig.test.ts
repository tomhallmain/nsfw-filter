import {
  applySmallImageWeights,
  mergeOnnxModelConfig,
  positiveScoreFromClassScores,
  scoresFromLogits
} from '../../src/background/classifier/onnxModelConfig'

describe('background => onnxModelConfig', () => {
  test('merges classes with alphabetical order and SFW at indices 2 and 6', () => {
    const config = mergeOnnxModelConfig({
      numClasses: 11,
      sfwClassIndices: [2, 6],
      classLabels: [
        'class_1', 'class_2', 'drawings', 'class_3', 'class_4', 'class_5',
        'neutral', 'class_6', 'class_7', 'class_8', 'class_9'
      ]
    })

    expect(config.classes).toHaveLength(11)
    expect(config.classes[2]).toEqual({ name: 'drawings', sfw: true })
    expect(config.classes[6]).toEqual({ name: 'neutral', sfw: true })
    expect(config.classes.filter(c => c.sfw).map(c => c.name)).toEqual(['drawings', 'neutral'])
    expect(config.classes.filter(c => !c.sfw)).toHaveLength(9)
  })

  test('positive score sums non-SFW probabilities', () => {
    const config = mergeOnnxModelConfig({
      classes: [
        { name: 'class_1', sfw: false },
        { name: 'drawings', sfw: true },
        { name: 'neutral', sfw: true },
        { name: 'class_9', sfw: false }
      ]
    })

    // Logits that softmax to ~equal mass on all four classes.
    const scores = scoresFromLogits([0, 0, 0, 0], config)
    const positive = positiveScoreFromClassScores(scores)
    expect(positive).toBeCloseTo(0.5, 5)
  })

  test('accepts explicit classes array in model output order', () => {
    const config = mergeOnnxModelConfig({
      inputSize: 320,
      classes: [
        { name: 'class_1', sfw: false },
        { name: 'drawings', sfw: true }
      ]
    })
    expect(config.inputSize).toBe(320)
    expect(config.classes[0].sfw).toBe(false)
    expect(config.classes[1].sfw).toBe(true)
  })

  test('preserves small-image weight settings on positive classes', () => {
    const config = mergeOnnxModelConfig({
      classes: [
        { name: 'class_1', sfw: false, smallMaxSide: 96, smallWeight: 0.35 },
        { name: 'drawings', sfw: true, smallMaxSide: 96, smallWeight: 0.1 }
      ]
    })
    expect(config.classes[0].smallMaxSide).toBe(96)
    expect(config.classes[0].smallWeight).toBe(0.35)
    expect(config.classes[1].smallMaxSide).toBeUndefined()
    expect(config.classes[1].smallWeight).toBeUndefined()
  })

  test('applySmallImageWeights downscales only matching classes on small media', () => {
    const config = mergeOnnxModelConfig({
      classes: [
        { name: 'class_1', sfw: false, smallMaxSide: 96, smallWeight: 0.5 },
        { name: 'class_2', sfw: false },
        { name: 'drawings', sfw: true }
      ]
    })
    const scores = [
      { index: 0, name: 'class_1', sfw: false, probability: 0.4 },
      { index: 1, name: 'class_2', sfw: false, probability: 0.3 },
      { index: 2, name: 'drawings', sfw: true, probability: 0.3 }
    ]

    const small = applySmallImageWeights(scores, 64, 48, config)
    expect(small[0].probability).toBeCloseTo(0.2, 5)
    expect(small[1].probability).toBeCloseTo(0.3, 5)
    expect(positiveScoreFromClassScores(small)).toBeCloseTo(0.5, 5)

    const large = applySmallImageWeights(scores, 200, 150, config)
    expect(large[0].probability).toBeCloseTo(0.4, 5)
    expect(positiveScoreFromClassScores(large)).toBeCloseTo(0.7, 5)
  })

  test('smallImageDefault* falls back for classes without their own override, off unless set', () => {
    const withoutDefault = mergeOnnxModelConfig({
      classes: [{ name: 'class_1', sfw: false }, { name: 'drawings', sfw: true }]
    })
    expect(withoutDefault.smallImageDefaultMaxSide).toBeUndefined()
    expect(withoutDefault.smallImageDefaultWeight).toBeUndefined()

    const withDefault = mergeOnnxModelConfig({
      smallImageDefaultMaxSide: 120,
      smallImageDefaultWeight: 0.35,
      classes: [{ name: 'class_1', sfw: false }, { name: 'drawings', sfw: true }]
    })
    expect(withDefault.smallImageDefaultMaxSide).toBe(120)
    expect(withDefault.smallImageDefaultWeight).toBe(0.35)
  })

  test('applySmallImageWeights: config-level default applies only to classes without their own override', () => {
    const config = mergeOnnxModelConfig({
      smallImageDefaultMaxSide: 120,
      smallImageDefaultWeight: 0.35,
      classes: [
        { name: 'class_1', sfw: false }, // no per-class override -> uses the default
        { name: 'class_2', sfw: false, smallMaxSide: 96, smallWeight: 0.5 }, // own override wins
        { name: 'drawings', sfw: true }
      ]
    })
    const scores = [
      { index: 0, name: 'class_1', sfw: false, probability: 0.4 },
      { index: 1, name: 'class_2', sfw: false, probability: 0.4 },
      { index: 2, name: 'drawings', sfw: true, probability: 0.2 }
    ]

    const small = applySmallImageWeights(scores, 64, 48, config)
    expect(small[0].probability).toBeCloseTo(0.14, 5) // 0.4 * 0.35 (blanket default)
    expect(small[1].probability).toBeCloseTo(0.2, 5) // 0.4 * 0.5 (own override, not 0.35)

    const large = applySmallImageWeights(scores, 200, 150, config)
    expect(large[0].probability).toBeCloseTo(0.4, 5) // above smallImageDefaultMaxSide -> unchanged
  })

})
