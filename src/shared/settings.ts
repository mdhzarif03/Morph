import { z } from 'zod';
import { DEFAULT_ACCELERATOR } from './accelerator';

const toolPath = z.string().min(1).max(1024).optional();

export const SettingsSchema = z.strictObject({
  shortcut: z.string().min(1).max(64).default(DEFAULT_ACCELERATOR),
  launchAtLogin: z.boolean().default(false),
  /** When false the popup appears without taking keyboard focus, so typing in other apps is not interrupted. */
  focusOnOpen: z.boolean().default(false),
  hideOnBlur: z.boolean().default(true),
  notifications: z.boolean().default(true),
  outputNaming: z.enum(['same-name', 'suffix']).default('same-name'),
  outputSuffix: z
    .string()
    .max(32)
    .regex(/^[\w .()+-]*$/, 'Use letters, numbers, spaces and . _ - ( ) +')
    .default('_converted'),
  /** null = save next to the original file (the default). */
  outputDirectory: z.string().min(1).max(1024).nullable().default(null),
  imageQuality: z
    .strictObject({
      jpg: z.number().int().min(1).max(100).default(85),
      webp: z.number().int().min(1).max(100).default(80),
      avif: z.number().int().min(1).max(100).default(55),
    })
    .default({ jpg: 85, webp: 80, avif: 55 }),
  toolPaths: z
    .strictObject({
      ffmpeg: toolPath,
      ffprobe: toolPath,
    })
    .default({}),
  welcomeShown: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** A partial update. Nested objects are merged by the settings store. */
export const SettingsPatchSchema = z.strictObject({
  launchAtLogin: z.boolean().optional(),
  focusOnOpen: z.boolean().optional(),
  hideOnBlur: z.boolean().optional(),
  notifications: z.boolean().optional(),
  outputNaming: z.enum(['same-name', 'suffix']).optional(),
  // Defined without a default: a default inside a patch would silently reset the suffix on every unrelated update.
  outputSuffix: z
    .string()
    .max(32)
    .regex(/^[\w .()+-]*$/, 'Use letters, numbers, spaces and . _ - ( ) +')
    .optional(),
  /** The renderer may only reset this to null; a folder can only be chosen through the main-process dialog. */
  outputDirectory: z.null().optional(),
  imageQuality: z
    .strictObject({
      jpg: z.number().int().min(1).max(100).optional(),
      webp: z.number().int().min(1).max(100).optional(),
      avif: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  welcomeShown: z.boolean().optional(),
});

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
