import 'dotenv/config';

export interface AppConfig {
  mireyeToken: string | null;
  censusApiKey: string | null;
  llmModel: string | null;
  llmBaseUrl: string | null;
  demo: boolean;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : null;
}

export function loadConfig(demo: boolean): AppConfig {
  return {
    mireyeToken: env('MIREYE_API_TOKEN'),
    censusApiKey: env('CENSUS_API_KEY'),
    llmModel: env('LLM_MODEL'),
    llmBaseUrl: env('LLM_BASE_URL'),
    demo,
  };
}
