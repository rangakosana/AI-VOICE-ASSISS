import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Predictable environment file resolution strategy:
 * 1. Checks apps/backend/.env (backend package-specific environment file).
 * 2. Checks current working directory .env (process.cwd()/.env).
 * 3. Checks monorepo root .env (repository root).
 *
 * Existing environment variables (e.g., set via shell/CLI or container runtime)
 * are preserved and never overwritten by dotenv.
 */
function loadEnvironment(): void {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // In both src/config and dist/config, the backend package root is two levels up
  const packageRoot = path.resolve(currentDir, '../../');
  const repoRoot = path.resolve(packageRoot, '../../');

  const candidatePaths = [
    path.resolve(packageRoot, '.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(repoRoot, '.env'),
  ];

  const loadedPaths = new Set<string>();

  for (const envPath of candidatePaths) {
    if (!loadedPaths.has(envPath) && fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      loadedPaths.add(envPath);
    }
  }
}

loadEnvironment();

export type Environment = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type AIProviderType = 'mock' | 'gemini';

export interface AppConfig {
  readonly nodeEnv: Environment;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly aiProvider: AIProviderType;
  readonly geminiApiKey?: string;
  readonly geminiModel: string;
  readonly databasePath: string;
}

function parsePort(val: string | undefined, defaultPort = 3000): number {
  if (!val) return defaultPort;
  const parsed = Number.parseInt(val, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT environment variable "${val}". Must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function parseEnvironment(val: string | undefined): Environment {
  const env = (val || 'development').toLowerCase();
  if (env === 'production' || env === 'test' || env === 'development') {
    return env;
  }
  throw new Error(`Invalid NODE_ENV "${val}". Expected "development", "production", or "test".`);
}

function parseLogLevel(val: string | undefined, nodeEnv: Environment): LogLevel {
  if (val) {
    const validLevels: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
    const level = val.toLowerCase() as LogLevel;
    if (validLevels.includes(level)) {
      return level;
    }
    throw new Error(`Invalid LOG_LEVEL "${val}". Expected one of: ${validLevels.join(', ')}.`);
  }

  // Sensible defaults per environment
  if (nodeEnv === 'test') return 'silent';
  if (nodeEnv === 'development') return 'debug';
  return 'info';
}

export function parseAIProvider(val: string | undefined): AIProviderType {
  const provider = (val || 'mock').toLowerCase().trim();
  if (provider === 'mock' || provider === 'gemini') {
    return provider;
  }
  throw new Error(`Invalid AI_PROVIDER "${val}". Expected "mock" or "gemini".`);
}

export function parseGeminiApiKey(val: string | undefined, provider: AIProviderType): string | undefined {
  const key = val?.trim();
  if (provider === 'gemini') {
    if (!key) {
      throw new Error(
        'Missing GEMINI_API_KEY environment variable. A valid API key is required when AI_PROVIDER is set to "gemini". Get a free key at https://aistudio.google.com/apikey or set AI_PROVIDER=mock.'
      );
    }
    return key;
  }
  return key || undefined;
}

export function resolveDatabasePath(val: string | undefined, nodeEnv: Environment): string {
  if (val) {
    const rawPath = val.trim();
    if (rawPath === ':memory:') {
      return ':memory:';
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(currentDir, '../../');
    return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(packageRoot, rawPath);
  }

  if (nodeEnv === 'test') {
    return ':memory:';
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(currentDir, '../../');
  return path.resolve(packageRoot, 'data/atlas.db');
}

const nodeEnv = parseEnvironment(process.env.NODE_ENV);
const aiProvider = parseAIProvider(process.env.AI_PROVIDER);
const geminiApiKey = parseGeminiApiKey(process.env.GEMINI_API_KEY, aiProvider);
const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
const databasePath = resolveDatabasePath(process.env.SQLITE_DB_PATH, nodeEnv);

export const config: AppConfig = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isDevelopment: nodeEnv === 'development',
  isTest: nodeEnv === 'test',
  port: parsePort(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  logLevel: parseLogLevel(process.env.LOG_LEVEL, nodeEnv),
  aiProvider,
  geminiApiKey,
  geminiModel,
  databasePath,
});
