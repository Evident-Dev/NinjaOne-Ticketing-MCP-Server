import type { AppConfig } from "./config.js";
import { UserOAuth, UserOAuthError } from "./user-oauth.js";
import type {
  CreateTicketInput,
  NinjaAlert,
  NinjaContact,
  NinjaDevice,
  NinjaLocation,
  NinjaOrganization,
  NinjaTicket,
  NinjaTokenResponse,
  NinjaUser,
  TicketComment,
  UpdateTicketInput
} from "./types.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

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

interface TicketStatusRecord {
  statusId: number;
  name?: string;
  displayName?: string;
}

export class NinjaApiError extends Error {
  readonly status: number;
  readonly resultCode?: string;
  readonly errorMessage?: string;
  readonly rawBody: string;

  constructor(method: string, path: string, status: number, rawBody: string) {
    const parsed = tryParseJson(rawBody);
    const resultCode = isRecord(parsed) ? stringOrUndef(parsed.resultCode) : undefined;
    const errorMessage = isRecord(parsed)
      ? stringOrUndef(parsed.errorMessage) ?? stringOrUndef(parsed.message)
      : undefined;
    const detail = errorMessage ? ` — ${errorMessage}` : "";
    const codeTag = resultCode ? ` [${resultCode}]` : "";
    super(`NinjaOne API error: ${method} ${path} → ${status}${codeTag}${detail} | body: ${rawBody.slice(0, 500)}`);
    this.name = "NinjaApiError";
    this.status = status;
    this.resultCode = resultCode;
    this.errorMessage = errorMessage;
    this.rawBody = rawBody;
  }
}

export class NinjaClient {
  private machineToken?: CachedToken;
  private machineTokenPromise?: Promise<CachedToken>;
  private orgCache?: CachedList<NinjaOrganization>;
  private contactCache?: CachedList<NinjaContact>;
  private statusCache?: CachedList<TicketStatusRecord>;
  private technicianProfile?: TechnicianProfile | null;
  readonly userOAuth: UserOAuth;

  constructor(private readonly config: AppConfig) {
    this.userOAuth = new UserOAuth(config);
  }

  // ── Token management ─────────────────────────────────────────────────────
  //
  // Two flows:
  //  - User-context (Authorization Code + Refresh Token): required for ticket
  //    writes (NinjaOne returns 403 user_context_required otherwise).
  //  - Machine (Client Credentials): fine for reads. Faster, no login needed.
  //
  // Strategy per request:
  //  - If a user token is available, prefer it (it works for everything).
  //  - For write requests with no user token, throw a "login required" error
  //    with the login URL embedded — Claude surfaces this to the user.
  //  - For read requests with no user token, fall back to client_credentials.

  private async getAccessToken(requireUserContext: boolean): Promise<string> {
    // User-context token takes precedence whenever it's available.
    if (await this.userOAuth.isAuthenticated()) {
      try {
        return await this.userOAuth.getAccessToken();
      } catch (err) {
        if (err instanceof UserOAuthError && err.kind === "refresh-failed") {
          // The refresh token expired/was revoked. For writes we MUST surface
          // this — there's no fallback. For reads we silently degrade to M2M.
          if (requireUserContext) throw err;
          console.warn(
            `[ninja] user-token refresh failed, falling back to client_credentials for this read: ${err.message}`
          );
        } else {
          throw err;
        }
      }
    } else if (requireUserContext) {
      throw new UserOAuthError(
        `NinjaOne ticket-write operations require a one-time browser login. ` +
          this.userOAuth.loginInstructions(),
        "no-token",
        this.userOAuth.loginUrl()
      );
    }

    // Machine token path (reads only).
    const now = Date.now();
    if (this.machineToken && this.machineToken.expiresAtMs > now + TOKEN_REFRESH_BUFFER_MS) {
      return this.machineToken.accessToken;
    }
    if (!this.machineTokenPromise) {
      this.machineTokenPromise = this.acquireMachineToken().finally(() => {
        this.machineTokenPromise = undefined;
      });
    }
    const fresh = await this.machineTokenPromise;
    return fresh.accessToken;
  }

  private async acquireMachineToken(): Promise<CachedToken> {
    // Client Credentials grant — note the scope. NinjaOne accepts at minimum
    // monitoring + management here. offline_access is meaningless for M2M.
    const machineScope = this.config.oauthScope
      .split(/\s+/)
      .filter((s) => s && s !== "offline_access")
      .join(" ") || "monitoring management";

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.ninjaClientId,
      client_secret: this.config.ninjaClientSecret,
      scope: machineScope
    });

    const response = await fetch(this.config.ninjaTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });

    if (!response.ok) {
      const text = await safeText(response);
      throw new Error(
        `NinjaOne client_credentials request failed (${response.status}). ` +
          `Check NINJA_CLIENT_ID/SECRET, NINJA_REGION, and that 'Client Credentials' is enabled on the API app. Body: ${text}`
      );
    }

    const data = (await response.json()) as NinjaTokenResponse;
    if (!data.access_token) {
      throw new Error("NinjaOne token response did not include access_token.");
    }
    const expiresInSeconds = data.expires_in ?? 3600;
    this.machineToken = {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + expiresInSeconds * 1000
    };
    return this.machineToken;
  }

  invalidateToken(): void {
    this.machineToken = undefined;
    this.userOAuth.invalidateAccessToken();
  }

  // ── Smoke test ────────────────────────────────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; orgCount: number; sample: Array<{ id: number; name: string }> }> {
    const orgs = await this.getOrganizations();
    return {
      ok: true,
      orgCount: orgs.length,
      sample: orgs.slice(0, 3).map((o) => ({ id: o.id, name: o.name }))
    };
  }

  // ── Organizations ────────────────────────────────────────────────────────

  async getOrganizations(): Promise<NinjaOrganization[]> {
    const now = Date.now();
    if (this.orgCache && now - this.orgCache.fetchedAtMs < CACHE_TTL_MS) {
      return this.orgCache.items;
    }
    const data = await this.request<unknown>("/organizations", "GET");
    const items = Array.isArray(data)
      ? (data as unknown[]).filter(isOrganization)
      : isRecord(data) && Array.isArray(data.results)
        ? (data.results as unknown[]).filter(isOrganization)
        : [];
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

  async getOrganization(orgId: number): Promise<NinjaOrganization> {
    return this.request<NinjaOrganization>(`/organization/${orgId}`, "GET");
  }

  async getOrganizationLocations(orgId: number): Promise<NinjaLocation[]> {
    const data = await this.request<unknown>(`/organization/${orgId}/locations`, "GET");
    return Array.isArray(data) ? (data as NinjaLocation[]) : [];
  }

  async createOrganization(input: {
    name: string;
    description?: string;
    nodeApprovalMode?: "AUTOMATIC" | "MANUAL" | "REJECT";
  }): Promise<NinjaOrganization> {
    return this.request<NinjaOrganization>("/organizations", "POST", {
      name: input.name,
      description: input.description,
      nodeApprovalMode: input.nodeApprovalMode ?? "AUTOMATIC"
    });
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
    const match = list.find(
      (u) => u.email?.toLowerCase() === this.config.technicianEmail!.toLowerCase()
    );

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

  // ── Ticket metadata ───────────────────────────────────────────────────────

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

  async listTicketAttributes(): Promise<unknown> {
    return this.request<unknown>("/ticketing/attributes", "GET");
  }

  private async resolveStatus(status: string | number | undefined): Promise<string | undefined> {
    if (status === undefined || status === null || status === "") return undefined;
    if (typeof status === "number") return String(status);
    if (/^\d+$/.test(status)) return status;

    const wanted = status.trim().toLowerCase();
    const statuses = await this.listTicketStatuses();
    const match = statuses.find(
      (s) => s.name?.toLowerCase() === wanted || s.displayName?.toLowerCase() === wanted
    );
    if (!match) {
      throw new Error(
        `Unknown ticket status '${status}'. Use ninja_list_ticket_statuses to see valid options.`
      );
    }
    return String(match.statusId);
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  async getTicket(ticketId: number): Promise<NinjaTicket> {
    return this.request<NinjaTicket>(`/ticketing/ticket/${ticketId}`, "GET");
  }

  async createTicket(input: CreateTicketInput): Promise<NinjaTicket> {
    const [clientId, requesterUid, technician, statusId] = await Promise.all([
      this.resolveClientId(input),
      input.requester_uid
        ? Promise.resolve(input.requester_uid)
        : input.requester_email
          ? this.findContactByEmail(input.requester_email).then((c) => c?.uid)
          : Promise.resolve(undefined),
      this.getTechnicianProfile(),
      this.resolveStatus(input.status)
    ]);

    const ticketFormId = input.form_id ?? this.config.defaultTicketFormId;

    // NinjaOne ticket-create payload. `clientId` is the documented org field on
    // the ticket model. `description` is an object containing the first log
    // entry's body + visibility.
    const payload: Record<string, unknown> = {
      clientId,
      subject: input.summary,
      description: { body: input.description, public: true }
    };

    if (ticketFormId) payload.ticketFormId = ticketFormId;
    if (input.location_id) payload.locationId = input.location_id;
    if (input.node_id) payload.nodeId = input.node_id;
    if (input.type) payload.type = input.type;
    if (input.priority) payload.priority = input.priority;
    if (input.severity) payload.severity = input.severity;
    if (statusId) payload.status = statusId;
    if (requesterUid) payload.requesterUid = requesterUid;
    if (input.tags?.length) payload.tags = input.tags;
    if (input.attributes && Object.keys(input.attributes).length > 0) {
      payload.attributes = input.attributes;
    }
    if (input.cc_emails?.length) payload.ccList = { emails: input.cc_emails };
    const assignee = input.assigned_app_user_id ?? technician?.appUserId;
    if (assignee !== undefined) payload.assignedAppUserId = assignee;

    return this.request<NinjaTicket>("/ticketing/ticket", "POST", payload);
  }

  async updateTicket(input: UpdateTicketInput): Promise<NinjaTicket> {
    const { ticket_id, comment_body, comment_public, ...fields } = input;

    const payload: Record<string, unknown> = {};
    if (fields.summary !== undefined) payload.subject = fields.summary;
    if (fields.status !== undefined) payload.status = await this.resolveStatus(fields.status);
    if (fields.type !== undefined) payload.type = fields.type;
    if (fields.priority !== undefined) payload.priority = fields.priority;
    if (fields.severity !== undefined) payload.severity = fields.severity;
    if (fields.assigned_app_user_id !== undefined) payload.assignedAppUserId = fields.assigned_app_user_id;
    if (fields.tags !== undefined) payload.tags = fields.tags;
    if (fields.attributes && Object.keys(fields.attributes).length > 0) {
      payload.attributes = fields.attributes;
    }

    if (Object.keys(payload).length > 0) {
      await this.request<unknown>(`/ticketing/ticket/${ticket_id}`, "PUT", payload);
    }

    if (comment_body) {
      await this.addComment(ticket_id, { body: comment_body, public: comment_public ?? true });
    }

    return this.getTicket(ticket_id);
  }

  // POST /ticketing/ticket/{ticketId}/comment is multipart/form-data with a
  // "comment" part containing the JSON body. Returns 204 No Content, so we
  // re-fetch the ticket to return something meaningful.
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

  async listTicketsForBoard(boardId: number, pageSize = 100): Promise<unknown> {
    return this.request<unknown>(`/ticketing/trigger/board/${boardId}/run`, "POST", { pageSize });
  }

  // ── Devices ───────────────────────────────────────────────────────────────

  async listDevices(opts: { pageSize?: number; organizationId?: number; deviceFilter?: string } = {}): Promise<NinjaDevice[]> {
    const params = new URLSearchParams();
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    if (opts.organizationId) params.set("df", `org = ${opts.organizationId}`);
    else if (opts.deviceFilter) params.set("df", opts.deviceFilter);
    const qs = params.toString();
    const data = await this.request<unknown>(`/devices${qs ? `?${qs}` : ""}`, "GET");
    return Array.isArray(data) ? (data as NinjaDevice[]) : [];
  }

  async getDevice(deviceId: number): Promise<NinjaDevice> {
    return this.request<NinjaDevice>(`/device/${deviceId}`, "GET");
  }

  async rebootDevice(deviceId: number, mode: "NORMAL" | "FORCED" = "NORMAL", reason?: string): Promise<void> {
    const params = new URLSearchParams();
    if (reason) params.set("reason", reason);
    const qs = params.toString();
    await this.request<unknown>(
      `/device/${deviceId}/reboot/${mode}${qs ? `?${qs}` : ""}`,
      "POST"
    );
  }

  async getDeviceActivities(deviceId: number, pageSize = 50): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/activities?pageSize=${pageSize}`, "GET");
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  async listAlerts(opts: { deviceId?: number; sourceType?: string } = {}): Promise<NinjaAlert[]> {
    const path = opts.deviceId
      ? `/device/${opts.deviceId}/alerts`
      : opts.sourceType
        ? `/alerts/${opts.sourceType}`
        : "/alerts";
    const data = await this.request<unknown>(path, "GET");
    return Array.isArray(data) ? (data as NinjaAlert[]) : [];
  }

  async resetAlert(alertUid: string): Promise<void> {
    await this.request<unknown>(`/alert/${alertUid}/reset`, "POST");
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async resolveClientId(input: CreateTicketInput): Promise<number> {
    if (input.organization_id) return input.organization_id;

    if (input.organization_domain) {
      const orgs = await this.findOrgsByDomain(input.organization_domain);
      if (orgs.length === 0)
        throw new Error(`No NinjaOne organization found for domain '${input.organization_domain}'.`);
      if (orgs.length === 1) return orgs[0].id;
      const options = orgs.map((o) => `${o.name} (${o.id})`).join(", ");
      throw new Error(
        `Multiple organizations share domain '${input.organization_domain}': ${options}. Use organization_id to specify.`
      );
    }

    if (input.organization_name) {
      const matches = await this.findOrganizations(input.organization_name, 5);
      if (matches.length === 0)
        throw new Error(`No NinjaOne organization matched '${input.organization_name}'.`);

      const exactMatches = matches.filter(
        (org) => org.name.toLowerCase() === input.organization_name!.trim().toLowerCase()
      );
      if (exactMatches.length === 1) return exactMatches[0].id;
      if (matches.length === 1) return matches[0].id;

      const options = matches.map((org) => `${org.name} (${org.id})`).join(", ");
      throw new Error(
        `Multiple organizations matched '${input.organization_name}'. Specify organization_id: ${options}`
      );
    }

    throw new Error("Provide organization_id, organization_name, or organization_domain.");
  }

  async request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown
  ): Promise<T> {
    // Writes require user-context; reads can use either.
    const requireUserContext = method !== "GET";
    return this.requestWithRetry<T>(path, method, body, requireUserContext, false);
  }

  private async requestWithRetry<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: unknown,
    requireUserContext: boolean,
    isRetry: boolean
  ): Promise<T> {
    const token = await this.getAccessToken(requireUserContext);
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

    if (response.status === 401 && !isRetry) {
      this.invalidateToken();
      return this.requestWithRetry<T>(path, method, body, requireUserContext, true);
    }

    // 403 user_context_required during a read — we tried client_credentials
    // for an endpoint that secretly needs user context. Re-try as a write.
    if (
      response.status === 403 &&
      !requireUserContext &&
      !isRetry
    ) {
      const text = await safeText(response);
      if (/user_context_required/i.test(text)) {
        return this.requestWithRetry<T>(path, method, body, true, true);
      }
      throw new NinjaApiError(method, path, response.status, text);
    }

    if (!response.ok) {
      const text = await safeText(response);
      throw new NinjaApiError(method, path, response.status, text);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestMultipart(path: string, form: FormData): Promise<void> {
    return this.requestMultipartWithRetry(path, form, false);
  }

  private async requestMultipartWithRetry(path: string, form: FormData, isRetry: boolean): Promise<void> {
    // Comments are writes — always require user-context.
    const token = await this.getAccessToken(true);
    const url = `${this.config.ninjaApiBaseUrl}${path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: form
    });

    if (response.status === 401 && !isRetry) {
      this.invalidateToken();
      return this.requestMultipartWithRetry(path, form, true);
    }

    if (!response.ok) {
      const text = await safeText(response);
      throw new NinjaApiError("POST", path, response.status, text);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOrganization(value: unknown): value is NinjaOrganization {
  return isRecord(value) && typeof value.id === "number" && typeof value.name === "string";
}

function isContact(value: unknown): value is NinjaContact {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.uid === "string" &&
    typeof value.clientId === "number"
  );
}

function isUser(value: unknown): value is NinjaUser {
  return isRecord(value) && typeof value.id === "number";
}

function isStatusRecord(value: unknown): value is TicketStatusRecord {
  return isRecord(value) && typeof value.statusId === "number";
}

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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
