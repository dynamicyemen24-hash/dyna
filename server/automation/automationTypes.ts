export type AutomationTriggerType = 'manual' | 'event' | 'schedule';
export type AutomationRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationStepType = 'audit_log' | 'require_approval' | 'refresh_kpi';

export interface AutomationTrigger {
  type: AutomationTriggerType;
  eventName?: string;
  intervalSeconds?: number;
  timezone?: string;
}

export interface AutomationStep {
  id: string;
  type: AutomationStepType;
  label: string;
  config?: Record<string, unknown>;
}

export interface AutomationWorkflow {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
}

export interface AutomationRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: AutomationRunStatus;
  triggerSource: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface AutomationOverview {
  workflows: AutomationWorkflow[];
  runs: AutomationRun[];
  counts: { active: number; scheduled: number; running: number; failed: number };
}
