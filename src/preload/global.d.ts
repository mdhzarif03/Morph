import type { MorphApi } from '../shared/api';

declare global {
  interface Window {
    /** Injected by the preload script. */
    morph: MorphApi;
  }
}
