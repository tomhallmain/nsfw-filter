# ONNX classifier model assets

Place your PyTorch-exported ONNX model files in this directory.

## Expected layout

```
dist/models/onnx/
  config.json             # architecture, input size, class schema
  resnet34_model.onnx     # default filename (override with config.modelFile)
  model.onnx.data         # optional external weights (large models only)
  ort/                    # ORT WASM binaries (copied by npm run build)
```

```bash
cp model/resnet34_model.onnx dist/models/onnx/model.onnx
```

## `config.json`

### Preprocess / model file

| Field | Purpose | Example |
|-------|---------|---------|
| `architecture` | Log label | `"resnet34"` |
| `inputSize` | Square resize (px) | `320` |
| `modelFile` | Filename in this folder | `"resnet34_model.onnx"` |
| `layout` | `NCHW` or `NHWC` | `"NCHW"` |
| `normalize.mean` / `std` | After `/255` | ImageNet defaults |
| `inputName` / `outputName` | Empty = session defaults | `""` |

### Class schema and ordering

**Order is configurable and required:** the `classes` array is index-aligned with the model output.

| Array index | Model logit | Notes |
|-------------|-------------|--------|
| `classes[0]` | output dim 0 | First class in training label order |
| `classes[i]` | output dim i | Must match export / `argmax` order |

If labels were sorted alphabetically when training (as with this ResNet34), list them in that same alphabetical order—not “SFW first.”

Mark **SFW** with `"sfw": true`; every other class is **positive** (counts toward blocking):

```
positiveScore = sum(probability[i] for classes where sfw === false)
block if positiveScore >= threshold(filterStrictness)
```

When blocked and the filter effect is **blur** or **grayscale**, the UI draws a colored outline using the **highest-probability positive class**’s `borderColor`. Hide mode does not show a border.

Default for this project (alphabetical, 2 SFW: `drawings`, `neutral`):

```json
"classes": [
  { "name": "class_1", "sfw": false, "borderColor": "#dc2626", "shade": "red" },
  { "name": "class_2", "sfw": false, "borderColor": "#57534e", "shade": "stone" },
  { "name": "drawings", "sfw": true },
  { "name": "class_3", "sfw": false, "borderColor": "#ca8a04", "shade": "yellow" },
  { "name": "class_4", "sfw": false, "borderColor": "#16a34a", "shade": "green" },
  { "name": "class_5", "sfw": false, "borderColor": "#000000", "shade": "black" },
  { "name": "neutral", "sfw": true },
  { "name": "class_6", "sfw": false, "borderColor": "#7c3aed", "shade": "violet" },
  { "name": "class_7", "sfw": false, "borderColor": "#db2777", "shade": "pink" },
  { "name": "class_8", "sfw": false, "borderColor": "#2563eb", "shade": "blue" },
  { "name": "class_9", "sfw": false, "borderColor": "#ea580c", "shade": "orange" }
]
```

Reorder or rename entries freely; only the **position** must stay tied to the model. Omit `borderColor` on a positive class to auto-assign a palette color. `shade` is documentation-only (JSON has no comments) and is ignored at runtime.

### Small-image sensitivity (optional, per class)

Some classes fire too easily on tiny thumbnails. Opt in per positive class:

```json
{ "name": "class_4", "sfw": false, "borderColor": "#16a34a", "shade": "green",
  "smallMaxSide": 96, "smallWeight": 0.35 }
```

| Field | Meaning |
|-------|---------|
| `smallMaxSide` | When `max(width, height)` of the source media is **≤** this (px), apply the weight |
| `smallWeight` | Multiply that class’s probability by this (0–1) before the block score |

Example: `smallWeight: 0.35` means the class contributes only 35% of its usual score on images whose longer side is at most 96px. Larger media is unchanged. Omit both fields to keep full sensitivity at every size for that one class.

### Small-image sensitivity (default, all positive classes)

Top-level `smallImageDefaultMaxSide` / `smallImageDefaultWeight` set the same
kind of penalty as above, but as the fallback for every positive class that
doesn't set its own `smallMaxSide`/`smallWeight` — so a class nobody has
tuned individually still needs higher raw confidence on a small image to
cross the block threshold, instead of getting full weight at every size.
Shipped default: `smallImageDefaultMaxSide: 120`, `smallImageDefaultWeight: 0.35`.
A class-level override always wins over the default for that class. Set
either top-level field to `null`/omit both to turn the default off entirely
and go back to per-class-only behavior.

### Legacy alternatives (still accepted)

```json
{
  "numClasses": 11,
  "classLabels": [
    "class_1", "class_2", "drawings", "class_3", "class_4", "class_5",
    "neutral", "class_6", "class_7", "class_8", "class_9"
  ],
  "sfwClassIndices": [2, 6]
}
```

Or list only positive indices: `"nsfwClassIndices": [0, 1, 3, 4, 5, 7, 8, 9, 10]`.

## Do you need sharding?

**No for a ~160KB file.** Use a single `model.onnx`. External data is only for large weight files.

A full ResNet34 is often ~80MB; if your file is tiny, verify weights are embedded (Netron / successful `InferenceSession.create` with input `[1, 3, 320, 320]`).

## Performance notes

The NSFWJS (TF.js) path is also **single-thread WASM** in this extension (MV3 limits workers). ONNX feels slower mainly because:

- ResNet34 ≫ MobileNet
- 320² inputs ≈ **2×** the pixels of 224²

Runtime optimizations already applied:

- Reuse preprocess canvas / float buffer
- Warm-up inference on session start
- Use multiple WASM threads only if `SharedArrayBuffer` is available (uncommon in extensions)
- WASM execution provider only (`ort.wasm.min.js`; WebGPU would need `ort.webgpu.min.js` and is not wired yet)

Larger wins require a smaller/faster model export (e.g. INT8 quantization, MobileNet-class backbone, or a 224 input if accuracy allows).

## Extension settings

Popup → **Classifier** → **ONNX**. Reload open tabs after switching.
