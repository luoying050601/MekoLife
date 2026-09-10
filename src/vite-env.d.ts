/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Prefer this when Socket/API use a dedicated tunnel hostname (Scenario B). */
  readonly VITE_SOCKET_URL?: string;
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
