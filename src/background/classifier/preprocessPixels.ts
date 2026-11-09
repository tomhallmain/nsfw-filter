/**
 * Pixel-level steps of classifier preprocessing that don't depend on the model.
 */

/**
 * Painted under every frame before it is drawn. The preprocessing canvas is
 * reused, so without an opaque fill a transparent pixel would show the previous
 * prediction's image; and a cleared pixel reads back as black, which the
 * classifier can score as NSFW. Mid-grey keeps the backdrop itself neutral.
 */
export const PREPROCESS_BACKDROP = 'rgb(128, 128, 128)'

/**
 * Luminance standard deviation (0-255 scale) below which a frame has no content
 * to classify. Set just above JPEG/WebP noise on a flat fill.
 */
export const FLAT_LUMINANCE_STD_DEV = 3

/** Draw `media` scaled to `size`², over an opaque backdrop. */
export const drawForClassification = (
  ctx: CanvasRenderingContext2D,
  media: CanvasImageSource,
  size: number
): void => {
  ctx.fillStyle = PREPROCESS_BACKDROP
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(media, 0, 0, size, size)
}

/**
 * True when RGBA pixel data is effectively one colour. Such a frame has no
 * content to classify, yet the classifier can score a solid fill as NSFW, so
 * blank placeholders and black video frames must not reach it.
 */
export const isFlatImage = (rgba: ArrayLike<number>): boolean => {
  const pixels = Math.floor(rgba.length / 4)
  if (pixels === 0) return true

  let sum = 0
  let sumOfSquares = 0
  for (let i = 0; i < pixels * 4; i += 4) {
    const luminance = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    sum += luminance
    sumOfSquares += luminance * luminance
  }

  const mean = sum / pixels
  const variance = Math.max(0, sumOfSquares / pixels - mean * mean)
  return Math.sqrt(variance) < FLAT_LUMINANCE_STD_DEV
}
