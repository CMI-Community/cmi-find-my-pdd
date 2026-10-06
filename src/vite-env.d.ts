/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_WEB_ANALYTICS_ENABLED?: string;
  readonly VITE_SPEED_INSIGHTS_ENABLED?: string;
  readonly VITE_ANALYTICS_CUSTOM_EVENTS?: string;
  readonly VITE_FIRST_PARTY_ANALYTICS_ENABLED?: string;
}
