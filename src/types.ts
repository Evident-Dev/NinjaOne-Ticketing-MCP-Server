// ── Ticketing ────────────────────────────────────────────────────────────────

export interface NinjaOrganization {
  id: number;
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface NinjaLocation {
  id: number;
  name: string;
  address?: string;
  [key: string]: unknown;
}

export interface NinjaUser {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  userType?: "TECHNICIAN" | "END_USER";
  enabled?: boolean;
}

export interface NinjaContact {
  id: number;
  clientId: number;
  uid: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
}

export interface NinjaTicketStatusRef {
  name?: string;
  displayName?: string;
  parentId?: number;
  statusId: number;
}

export interface NinjaTicket {
  id: number;
  version?: number;
  clientId?: number;
  ticketFormId?: number;
  locationId?: number;
  nodeId?: number;
  subject: string;
  status?: NinjaTicketStatusRef | string;
  type?: TicketType;
  source?: string;
  priority?: TicketPriority;
  severity?: TicketSeverity;
  assignedAppUserId?: number;
  requesterUid?: string;
  tags?: string[];
  createTime?: number;
  deleted?: boolean;
  attributeValues?: unknown[];
  ccList?: { uids?: string[]; emails?: string[] };
  [key: string]: unknown;
}

export interface NinjaTicketLogEntry {
  id: number;
  appUserContactUid?: string;
  type: "DESCRIPTION" | "COMMENT" | "CONDITION" | "SAVE" | "DELETE";
  body?: string;
  htmlBody?: string;
  publicEntry?: boolean;
  createTime?: number;
  timeTracked?: number;
}

export type TicketStatus = "NEW" | "OPEN" | "WAITING" | "PAUSED" | "RESOLVED" | "CLOSED";
export type TicketType = "PROBLEM" | "QUESTION" | "INCIDENT" | "TASK";
export type TicketPriority = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export type TicketSeverity = "NONE" | "MINOR" | "MODERATE" | "MAJOR" | "CRITICAL";

export interface TicketComment {
  body: string;
  htmlBody?: string;
  public?: boolean;
  timeTracked?: number;
}

export interface CreateTicketInput {
  organization_name?: string;
  organization_id?: number;
  organization_domain?: string;
  location_id?: number;
  node_id?: number;
  summary: string;
  description: string;
  type?: TicketType;
  priority?: TicketPriority;
  severity?: TicketSeverity;
  status?: string;
  requester_email?: string;
  requester_uid?: string;
  assigned_app_user_id?: number;
  form_id?: number;
  tags?: string[];
  attributes?: Record<string, unknown>;
  cc_emails?: string[];
}

export interface UpdateTicketInput {
  ticket_id: number;
  summary?: string;
  status?: TicketStatus | string;
  type?: TicketType;
  priority?: TicketPriority;
  severity?: TicketSeverity;
  assigned_app_user_id?: number;
  tags?: string[];
  attributes?: Record<string, unknown>;
  comment_body?: string;
  comment_public?: boolean;
}

// ── Devices ──────────────────────────────────────────────────────────────────

export interface NinjaDevice {
  id: number;
  systemName?: string;
  displayName?: string;
  dnsName?: string;
  organizationId?: number;
  locationId?: number;
  nodeClass?: string;
  offline?: boolean;
  lastContact?: number;
  [key: string]: unknown;
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export interface NinjaAlert {
  uid: string;
  deviceId?: number;
  sourceType?: string;
  severity?: "MINOR" | "MODERATE" | "MAJOR" | "CRITICAL" | "NONE";
  status?: string;
  message?: string;
  createTime?: number;
  [key: string]: unknown;
}

// ── OAuth ────────────────────────────────────────────────────────────────────

export interface NinjaTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}
