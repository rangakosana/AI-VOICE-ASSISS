import type {
  RecallRepository,
  RecalledExchange,
  RecalledMessage,
  RecallSearchParams,
} from '../../db/repositories/recallRepository.js';

export type {
  RecalledExchange,
  RecalledMessage,
  RecallSearchParams,
};

export interface RecallContextConfig {
  /** Maximum number of historical exchanges included in prompt context (default: 3) */
  readonly maxExchanges?: number;
  /** Maximum character length of the assembled recall prompt block (default: 1500) */
  readonly maxContextChars?: number;
  /** Number of neighboring messages before and after each matched message (default: 1) */
  readonly neighborCount?: number;
}

export interface RecallServiceOptions {
  readonly repository?: RecallRepository;
  readonly defaultUserId?: string;
  readonly config?: RecallContextConfig;
}

export interface BuildRecallContextOptions {
  /** User's current input message used as the recall search query */
  readonly query: string;
  /** Active session ID to exclude from historical recall */
  readonly currentSessionId?: string;
  /** Target user ID (defaults to 'default_user') */
  readonly userId?: string;
}

