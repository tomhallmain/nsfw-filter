import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import {
  mergeOnnxModelConfig,
  positiveScoreFromClassScores,
  scoresFromLogits
} from '../../src/background/classifier/onnxModelConfig'

const onnxDir = path.join(__dirname, '../../dist/models/onnx')
const configPath = path.join(onnxDir, 'config.json')
const smokeScript = path.join(__dirname, '../../scripts/smoke-onnx.cjs')

type SmokePayload = {
  ok: boolean
  error?: string
  inputName?: string
  outputName?: string
  outputDims?: number[]
  logitCount?: number
  logits?: number[]
}

// Runs the model out of process (ORT's tensor checks break inside Jest's VM).
// The script prints its JSON payload on failure too, with a non-zero exit.
const runSmoke = (): SmokePayload => {
  try {
    return JSON.parse(execFileSync(process.execPath, [smokeScript], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }))
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    try {
      return JSON.parse(stdout)
    } catch {
      return { ok: false, error: String((error as Error).message ?? error) }
    }
  }
}

describe('background => onnx model package', () => {
  const configJson = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const config = mergeOnnxModelConfig(configJson)
  const modelPath = path.join(onnxDir, config.modelFile)
  const modelExists = fs.existsSync(modelPath)
  const smoke = modelExists ? runSmoke() : null

  // The model weights are not committed; these run only where they are installed.
  const runIfModel = modelExists ? test : test.skip
  // The schema below describes one specific model, so it is only checked
  // against a model that loads and has one output per configured class.
  const matchesConfig = smoke?.ok === true && smoke.outputDims?.[1] === config.classes.length
  const runIfMatchingModel = matchesConfig ? test : test.skip

  runIfModel('model file is non-trivial', () => {
    const size = fs.statSync(modelPath).size
    // Guard against an empty/stub export.
    expect(size).toBeGreaterThan(1_000_000)
  })

  runIfModel('loads with onnxruntime-node and has one output per configured class', () => {
    expect(smoke?.error).toBeUndefined()
    expect(smoke?.ok).toBe(true)
    expect(smoke?.outputDims).toEqual([1, config.classes.length])
  })

  runIfMatchingModel('config describes 11-class alphabetical schema with drawings and neutral as SFW', () => {
    expect(config.inputSize).toBe(320)
    expect(config.architecture).toBe('resnet34')
    expect(config.modelFile).toBe('resnet34_model.onnx')
    expect(config.classes).toHaveLength(11)
    expect(config.classes[2]).toEqual({ name: 'drawings', sfw: true })
    expect(config.classes[6]).toEqual({ name: 'neutral', sfw: true })
    expect(config.classes.filter(c => c.sfw).map(c => c.name)).toEqual(['drawings', 'neutral'])
    expect(config.classes.filter(c => !c.sfw)).toHaveLength(9)
  })

  runIfMatchingModel('a 320² zero tensor yields a normalized class distribution', () => {
    const payload = smoke as Required<SmokePayload>
    expect(payload.inputName).toBe('input')
    expect(payload.outputName).toBe('output')
    expect(payload.logitCount).toBeGreaterThanOrEqual(config.classes.length)

    const classScores = scoresFromLogits(payload.logits, config)
    expect(classScores).toHaveLength(config.classes.length)
    const positive = positiveScoreFromClassScores(classScores)
    expect(positive).toBeGreaterThanOrEqual(0)
    expect(positive).toBeLessThanOrEqual(1)

    const probSum = classScores.reduce((sum, c) => sum + c.probability, 0)
    expect(probSum).toBeCloseTo(1, 5)
  })
})
