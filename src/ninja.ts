import type { AppConfig } from "./config.js";
import type {
  CreateTicketInput,
  NinjaContact,
  NinjaOrganization,
  NinjaTicket,
  NinjaTokenResponse,
  NinjaUser,
  TicketComment,
  TicketPriority,
  TicketSeverity,
  UpdateTicketInput
} from "./types.js";

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface CachedList<T> {
  items: T[];
  fetchedAtMs: number;
}

interface TechnicianProfile {
  appUserId: number;
  firstName?: string;
  lastName?: string;
  email: string;
  displayName: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class NinjaClient {
  private token?: CachedToken;
  private orgCache?: CachedList<NinjaOrganization>;
  private contactCache?: CachedList<NinjaContact>;
  private technicianProfile?: TechnicianProfile | null;

  constructor(private readonly config: AppConfig) {}

  async testConnection(): Promise<{ ok: boolean; orgCount: number }> {
    const orgs = await this.getOrganizations();
    return { ok: true, orgCount: orgs.length };
  }

  // ── Organizations ────────────────────────────────────────────────────────

  async getOrganizations(): Promise<NinjaOrganization[]> {
    const now = Date.now();
    if (this.orgCache && now - this.orgCache.fetchedAtMs < CACHE_TTL_MS) {
      return this.orgCache.items;
    }

    const data = await this.request<unknown>("/organizations", "GET");
    let items: NinjaOrganization[] = [];

    if (Array.isArray(data)) {
      items = data.filter(isOrganization);
    } else if (isRecord(data) && Array.isArray(data.results)) {
      items = (data.results as unknown[]).filter(isOrganization);
    }

    this.orgCache = { items, fetchedAtMs: now };
    return items;
  }

  async findOrganizations(query: string, limit = 10): Promise<NinjaOrganization[]> {
    const cleaned = query.trim().toLowerCase();
    const orgs = await this.getOrganizations();
    return orgs
      .filter((org) => org.name.toLowerCase().includes(cleaned))
      .sort((a, b) => scoreOrgMatch(a.name, cleaned) - scoreOrgMatch(b.name, cleaned))
      .slice(0, limit);
  }

  // ── Contacts ─────────────────────────────────────────────────────────────

  async getContacts(): Promise<NinjaContact[]> {
    const now = Date.now();
    if (this.contactCache && now - this.contactCache.fetchedAtMs < CACHE_TTL_MS) {
      return this.contactCache.items;
    }

    const data = await this.request<unknown>("/ticketing/contact/contacts", "GET");
    const items = Array.isArray(data) ? (data as unknown[]).filter(isContact) : [];
    this.contactCache = { items, fetchedAtMs: now };
    return items;
  }

  async findContactByEmail(email: string): Promise<NinjaContact | undefined> {
    const lower = email.trim().toLowerCase();
    const contacts = await this.getContacts();
    return contacts.find((c) => c.email?.toLowerCase() === lower);
  }

  async findContactsByDomain(domain: string): Promise<NinjaContact[]> {
    const lower = domain.trim().toLowerCase().replace(/^@/, "");
    const contacts = await this.getContacts();
    return contacts.filter((c) => c.email?.toLowerCase().endsWith(`@${lower}`));
  }

  async findContactsByQuery(query: string): Promise<NinjaContact[]> {
    const lower = query.trim().toLowerCase();
    const contacts = await this.getContacts();
    return contacts.filter(
      (c) =>
        c.email?.toLowerCase().includes(lower) ||
        c.firstName?.toLowerCase().includes(lower) ||
        c.lastName?.toLowerCase().includes(lower) ||
        `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase().includes(lower)
    );
  }

  async findOrgsByDomain(domain: string): Promise<NinjaOrganization[]> {
    const contacts = await this.findContactsByDomain(domain);
    if (contacts.length === 0) return [];

    const clientIds = [...new Set(contacts.map((c) => c.clientId))];
    const orgs = await this.getOrganizations();
    return orgs.filter((org) => clientIds.includes(org.id));
  }

  // ── Technician identity ───────────────────────────────────────────────────

  async getTechnicianProfile(): Promise<TechnicianProfile | null> {
    if (this.technicianProfile !== undefined) return this.technicianProfile;
    if (!this.config.technicianEmail) {
      this.technicianProfile = null;
      return null;
    }

    const users = await this.request<unknown>("/users", "GET");
    const list = Array.isArray(users) ? (users as unknown[]).filter(isUser) : [];
    const match = list.find((u) => u.email?.toLowerCase() === this.config.technicianEmail!.toLowerCase());

    if (!match) {
      console.warn(`TECHNICIAN_EMAIL "${this.config.technicianEmail}" not found in NinjaOne users.`);
      this.technicianProfile = null;
      return null;
    }

    const displayName = [match.firstName, match.lastName].filter(Boolean).join(" ") || match.email!;
    this.technicianProfile = {
      appUserId: match.id,
      firstName: match.firstName,
      lastName: match.lastName,
      email: match.email!,
      displayName
    };
    return this.technicianProfile;
  }

  // ── Ticket forms & boards ─────────────────────────────────────────────────

  async listTicketForms(): Promise<unknown> {
    return this.request<unknown>("/ticketing/ticket-form", "GET");
  }

  async listTicketBoards(): Promise<unknown> {
    return this.request<unknown>("/ticketing/trigger/boards", "GET");
  }

  async listTicketStatuses(): Promise<unknown> {
    return this.request<unknown>("/ticketing/statuses", "GET");
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  async getTicket(ticketId: number): Promise<NinjaTicket> {
    return this.request<NinjaTicket>(`/ticketing/ticket/${ticketId}`, "GET");
  }

  async createTicket(input: CreateTicketInput): Promise<NinjaTicket> {
    const [clientId, requesterUid, technician] = await Promise.all([
      this.resolveClientId(input),
      input.requester_email ? this.findContactByEmail(input.requester_email).then((c) => c?.uid) : Promise.resolve(undefined),
      this.getTechnicianProfile()
    ]);

    const payload = buildCreatePayload(input, clientId, requesterUid, technician, this.config);
    return this.request<NinjaTicket>("/ticketing/ticket", "POST", payload);
  }

  async updateTicket(input: UpdateTicketInput): Promise<NinjaTicket> {
    const { ticket_id, comment_body, comment_public, ...ticketFields } = input;
    const technician = await this.getTechnicianProfile();

    const ticketPart: Record<string, unknown> = {};
    if (ticketFields.summary !== undefined) ticketPart.summary = ticketFields.summary;
    if (ticketFields.status !== undefined) ticketPart.status = ticketFields.status;
    if (ticketFields.type !== undefined) ticketPart.type = ticketFields.type;
    if (ticketFields.priority !== undefined) ticketPart.priority = ticketFields.priority;
    if (ticketFields.severity !== undefined) ticketPart.severity = ticketFields.severity;
    // Explicit override takes precedence; fall back to technician profile
    const assignee = ticketFields.assigned_app_user_id ?? technician?.appUserId;
    if (assignee !== undefined) ticketPart.assignedAppUserId = assignee;

    const commentPart: Record<string, unknown> | undefined = comment_body
      ? { body: signComment(comment_body, technician), public: comment_public ?? true }
      : undefined;

    const payload: Record<string, unknown> = {};
    if (Object.keys(ticketPart).length > 0) payload.ticket = ticketPart;
    if (commentPart) payload.comment = commentPart;

    return this.request<NinjaTicket>(`/ticketing/ticket/${ticket_id}`, "PUT", payload);
  }

  async addComment(ticketId: number, comment: TicketComment): Promise<unknown> {
    const technician = await this.getTechnicianProfile();
    return this.request<unknown>(`/ticketing/ticket/${ticketId}/comment`, "POST", {
      body: signComment(comment.body, technician),
      ...(comment.htmlBody ? { htmlBody: comment.htmlBody } : {}),
      public: comment.public ?? true,
      ...(comment.timeTracked ? { timeTracked: comment.timeTracked } : {})
    });
  }

  async listTicketLogEntries(ticketId: number): Promise<unknown> {
    return this.request<unknown>(`/ticketing/ticket/${ticketId}/log-entry`, "GET");
  }

  async listTicketAttributes(): Promise<unknown> {
    return this.request<unknown>("/ticketing/attributes", "GET");
  }

  async listTicketsForBoard(boardId: number): Promise<unknown> {
    return this.request<unknown>(`/ticketing/trigger/board/${boardId}/run`, "POST");
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async resolveClientId(input: CreateTicketInput): Promise<number> {
    if (input.organization_id) return input.organization_id;

    if (input.organization_domain) {
      const orgs = await this.findOrgsByDomain(input.organization_domain);
      if (orgs.length === 0) throw new Error(`No NinjaOne organization found for domain '${input.organization_domain}'.`);
      if (orgs.length === 1) return orgs[0].id;
      const options = orgs.map((o) => `${o.name} (${o.id})`).join(", ");
      throw new Error(`Multiple organizations share domain '${input.organization_domain}': ${options}. Use organization_id to specify.`);
    }

    if (input.organization_name) {
      const matches = await this.findOrganizations(input.organization_name, 5);
      if (matches.length === 0) throw new Error(`No NinjaOne organization matched '${input.organization_name}'.`);

      const exactMatches = matches.filter(
        (org) => org.name.toLowerCase() === input.organization_name!.trim().toLowerCase()
      );
      if (exactMatches.length === 1) return exactMatches[0].id;
      if (matches.length === 1) return matches[0].id;

      const options = matches.map((org) => `${org.name} (${org.id})`).join(", ");
      throw new Error(`Multiple organizations matched '${input.organization_name}'. Specify organization_id: ${options}`);
    }

    throw new Error("Provide organization_id, organization_name, or organization_domain.");
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 60_000) {
      return this.token.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.ninjaClientId,
      client_secret: this.config.ninjaClientSecret,
      scope: "monitoring management"
    });

    const response = await fetch(this.config.ninjaTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });

    if (!response.ok) {
      throw new Error(`NinjaOne token request failed: ${response.status} ${await safeText(response)}`);
    }

    const tokenData = (await response.json()) as NinjaTokenResponse;
    if (!tokenData.access_token) throw new Error("NinjaOne token response did not include access_token.");

    const expiresInSeconds = tokenData.expires_in ?? 3600;
    this.token = { accessToken: tokenData.access_token, expiresAtMs: now + expiresInSeconds * 1000 };
    return this.token.accessToken;
  }

  async request<T>(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.config.ninjaApiBaseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      throw new Error(`NinjaOne API error: ${method} ${path} → ${response.status} ${await safeText(response)}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

// ── Payload builders ──────────────────────────────────────────────────────────

function buildCreatePayload(
  input: CreateTicketInput,
  clientId: number,
  requesterUid: string | undefined,
  technician: TechnicianProfile | null,
  config: AppConfig
): Record<string, unknown> {
  const ticketFormId = input.form_id ?? config.defaultTicketFormId;
  const boardId = input.board_id ?? config.defaultBoardId;

  const payload: Record<string, unknown> = {
    clientId,
    summary: input.summary,
    description: { body: input.description }
  };

  if (ticketFormId) payload.ticketFormId = ticketFormId;
  if (boardId) payload.boardId = boardId;
  if (input.type) payload.type = input.type;
  if (input.priority) payload.priority = input.priority;
  if (input.severity) payload.severity = input.severity;
  if (input.status) payload.status = input.status;
  if (requesterUid) payload.requesterUid = requesterUid;
  if (input.tags?.length) payload.tags = input.tags;
  if (technician) payload.assignedAppUserId = technician.appUserId;

  return payload;
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOrganization(value: unknown): value is NinjaOrganization {
  return isRecord(value) && typeof value.id === "number" && typeof value.name === "string";
}

function isContact(value: unknown): value is NinjaContact {
  return isRecord(value) && typeof value.id === "number" && typeof value.uid === "string" && typeof value.clientId === "number";
}

function isUser(value: unknown): value is NinjaUser {
  return isRecord(value) && typeof value.id === "number";
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function scoreOrgMatch(name: string, query: string): number {
  const lower = name.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  return 2;
}

function signComment(body: string, technician: TechnicianProfile | null): string {
  if (!technician) return body;
  return `${body}\n\n— ${technician.displayName}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return "<unable to read response body>";
  }
}

// Re-export for callers that need the enum types
export type { TicketPriority, TicketSeverity };
