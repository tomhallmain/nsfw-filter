import { extractBackgroundUrl, extractBackgroundUrls } from '../../src/content/Filter/backgroundUrl'

const BASE = 'https://example.com/profile/'

describe('content => backgroundUrl', () => {
  test('reads a double-quoted url, the shape an inline style attribute produces', () => {
    // A signed CDN URL: the query string carries base64 and tilde-bearing
    // segments, so nothing about it can be split on naively.
    const value = 'url("https://images-ssl.cdn.test/u/abc/def.jpg?Policy=eyJTdGF0ZW1lbnQ&Signature=vjZ9~4q1_a-b")'

    expect(extractBackgroundUrl(value)).toBe(
      'https://images-ssl.cdn.test/u/abc/def.jpg?Policy=eyJTdGF0ZW1lbnQ&Signature=vjZ9~4q1_a-b'
    )
  })

  test('reads single-quoted and unquoted urls', () => {
    expect(extractBackgroundUrl("url('https://example.com/a.jpg')")).toBe('https://example.com/a.jpg')
    expect(extractBackgroundUrl('url(https://example.com/b.jpg)')).toBe('https://example.com/b.jpg')
    expect(extractBackgroundUrl('url(  https://example.com/c.jpg  )')).toBe('https://example.com/c.jpg')
  })

  test('ignores gradients, including the commas inside them', () => {
    const value = 'linear-gradient(to top, rgb(0, 0, 0) 0%, rgba(255, 255, 255, 0) 100%)'

    expect(extractBackgroundUrls(value)).toEqual([])
  })

  test('takes the topmost layer when a gradient is stacked over an image', () => {
    const value = 'linear-gradient(to top, rgb(0, 0, 0) 0%, rgba(255, 255, 255, 0) 100%), url("https://example.com/photo.jpg")'

    expect(extractBackgroundUrl(value)).toBe('https://example.com/photo.jpg')
  })

  test('reports every layer, in order, without repeats', () => {
    const value = 'url("https://example.com/a.jpg"), url("https://example.com/b.jpg"), url("https://example.com/a.jpg")'

    expect(extractBackgroundUrls(value)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg'
    ])
  })

  test('takes the first candidate out of an image-set', () => {
    const value = 'image-set(url("https://example.com/1x.jpg") 1x, url("https://example.com/2x.jpg") 2x)'

    expect(extractBackgroundUrl(value)).toBe('https://example.com/1x.jpg')
  })

  test('drops schemes the offscreen document cannot fetch', () => {
    expect(extractBackgroundUrls('url("data:image/png;base64,iVBORw0KGgo=")')).toEqual([])
    expect(extractBackgroundUrls('url("blob:https://example.com/9f2-4c1")')).toEqual([])
    expect(extractBackgroundUrls('url("about:blank")')).toEqual([])
  })

  test('resolves a relative url against the document', () => {
    expect(extractBackgroundUrl('url("../images/a.jpg")', BASE)).toBe('https://example.com/images/a.jpg')
    expect(extractBackgroundUrl('url("/root.jpg")', BASE)).toBe('https://example.com/root.jpg')
  })

  test('treats none and the empty value as nothing to classify', () => {
    expect(extractBackgroundUrls('none')).toEqual([])
    expect(extractBackgroundUrls('')).toEqual([])
  })

  test('keeps an escaped quote inside a quoted url', () => {
    expect(extractBackgroundUrl('url("https://example.com/a\\"b.jpg")')).toBe('https://example.com/a"b.jpg')
  })
})
