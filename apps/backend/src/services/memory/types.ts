import type {
  MemoryCategory,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
  MemoryRepository,
} from '../../db/repositories/memoryRepository.js';

export type {
  MemoryCategory,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
};

export interface SaveMemoryInput {
  category: MemoryCategory;
  content: string;
  source?: MemorySource;
  status?: MemoryStatus;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  status?: MemoryStatus;
  metadata?: Record<string, unknown>;
}

export interface MemoryListFilter {
  category?: MemoryCategory;
  status?: MemoryStatus;
  search?: string;
  limit?: number;
}

export interface MemoryContextConfig {
  /** Maximum number of active memories included in prompt context (default: 20) */
  readonly maxActiveMemories?: number;
  /** Maximum character length of the assembled memory prompt block (default: 2000) */
  readonly maxContextChars?: number;
}

export interface MemoryServiceOptions {
  readonly repository?: MemoryRepository;
  readonly defaultUserId?: string;
  readonly config?: MemoryContextConfig;
}

