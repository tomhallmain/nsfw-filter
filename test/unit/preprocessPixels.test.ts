import {
  drawForClassification,
  isFlatImage,
  PREPROCESS_BACKDROP
} from '../../src/background/classifier/preprocessPixels'

const SIZE = 32

const rgbaOf = (pixel: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const [r, g, b, a] = pixel(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return data
}

/** Deterministic ±2 jitter, standing in for compression noise on a flat fill. */
const jitter = (x: number, y: number): number => ((x * 7 + y * 13) % 5) - 2

describe('background => preprocessPixels => isFlatImage', () => {
  test.each([
    ['black', [0, 0, 0]],
    ['white', [255, 255, 255]],
    ['light grey', [240, 240, 240]],
    ['mid grey', [128, 128, 128]]
  ])('a solid %s fill is flat', (_name, [r, g, b]) => {
    expect(isFlatImage(rgbaOf(() => [r, g, b, 255]))).toBe(true)
  })

  test.each([
    ['black', 2],
    ['white', 253],
    ['light grey', 240]
  ])('a %s fill with compression-sized noise is still flat', (_name, base) => {
    expect(isFlatImage(rgbaOf((x, y) => {
      const v = base + jitter(x, y)
      return [v, v, v, 255]
    }))).toBe(true)
  })

  test('a horizontal gradient is not flat', () => {
    expect(isFlatImage(rgbaOf(x => {
      const v = Math.round((x / (SIZE - 1)) * 255)
      return [v, v, v, 255]
    }))).toBe(false)
  })

  test('half black, half white is not flat', () => {
    expect(isFlatImage(rgbaOf(x => (x < SIZE / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255])))).toBe(false)
  })

  test('a checkerboard is not flat', () => {
    expect(isFlatImage(rgbaOf((x, y) => ((x + y) % 2 === 0 ? [40, 40, 40, 255] : [200, 200, 200, 255])))).toBe(false)
  })

  test('a mostly flat frame with a small detailed region is not flat', () => {
    // A dark frame with a bright 8x8 patch: 1/16 of the area.
    expect(isFlatImage(rgbaOf((x, y) => (x < 8 && y < 8 ? [230, 230, 230, 255] : [10, 10, 10, 255])))).toBe(false)
  })

  test('empty pixel data is treated as flat', () => {
    expect(isFlatImage(new Uint8ClampedArray(0))).toBe(true)
  })
})

describe('background => preprocessPixels => drawForClassification', () => {
  test('fills the whole canvas with the opaque backdrop before drawing', () => {
    const calls: string[] = []
    const ctx = {
      fillStyle: '',
      fillRect: jest.fn((x: number, y: number, w: number, h: number) => {
        calls.push(`fillRect(${x},${y},${w},${h}) with ${ctx.fillStyle}`)
      }),
      drawImage: jest.fn((_media: unknown, x: number, y: number, w: number, h: number) => {
        calls.push(`drawImage(${x},${y},${w},${h})`)
      })
    }

    drawForClassification(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, 320)

    expect(calls).toEqual([
      `fillRect(0,0,320,320) with ${PREPROCESS_BACKDROP}`,
      'drawImage(0,0,320,320)'
    ])
  })
})
