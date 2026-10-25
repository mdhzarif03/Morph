import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema } from '../../src/shared/settings';

describe('theme setting', () => {
  it('follows the system by default', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system');
  });

  it('accepts light, dark and system only', () => {
    for (const theme of ['light', 'dark', 'system'] as const) expect(SettingsPatchSchema.parse({ theme })).toEqual({ theme });
    expect(SettingsPatchSchema.safeParse({ theme: 'sepia' }).success).toBe(false);
  });

  it('keeps an old settings file valid and does not reset the theme on unrelated updates', () => {
    const legacy = { shortcut: 'Ctrl+Alt+M' };
    expect(SettingsSchema.parse(legacy).theme).toBe('system');
    expect(SettingsPatchSchema.parse({ hideOnBlur: false })).toEqual({ hideOnBlur: false });
  });
});
