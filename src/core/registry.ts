import { MorphError } from '../shared/errors';
import { FORMATS, type FormatId } from '../shared/formats';
import { normalizeOptions, type OptionSpec, type OptionValues } from '../shared/options';
import type { TargetDescriptor, ToolId, ToolchainSnapshot } from '../shared/types';
import { convertImage, IMAGE_FORMATS, imageNotes, imageOptionSpecs, type QualityDefaults } from './engines/image';
import { AUDIO_FORMATS, VIDEO_FORMATS, audioOptionSpecs, convertMedia, mediaNotes, mediaUnavailableReason, videoOptionSpecs } from './engines/media';
import { convertDocument } from './engines/office';
import { pdfImageOptionsFor, renderPdfToImages } from './engines/pdf';
import type { EngineContext, EngineResult } from './engines/types';

/** Everything the registry needs from the environment to describe what is possible right now. */
export interface RegistryEnv {
  toolchain: ToolchainSnapshot;
  quality: QualityDefaults;
}

export interface Route {
  source: FormatId;
  target: FormatId;
  /** External tools that must be present. */
  requires: readonly ToolId[];
  description: string;
  options(env: RegistryEnv): OptionSpec[];
  notes(env: RegistryEnv): string[];
  /** Extra availability checks beyond `requires` (e.g. missing encoders). Returns a reason or null. */
  unavailable?(env: RegistryEnv): string | null;
  run(ctx: EngineContext): Promise<EngineResult>;
}

const DOC_SOURCES: readonly FormatId[] = ['docx', 'doc', 'odt', 'txt'];

const TARGET_DESCRIPTIONS: Partial<Record<FormatId, string>> = {
  png: 'Lossless, supports transparency',
  jpg: 'Small photos, no transparency',
  webp: 'Modern, small, supports transparency',
  avif: 'Very small files, slow to encode',
  bmp: 'Uncompressed bitmap',
  tiff: 'Lossless archive and print format',
  gif: 'Up to 256 colours, supports animation',
  ico: 'Windows icon with multiple sizes',
  pdf: 'Portable document',
  docx: 'Editable Word document',
  odt: 'Editable OpenDocument text',
  mp3: 'Compatible lossy audio',
  wav: 'Uncompressed audio',
  flac: 'Lossless compressed audio',
  aac: 'Efficient lossy audio',
  ogg: 'Open lossy audio (Vorbis)',
  m4a: 'AAC audio in an MP4 container',
  mp4: 'Most compatible video',
  mkv: 'Flexible open container',
  mov: 'QuickTime container',
  webm: 'Web video (VP9 / AV1)',
  avi: 'Legacy video container',
};

function buildRoutes(): Route[] {
  const routes: Route[] = [];

  // Images
  for (const source of IMAGE_FORMATS) {
    for (const target of IMAGE_FORMATS) {
      routes.push({
        source,
        target,
        requires: [],
        description: TARGET_DESCRIPTIONS[target] ?? '',
        options: (env) => imageOptionSpecs(target, env.quality),
        notes: () => imageNotes(source, target),
        run: convertImage,
      });
    }
  }

  // PDF pages -> images
  for (const target of ['png', 'jpg'] as const) {
    routes.push({
      source: 'pdf',
      target,
      requires: ['pdftoppm', 'pdfinfo'],
      description: 'One image per page, packaged as a ZIP for several pages',
      options: () => pdfImageOptionsFor(target),
      notes: () => ['Pages are named like document_page_001 and keep their order.'],
      run: (ctx) => renderPdfToImages(ctx, ctx.sourcePath, ctx.baseName),
    });
  }

  // Word-processor documents
  for (const source of DOC_SOURCES) {
    routes.push({
      source,
      target: 'pdf',
      requires: ['soffice'],
      description: TARGET_DESCRIPTIONS.pdf ?? '',
      options: () => [],
      notes: () => [
        'Converted with LibreOffice. Layout can differ slightly from Microsoft Word, especially when fonts are missing.',
        ...(source === 'txt' ? ['Text is set in the default LibreOffice font.'] : []),
      ],
      run: convertDocument,
    });
    for (const target of ['png', 'jpg'] as const) {
      routes.push({
        source,
        target,
        requires: ['soffice', 'pdftoppm', 'pdfinfo'],
        description: 'One image per page, packaged as a ZIP for several pages',
        options: () => pdfImageOptionsFor(target),
        notes: () => ['The document is rendered through LibreOffice, then each page is rasterised.'],
        run: convertDocument,
      });
    }
  }
  for (const [source, target] of [
    ['docx', 'odt'],
    ['odt', 'docx'],
    ['doc', 'docx'],
    ['doc', 'odt'],
    ['txt', 'docx'],
    ['txt', 'odt'],
  ] as const) {
    routes.push({
      source,
      target,
      requires: ['soffice'],
      description: TARGET_DESCRIPTIONS[target] ?? '',
      options: () => [],
      notes: () => ['Complex formatting, tracked changes and embedded objects may not survive conversion between word-processor formats.'],
      run: convertDocument,
    });
  }

  // Audio / video
  const mediaSources: readonly FormatId[] = [...AUDIO_FORMATS, ...VIDEO_FORMATS];
  for (const source of mediaSources) {
    for (const target of AUDIO_FORMATS) {
      if (source === target) continue;
      routes.push({
        source,
        target,
        requires: ['ffmpeg', 'ffprobe'],
        description: TARGET_DESCRIPTIONS[target] ?? '',
        options: () => audioOptionSpecs(target),
        notes: () => mediaNotes(source, target),
        unavailable: (env) => mediaUnavailableReason(source, target, env.toolchain),
        run: convertMedia,
      });
    }
    if (!VIDEO_FORMATS.includes(source)) continue;
    for (const target of VIDEO_FORMATS) {
      if (source === target) continue;
      routes.push({
        source,
        target,
        requires: ['ffmpeg', 'ffprobe'],
        description: TARGET_DESCRIPTIONS[target] ?? '',
        options: (env) => videoOptionSpecs(target, env.toolchain),
        notes: () => mediaNotes(source, target),
        unavailable: (env) => mediaUnavailableReason(source, target, env.toolchain),
        run: convertMedia,
      });
    }
  }
  return routes;
}

const ROUTES: readonly Route[] = buildRoutes();
const ROUTE_INDEX = new Map<string, Route>(ROUTES.map((r) => [`${r.source}>${r.target}`, r]));

export function findRoute(source: FormatId, target: FormatId): Route | undefined {
  return ROUTE_INDEX.get(`${source}>${target}`);
}

export function allRoutes(): readonly Route[] {
  return ROUTES;
}

/** Target formats that exist for a source, regardless of whether the tools are installed. */
export function targetsFor(source: FormatId): FormatId[] {
  return ROUTES.filter((r) => r.source === source).map((r) => r.target);
}

export function routeUnavailableReason(route: Route, env: RegistryEnv): string | null {
  const missing = route.requires.filter((tool) => !env.toolchain.tools[tool].found);
  if (missing.length > 0) {
    const first = missing[0];
    if (first) {
      const status = env.toolchain.tools[first];
      return `${status.label} is not installed. ${status.installHint}`;
    }
  }
  return route.unavailable?.(env) ?? null;
}

/** Describes every conversion offered for a source format, including unavailable ones with a reason. */
export function describeTargets(source: FormatId, env: RegistryEnv): TargetDescriptor[] {
  return ROUTES.filter((r) => r.source === source).map((route) => {
    const reason = routeUnavailableReason(route, env);
    const base: TargetDescriptor = {
      format: route.target,
      label: FORMATS[route.target].label,
      description: route.description,
      available: reason === null,
      options: route.options(env),
      notes: route.notes(env),
    };
    if (reason !== null) base.unavailableReason = reason;
    return base;
  });
}

/**
 * Validates a requested conversion and returns its route plus normalised options.
 * Throws a MorphError that is safe to show the user.
 */
export function resolveConversion(source: FormatId, target: FormatId, rawOptions: Record<string, unknown>, env: RegistryEnv): { route: Route; options: OptionValues } {
  const route = findRoute(source, target);
  if (!route) {
    throw new MorphError('UNSUPPORTED_FORMAT', `Converting ${FORMATS[source].label} to ${FORMATS[target].label} is not supported.`);
  }
  const reason = routeUnavailableReason(route, env);
  if (reason !== null) {
    const missing = route.requires.find((tool) => !env.toolchain.tools[tool].found);
    throw new MorphError(missing ? 'TOOL_MISSING' : 'ENCODER_MISSING', reason);
  }
  const options = normalizeOptions(route.options(env), rawOptions);
  return { route, options };
}
