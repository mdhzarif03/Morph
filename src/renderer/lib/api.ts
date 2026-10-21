import type { MorphApi } from '../../shared/api';

/** Typed access to the preload bridge. */
export function getApi(): MorphApi {
  return window.morph;
}
