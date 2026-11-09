import {
  fetchBlobSource,
  fetchMediaBlob,
  MAX_GIF_BLOB_BYTES,
  MAX_VIDEO_BLOB_BYTES
} from '../../src/background/classifier/mediaSource'

type FetchMock = jest.Mock<Promise<unknown>, [string, unknown]>

const urlApi = URL as unknown as {
  createObjectURL: jest.Mock
  revokeObjectURL: jest.Mock
}

const buildResponse = (ok: boolean, contentLength?: string, blobSize = 10): unknown => ({
  ok,
  headers: { get: (name: string) => (name === 'content-length' ? contentLength ?? null : null) },
  blob: async () => ({ size: blobSize })
})

describe('background => mediaSource', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    // jest's node environment predates AbortController; offscreen pages always have it.
    if (typeof AbortController === 'undefined') {
      (global as Record<string, unknown>).AbortController = class {
        public readonly signal = {}
        public abort (): void {}
      }
    }

    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    urlApi.createObjectURL = jest.fn(() => 'blob:mock-url')
    urlApi.revokeObjectURL = jest.fn()
  })

  test('decodes remote bytes through a same-origin blob url', async () => {
    fetchMock.mockResolvedValue(buildResponse(true))

    const source = await fetchBlobSource('https://cdn.example/a.jpg', 1000)

    expect(source?.objectUrl).toBe('blob:mock-url')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example/a.jpg',
      expect.objectContaining({ credentials: 'omit' })
    )

    source?.revoke()
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  test('skips urls that are already readable from a canvas', async () => {
    expect(await fetchBlobSource('blob:abc', 1000)).toBeNull()
    expect(await fetchBlobSource('data:image/png;base64,AAA', 1000)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('falls back to the direct url when the fetch is rejected or fails', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse(false))
    expect(await fetchBlobSource('https://cdn.example/a.jpg', 1000)).toBeNull()

    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await fetchBlobSource('https://cdn.example/a.jpg', 1000)).toBeNull()
  })

  test('does not buffer videos above the blob size limit', async () => {
    fetchMock.mockResolvedValue(buildResponse(true, String(MAX_VIDEO_BLOB_BYTES + 1)))

    const source = await fetchBlobSource('https://cdn.example/a.mp4', 1000, MAX_VIDEO_BLOB_BYTES)

    expect(source).toBeNull()
    expect(urlApi.createObjectURL).not.toHaveBeenCalled()
  })

  test('rejects an oversized blob even when Content-Length was missing (chunked transfer)', async () => {
    fetchMock.mockResolvedValue(buildResponse(true, undefined, MAX_VIDEO_BLOB_BYTES + 1))

    const source = await fetchBlobSource('https://cdn.example/a.mp4', 1000, MAX_VIDEO_BLOB_BYTES)

    expect(source).toBeNull()
    expect(urlApi.createObjectURL).not.toHaveBeenCalled()
  })

  test('fetchMediaBlob hands back the bytes without wrapping them in an object url', async () => {
    fetchMock.mockResolvedValue(buildResponse(true))

    const blob = await fetchMediaBlob('https://cdn.example/a.gif', 1000)

    expect(blob).toEqual({ size: 10 })
    expect(urlApi.createObjectURL).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example/a.gif',
      expect.objectContaining({ credentials: 'omit' })
    )
  })

  test('fetchMediaBlob aborts the body, not just the headers', async () => {
    let passedSignal: unknown
    fetchMock.mockImplementation(async (_url: string, init: unknown) => {
      passedSignal = (init as { signal: unknown }).signal
      return buildResponse(true)
    })

    await fetchMediaBlob('https://cdn.example/a.gif', 1000)

    expect(passedSignal).toBeDefined()
  })

  test('fetchMediaBlob enforces the size limit callers pass for gifs', async () => {
    fetchMock.mockResolvedValue(buildResponse(true, String(MAX_GIF_BLOB_BYTES + 1)))

    expect(await fetchMediaBlob('https://cdn.example/big.gif', 1000, MAX_GIF_BLOB_BYTES)).toBeNull()
  })

  test('fetchMediaBlob returns null instead of throwing when the fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await fetchMediaBlob('https://cdn.example/a.gif', 1000)).toBeNull()

    fetchMock.mockResolvedValueOnce(buildResponse(false))
    expect(await fetchMediaBlob('https://cdn.example/a.gif', 1000)).toBeNull()
  })
})
