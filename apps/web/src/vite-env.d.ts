/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CA_FIXTURE?: string;
  readonly VITE_CA_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
