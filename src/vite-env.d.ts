/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_MODE?: string;
  readonly VITE_IS_CONNECTED_APP?: string;
  readonly VITE_FACILIO_API_BASE_URL?: string;
  readonly VITE_FACILIO_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
