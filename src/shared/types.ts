// Shared types between client and server

export const PERSONA_ROLES = [
  { value: 'marketing', label: 'Markkinointijohtaja / CMO' },
  { value: 'ceo',       label: 'Toimitusjohtaja / CEO' },
  { value: 'sales',     label: 'Myyntijohtaja' },
  { value: 'hr',        label: 'HR-johtaja' },
  { value: 'comms',     label: 'Viestintäjohtaja' },
  { value: 'cfo',       label: 'Talousjohtaja / CFO' },
  { value: 'digital',   label: 'Digitaalijohtaja / CDO' },
  { value: 'cto',       label: 'Teknologiajohtaja / CTO' },
] as const;

export type PersonaRole = typeof PERSONA_ROLES[number]['value'];

export interface PersonaConfig {
  primaryRole: PersonaRole;
  fallbackRole: PersonaRole | null;
  acceptAnyContact: boolean;
}

export interface LogEntry {
  id?: number;
  timestamp: number;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}

export interface Lead {
  id: string;
  campaignId: string;
  companyName: string;
  domain: string;
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  contactPhone: string;
  extractionComment: string;
  found: boolean;
  isGenericContact?: boolean;
  sourceUrl: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'error';
  statusMessage: string;
  errorMessage: string;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  logs?: LogEntry[];
}

export interface Campaign {
  id: string;
  name: string;
  description: string;
  personaConfig: PersonaConfig | null;
  createdAt: number;
  updatedAt: number;
  totalLeads?: number;
  completedLeads?: number;
  foundLeads?: number;
}

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  error: number;
  isRunning: boolean;
}

export type SSEEvent =
  | { type: 'lead.updated'; payload: Lead }
  | { type: 'lead.log'; payload: { leadId: string; log: LogEntry } }
  | { type: 'queue.status'; payload: QueueStatus };
