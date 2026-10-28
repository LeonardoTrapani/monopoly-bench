/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` serves the in-browser mock API; anything else uses the real API. */
  readonly VITE_API_MODE?: string;
  /** API origin, e.g. `http://localhost:1337`; empty or unset means the page's own origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
