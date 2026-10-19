import { describe, expect, it } from 'vitest'
import { resolveLocale, translate } from '../../src/lib/i18n'

describe('i18n', () => {
  it('follows the system as Simplified Chinese and honors an explicit choice', () => {
    expect(resolveLocale('system')).toBe('zh-CN')
    expect(resolveLocale('en')).toBe('en')
    expect(resolveLocale('zh-CN')).toBe('zh-CN')
  })

  it('interpolates values, selects plural forms, and falls back to English', () => {
    expect(translate('en', 'appearance.language.available', { count: 1 })).toBe('1 language available')
    expect(translate('en', 'appearance.language.available', { count: 2 })).toBe('2 languages available')
    expect(translate('zh-CN', 'appearance.language.available', { count: 2 })).toBe('支持 2 种语言')
    expect(translate('zh-CN', 'common.reload')).toBe('Reload Kim')
  })
})
