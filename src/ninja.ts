import type { AppConfig } from "./config.js";
import { loginUrl, refreshAccessToken, TokenStore } from "./auth.js";
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
  userContext: boolean;
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

interface TicketStatusRecord {
  statusId: number;
  name?: string;
  displayName?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class NinjaClient {
  private token?: CachedToken;
  private orgCache?: CachedList<NinjaOrganization>;
  private contactCache?: CachedList<NinjaContact>;
  private statusCache?: CachedList<TicketStatusRecord>;
  private technicianProfile?: TechnicianProfile | null;

  constructor(private readonly config: AppConfig, private readonly tokenStore: TokenStore) {}

  // Indicates whether a user-context refresh token is on disk. Reads can
  // succeed without it via client_credentials, but writes need it.
  async hasUserAuth(): Promise<boolean> {
    const stored = await this.tokenStore.load();
    return !!stored?.refresh_token;
  }

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

  async listTicketStatuses(): Promise<TicketStatusRecord[]> {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.fetchedAtMs < CACHE_TTL_MS) {
      return this.statusCache.items;
    }
    const data = await this.request<unknown>("/ticketing/statuses", "GET");
    const items = Array.isArray(data) ? (data as unknown[]).filter(isStatusRecord) : [];
    this.statusCache = { items, fetchedAtMs: now };
    return items;
  }

  // Accepts a status name ("NEW", "OPEN", custom display name) or a numeric ID.
  // Returns the statusId as a string, which is what the NinjaOne API expects in
  // create/update payloads.
  private async resolveStatus(status: string | number | undefined): Promise<string | undefined> {
    if (status === undefined || status === null || status === "") return undefined;
    if (typeof status === "number") return String(status);
    if (/^\d+$/.test(status)) return status;

    const wanted = status.trim().toLowerCase();
    const statuses = await this.listTicketStatuses();
    const match = statuses.find(
      (s) => s.name?.toLowerCase() === wanted || s.displayName?.toLowerCase() === wanted
    );
    if (!match) throw new Error(`Unknown ticket status '${status}'. Use ninja_list_ticket_statuses to see valid options.`);
    return String(match.statusId);
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  async getTicket(ticketId: number): Promise<NinjaTicket> {
    return this.request<NinjaTicket>(`/ticketing/ticket/${ticketId}`, "GET");
  }

  async createTicket(input: CreateTicketInput): Promise<NinjaTicket> {
    const [clientId, requesterUid, technician, statusId] = await Promise.all([
      this.resolveClientId(input),
      input.requester_email ? this.findContactByEmail(input.requester_email).then((c) => c?.uid) : Promise.resolve(undefined),
      this.getTechnicianProfile(),
      this.resolveStatus(input.status)
    ]);

    const payload = buildCreatePayload(input, clientId, requesterUid, technician, statusId, this.config);
    return this.request<NinjaTicket>("/ticketing/ticket", "POST", payload);
  }

  async updateTicket(input: UpdateTicketInput): Promise<NinjaTicket> {
    const { ticket_id, comment_body, comment_public, ...ticketFields } = input;
    const technician = await this.getTechnicianProfile();

    const payload: Record<string, unknown> = {};
    if (ticketFields.summary !== undefined) payload.subject = ticketFields.summary;
    if (ticketFields.status !== undefined) payload.status = await this.resolveStatus(ticketFields.status);
    if (ticketFields.type !== undefined) payload.type = ticketFields.type;
    if (ticketFields.priority !== undefined) payload.priority = ticketFields.priority;
    if (ticketFields.severity !== undefined) payload.severity = ticketFields.severity;
    const assignee = ticketFields.assigned_app_user_id ?? technician?.appUserId;
    if (assignee !== undefined) payload.assignedAppUserId = assignee;

    if (Object.keys(payload).length > 0) {
      await this.request<unknown>(`/ticketing/ticket/${ticket_id}`, "PUT", payload);
    }

    if (comment_body) {
      await this.addComment(ticket_id, { body: comment_body, public: comment_public ?? true });
    }

    return this.getTicket(ticket_id);
  }

  // POST /v2/ticketing/ticket/{ticketId}/comment is multipart/form-data and
  // returns 204 No Content. Re-fetch the ticket so callers still get something
  // meaningful back.
  async addComment(ticketId: number, comment: TicketComment): Promise<NinjaTicket> {
    const technician = await this.getTechnicianProfile();
    const commentObj: Record<string, unknown> = {
      body: signComment(comment.body, technician),
      public: comment.public ?? true,
      ...(comment.htmlBody ? { htmlBody: comment.htmlBody } : {}),
      ...(comment.timeTracked ? { timeTracked: comment.timeTracked } : {})
    };

    const form = new FormData();
    form.append("comment", new Blob([JSON.stringify(commentObj)], { type: "application/json" }));

    await this.requestMultipart(`/ticketing/ticket/${ticketId}/comment`, form);
    return this.getTicket(ticketId);
  }

  async listTicketLogEntries(ticketId: number): Promise<unknown> {
    return this.request<unknown>(`/ticketing/ticket/${ticketId}/log-entry`, "GET");
  }

  async listTicketAttributes(): Promise<unknown> {
    return this.request<unknown>("/ticketing/attributes", "GET");
  }

  async listTicketsForBoard(boardId: number, pageSize = 100): Promise<unknown> {
    return this.request<unknown>(`/ticketing/trigger/board/${boardId}/run`, "POST", { pageSize });
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

  private async getAccessToken(requireUserContext = false): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 60_000) {
      if (!requireUserContext || this.token.userContext) return this.token.accessToken;
    }

    const stored = await this.tokenStore.load();
    if (stored?.refresh_token) {
      try {
        const refreshed = await refreshAccessToken(this.config, stored.refresh_token);
        const expiresInSeconds = refreshed.expires_in ?? 3600;
        await this.tokenStore.save({
          refresh_token: refreshed.refresh_token ?? stored.refresh_token,
          access_token: refreshed.access_token,
          access_token_expires_at: now + expiresInSeconds * 1000,
          scope: refreshed.scope ?? stored.scope,
          obtained_at: now
        });
        this.token = {
          accessToken: refreshed.access_token,
          expiresAtMs: now + expiresInSeconds * 1000,
          userContext: true
        };
        return this.token.accessToken;
      } catch (error) {
        console.warn("NinjaOne refresh token exchange failed, falling back:", error);
        this.tokenStore.invalidate();
      }
    }

    if (requireUserContext) {
      throw new Error(authRequiredMessage(this.config));
    }

    // Fallback: client_credentials (machine token, reads-only).
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
    this.token = {
      accessToken: tokenData.access_token,
      expiresAtMs: now + expiresInSeconds * 1000,
      userContext: false
    };
    return this.token.accessToken;
  }

  async request<T>(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<T> {
    const isWrite = method !== "GET";
    const token = await this.getAccessToken(isWrite);
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
      const text = await safeText(response);
      if (response.status === 403 && /user_context_required/i.test(text)) {
        throw new Error(authRequiredMessage(this.config));
      }
      throw new Error(`NinjaOne API error: ${method} ${path} → ${response.status} ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestMultipart(path: string, form: FormData): Promise<void> {
    const token = await this.getAccessToken(true);
    const url = `${this.config.ninjaApiBaseUrl}${path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: form
    });

    if (!response.ok) {
      const text = await safeText(response);
      if (response.status === 403 && /user_context_required/i.test(text)) {
        throw new Error(authRequiredMessage(this.config));
      }
      throw new Error(`NinjaOne API error: POST ${path} → ${response.status} ${text}`);
    }
  }
}

function authRequiredMessage(config: AppConfig): string {
  return `NinjaOne user authentication required for this action. Visit ${loginUrl(config)} in a browser to connect your NinjaOne account, then retry.`;
}

// ── Payload builders ──────────────────────────────────────────────────────────

function buildCreatePayload(
  input: CreateTicketInput,
  clientId: number,
  requesterUid: string | undefined,
  technician: TechnicianProfile | null,
  statusId: string | undefined,
  config: AppConfig
): Record<string, unknown> {
  const ticketFormId = input.form_id ?? config.defaultTicketFormId;

  const payload: Record<string, unknown> = {
    clientId,
    subject: input.summary,
    description: { body: input.description, public: true }
  };

  if (ticketFormId) payload.ticketFormId = ticketFormId;
  if (input.type) payload.type = input.type;
  if (input.priority) payload.priority = input.priority;
  if (input.severity) payload.severity = input.severity;
  if (statusId) payload.status = statusId;
  if (requesterUid) payload.requesterUid = requesterUid;
  if (input.tags?.length) payload.tags = input.tags;
  const assignee = input.assigned_app_user_id ?? technician?.appUserId;
  if (assignee !== undefined) payload.assignedAppUserId = assignee;

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

function isStatusRecord(value: unknown): value is TicketStatusRecord {
  return isRecord(value) && typeof value.statusId === "number";
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
