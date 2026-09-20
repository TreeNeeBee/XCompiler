import type { DebugBrief, DebugFailureCategory } from '../execution/debug_brief.js';
import type { Phase } from '../../domain/planning/execution_plan.js';

export type DebugWikiLayer = 'system' | 'agent' | 'external' | 'project';
export type DebugWikiEntryStatus = 'active' | 'needs_review' | 'superseded';

export interface DebugWikiEntry {
  id: string;
  layer: DebugWikiLayer;
  createdAt: string;
  updatedAt: string;
  status: DebugWikiEntryStatus;
  category: DebugFailureCategory;
  summary: string;
  primaryError: string;
  debugDemand: string;
  fingerprints: string[];
  symptoms: string[];
  resolutionPlan?: string;
  solution: string;
  evidence: string[];
  sourceTicketId?: string;
  sourceStepId?: string;
  sourcePhase?: Phase;
  targetPhase?: Phase;
  language?: string;
  repairFiles?: string[];
  supersedes?: string[];
  stats: { uses: number; successes: number; failures: number };
  lastUsedAt?: string;
  feedback: DebugWikiFeedback[];
  sourcePath?: string;
}

export interface DebugWikiFeedback {
  at: string;
  kind: 'used' | 'success' | 'failure' | 'corrected';
  entryId?: string;
  ticketId?: string;
  stepId?: string;
  phase?: Phase;
  summary: string;
  reason?: string;
}

export interface DebugWikiMatch {
  entry: DebugWikiEntry;
  score: number;
  confidence: number;
  reasons: string[];
}

export interface DebugWikiResolutionInput {
  brief: DebugBrief;
  ticketId?: string;
  stepId?: string;
  phase?: Phase;
  targetPhase?: Phase;
  language?: string;
  resolutionPlan?: string;
  solution: string;
  evidence?: string[];
  repairFiles?: string[];
  usedEntryIds?: string[];
}

export interface DebugWikiPort {
  load(): Promise<void>;
  search(brief: DebugBrief, opts?: { limit?: number; language?: string }): Promise<DebugWikiMatch[]>;
  recordUse(entryIds: string[], input: DebugWikiResolutionInput): Promise<void>;
  recordFailure(
    entryIds: string[],
    input: DebugWikiResolutionInput & { reason?: string },
  ): Promise<void>;
  recordResolution(input: DebugWikiResolutionInput): Promise<{ created?: string; updated: string[] }>;
}

export class EmptyDebugWiki implements DebugWikiPort {
  async load(): Promise<void> {}

  async search(): Promise<DebugWikiMatch[]> {
    return [];
  }

  async recordUse(): Promise<void> {}

  async recordFailure(): Promise<void> {}

  async recordResolution(): Promise<{ updated: string[] }> {
    return { updated: [] };
  }
}
