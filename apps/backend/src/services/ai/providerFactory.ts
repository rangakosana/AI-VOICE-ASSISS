import { config } from '../../config/index.js';
import type { AIProvider } from './types.js';
import { mockAIProvider } from './mockProvider.js';
import { GeminiProvider } from './geminiProvider.js';

/**
 * Creates or resolves the configured AIProvider based on application environment settings.
 *
 * Defaults to MockAIProvider when AI_PROVIDER=mock (or unspecified), enabling ₹0 zero-cost
 * local development and automated testing without requiring external credentials.
 */
export function createAIProvider(): AIProvider {
  if (config.aiProvider === 'gemini') {
    return new GeminiProvider({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    });
  }
  return mockAIProvider;
}

