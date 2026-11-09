/**
 * @jest-environment jsdom
 */

import { blurFilterForScore } from '../../src/content/Filter/blurEffect'
import { ImageFilter } from '../../src/content/Filter/ImageFilter'

describe('content => ImageFilter', () => {
  test('revealImage clears filter effects and marks image as sfw', () => {
    const filter = new ImageFilter()
    const image = document.createElement('img')
    image.style.filter = 'blur(25px)'
    image.style.visibility = 'hidden'
    image.hidden = true
    image.dataset.nsfwFilterStatus = 'nsfw'
    document.body.appendChild(image)

    const frame = document.createElement('span')
    frame.setAttribute('data-nsfw-filter-frame', '1')
    frame.style.outline = '4px solid #e11d48'
    document.body.appendChild(frame)
    frame.appendChild(image)

    filter.revealImage(image)

    expect(image.style.filter).toBe('')
    expect(image.style.visibility).toBe('visible')
    expect(frame.style.outline).toBe('')
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')

    document.body.removeChild(frame)
  })

  test('revealImage works when image is not a direct body child', () => {
    const filter = new ImageFilter()
    const wrapper = document.createElement('div')
    const image = document.createElement('img')
    image.style.filter = 'grayscale(1)'
    image.style.visibility = 'hidden'
    image.dataset.nsfwFilterStatus = 'nsfw'
    wrapper.appendChild(image)
    document.body.appendChild(wrapper)

    filter.revealImage(image)

    expect(image.style.filter).toBe('')
    expect(image.style.visibility).toBe('visible')
    expect(image.dataset.nsfwFilterStatus).toBe('sfw')

    document.body.removeChild(wrapper)
  })
})

describe('content => blurEffect', () => {
  test('blurFilterForScore scales blur and brightness with certainty', () => {
    expect(blurFilterForScore(0)).toBe('blur(12px) brightness(1)')
    expect(blurFilterForScore(1)).toBe('blur(60px) brightness(0.4)')
    expect(blurFilterForScore(0.5)).toBe('blur(36px) brightness(0.7)')
  })
})
