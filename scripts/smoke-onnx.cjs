/**
 * Loads the model named in dist/models/onnx/config.json and runs one zero tensor.
 * Invoked from unit tests via child_process (Jest's VM breaks Float32Array checks in ORT).
 */
const fs = require('fs')
const path = require('path')
const ort = require('onnxruntime-node')

const onnxDir = path.join(__dirname, '../dist/models/onnx')
const config = JSON.parse(fs.readFileSync(path.join(onnxDir, 'config.json'), 'utf8'))
const modelPath = path.join(onnxDir, config.modelFile || 'resnet34_model.onnx')
const size = config.inputSize || 320
const numClasses = Array.isArray(config.classes) ? config.classes.length : 11

;(async () => {
  const session = await ort.InferenceSession.create(modelPath)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  const data = new Float32Array(1 * 3 * size * size)
  const tensor = new ort.Tensor('float32', data, [1, 3, size, size])
  const results = await session.run({ [inputName]: tensor })
  const output = results[outputName]
  const logits = Array.from(output.data).map(Number)

  const payload = {
    ok: true,
    inputName,
    outputName,
    outputDims: output.dims,
    logitCount: logits.length,
    expectedClasses: numClasses,
    logits: logits.slice(0, numClasses)
  }
  process.stdout.write(JSON.stringify(payload))
})().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
  process.exitCode = 1
})
