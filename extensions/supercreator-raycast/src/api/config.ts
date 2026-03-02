import { getPreferenceValues } from '@raycast/api';
import type { RawPreferences, AppConfig } from '../types';

export const CURRENT_CONFIG_VERSION = 2;

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const { configBase64 } = getPreferenceValues<RawPreferences>();
  const json = Buffer.from(configBase64, 'base64').toString('utf-8');
  cachedConfig = JSON.parse(json) as AppConfig;
  return cachedConfig;
}

export function isConfigOutdated(): boolean {
  try {
    const config = getConfig();
    return (config.configVersion ?? 0) < CURRENT_CONFIG_VERSION;
  } catch {
    return true;
  }
}

export function getConfigVersion(): number {
  try {
    return getConfig().configVersion ?? 0;
  } catch {
    return 0;
  }
}

export function isConfigured(): boolean {
  try {
    const config = getConfig();
    return Boolean(config.readDatabaseUrl && config.writeDatabaseUrl);
  } catch {
    return false;
  }
}

export function isRootlyConfigured(): boolean {
  try {
    return Boolean(getConfig().rootlyApiKey);
  } catch {
    return false;
  }
}

export function isOpenAIConfigured(): boolean {
  try {
    return Boolean(getConfig().openaiApiKey);
  } catch {
    return false;
  }
}

export function isLinearConfigured(): boolean {
  try {
    return Boolean(getConfig().linearApiKey);
  } catch {
    return false;
  }
}
