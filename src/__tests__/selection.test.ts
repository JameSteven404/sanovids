import { describe, expect, it } from 'vitest'
import { pickAssetSelection } from '../actions'

const assets = new Set(['a1', 'a2', 'a3', 'a4', 'a5'])

describe('pickAssetSelection (which images "Nối (C)" connects)', () => {
  it('uses only the assets selected on the canvas when there are any', () => {
    // 3 picked on the canvas, an old library selection of everything must NOT leak in
    expect(pickAssetSelection(['a1', 'a2', 'a3', 'scene1'], ['a1', 'a2', 'a3', 'a4', 'a5'], assets)).toEqual(['a1', 'a2', 'a3'])
  })
  it('falls back to the library selection when no asset is selected on the canvas', () => {
    expect(pickAssetSelection(['scene1', 'scene2'], ['a4', 'a5'], assets)).toEqual(['a4', 'a5'])
  })
  it('ignores ids that are not assets and removes duplicates', () => {
    expect(pickAssetSelection(['a1', 'a1', 'take9'], [], assets)).toEqual(['a1'])
    expect(pickAssetSelection([], ['zz'], assets)).toEqual([])
  })
  it('never adds library cards when a video node is selected on the canvas', () => {
    expect(pickAssetSelection(['take9', 'scene2'], ['a1', 'a2'], assets, new Set(['take9']))).toEqual([])
    expect(pickAssetSelection(['scene2'], ['a1'], assets, new Set(['take9']))).toEqual(['a1'])
  })
})
