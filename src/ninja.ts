import type { AppConfig } from "./config.js";
import type { TechnicianDb } from "./db.js";
import { getCurrentRequestContext, getRequestTechnicianEmail } from "./request-context.js";
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
  // Keyed by lowercased email so a multi-tech deployment doesn't refetch /users
  // once per tech.
  private technicianProfileCache = new Map<string, TechnicianProfile | null>();
  readonly userOAuth: UserOAuth;
  private auditDb: TechnicianDb | null = null;

  constructor(private readonly config: AppConfig) {
    this.userOAuth = new UserOAuth(config);
  }

  /** Wire the Postgres handle in once it's bootstrapped. Audit writes are
   *  best-effort: if not set, non-GET calls aren't recorded. */
  setAuditDb(db: TechnicianDb | null): void {
    this.auditDb = db;
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

  // Resolves the technician identity for the current request. Priority:
  //   1. explicit email argument (per-tool-call override)
  //   2. X-Ninja-Technician-Email header on the MCP request
  //   3. TECHNICIAN_EMAIL env var (server default)
  //   4. none (no auto-assignment, comments unsigned)
  //
  // Returns the resolved tech and which source it came from so tools like
  // ninja_whoami can be transparent.
  async getTechnicianProfile(
    explicitEmail?: string
  ): Promise<TechnicianProfile | null> {
    const source = this.resolveTechnicianEmail(explicitEmail);
    if (!source.email) return null;

    const cacheKey = source.email.toLowerCase();
    if (this.technicianProfileCache.has(cacheKey)) {
      return this.technicianProfileCache.get(cacheKey) ?? null;
    }

    const users = await this.request<unknown>("/users", "GET");
    const list = Array.isArray(users) ? (users as unknown[]).filter(isUser) : [];
    const match = list.find((u) => u.email?.toLowerCase() === cacheKey);

    if (!match) {
      console.warn(
        `Technician email "${source.email}" (source: ${source.source}) not found in NinjaOne users.`
      );
      this.technicianProfileCache.set(cacheKey, null);
      return null;
    }

    const displayName = [match.firstName, match.lastName].filter(Boolean).join(" ") || match.email!;
    const profile: TechnicianProfile = {
      appUserId: match.id,
      firstName: match.firstName,
      lastName: match.lastName,
      email: match.email!,
      displayName
    };
    this.technicianProfileCache.set(cacheKey, profile);
    return profile;
  }

  // Returns every NinjaOne user with userType === "TECHNICIAN" (and not
  // disabled). Used by the technician-store sync to seed the DB with one row
  // per real technician.
  async listTechnicianUsers(): Promise<NinjaUser[]> {
    const data = await this.request<unknown>("/users", "GET");
    const list = Array.isArray(data) ? (data as unknown[]).filter(isUser) : [];
    return list.filter(
      (u) => u.userType === "TECHNICIAN" && u.enabled !== false && !!u.email
    );
  }

  // Reports which technician identity applies to the current request, along
  // with the source — useful for ninja_whoami to be transparent.
  resolveTechnicianEmail(explicitEmail?: string): {
    email?: string;
    source: "tool-arg" | "url-token" | "config" | "none";
  } {
    if (explicitEmail) return { email: explicitEmail, source: "tool-arg" };
    const fromRequest = getRequestTechnicianEmail();
    if (fromRequest) return { email: fromRequest, source: "url-token" };
    if (this.config.technicianEmail) {
      return { email: this.config.technicianEmail, source: "config" };
    }
    return { source: "none" };
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

  // Look up the tenant's default ticket form (the one with isDefault: true)
  // and cache it. Used when no form_id is passed and DEFAULT_TICKET_FORM_ID
  // isn't set (or points at a stale ID).
  private cachedDefaultFormId?: number | null;
  private async resolveDefaultFormId(): Promise<number | undefined> {
    if (this.cachedDefaultFormId !== undefined) {
      return this.cachedDefaultFormId ?? undefined;
    }
    try {
      const forms = await this.listTicketForms();
      const list = Array.isArray(forms) ? (forms as Array<Record<string, unknown>>) : [];
      const def = list.find((f) => f.isDefault === true) ?? list[0];
      this.cachedDefaultFormId = typeof def?.id === "number" ? def.id : null;
    } catch {
      this.cachedDefaultFormId = null;
    }
    return this.cachedDefaultFormId ?? undefined;
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  async getTicket(ticketId: number): Promise<NinjaTicket> {
    return this.request<NinjaTicket>(`/ticketing/ticket/${ticketId}`, "GET");
  }

  async createTicket(input: CreateTicketInput): Promise<NinjaTicket> {
    // NinjaOne requires `status` and `ticketFormId` on every ticket-create. We
    // default status to "NEW" (resolved to the tenant's NEW statusId) and
    // ticketFormId to the tenant's default form if the caller didn't specify.
    const [clientId, requesterUid, technician, statusId, defaultFormId] = await Promise.all([
      this.resolveClientId(input),
      input.requester_uid
        ? Promise.resolve(input.requester_uid)
        : input.requester_email
          ? this.findContactByEmail(input.requester_email).then((c) => c?.uid)
          : Promise.resolve(undefined),
      this.getTechnicianProfile(),
      this.resolveStatus(input.status ?? "NEW"),
      input.form_id || this.config.defaultTicketFormId
        ? Promise.resolve(undefined)
        : this.resolveDefaultFormId()
    ]);

    const ticketFormId = input.form_id ?? this.config.defaultTicketFormId ?? defaultFormId;

    // NinjaOne ticket-create payload. `clientId` is the documented org field on
    // the ticket model. `description` is an object containing the first log
    // entry's body + visibility.
    const payload: Record<string, unknown> = {
      clientId,
      subject: input.summary,
      description: { body: input.description, public: true },
      status: statusId
    };

    if (ticketFormId) payload.ticketFormId = ticketFormId;
    if (input.location_id) payload.locationId = input.location_id;
    if (input.node_id) payload.nodeId = input.node_id;
    if (input.type) payload.type = input.type;
    if (input.priority) payload.priority = input.priority;
    if (input.severity) payload.severity = input.severity;
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

    // NinjaOne's PUT /ticketing/ticket/{id} validates the body as a full
    // ticket DTO — `subject` is non-nullable. Even a status-only change needs
    // subject present, so we fetch the current ticket first and merge.
    const hasFieldUpdate =
      fields.summary !== undefined ||
      fields.status !== undefined ||
      fields.type !== undefined ||
      fields.priority !== undefined ||
      fields.severity !== undefined ||
      fields.assigned_app_user_id !== undefined ||
      fields.tags !== undefined ||
      (fields.attributes && Object.keys(fields.attributes).length > 0);

    if (hasFieldUpdate) {
      await this.putTicketUpdate(ticket_id, fields, false);
    }

    if (comment_body) {
      await this.addComment(ticket_id, { body: comment_body, public: comment_public ?? true });
    }

    return this.getTicket(ticket_id);
  }

  // PUT /ticketing/ticket/{id} requires a full ticket-shaped payload AND a
  // `version` field that matches the server's current version (optimistic
  // concurrency). If something else updated the ticket between our GET and PUT
  // (e.g. a comment we just added, server-side automation, another tech), we
  // get ticket_updated_by_another_user. Re-fetch and retry once.
  private async putTicketUpdate(
    ticket_id: number,
    fields: Omit<UpdateTicketInput, "ticket_id" | "comment_body" | "comment_public">,
    isRetry: boolean
  ): Promise<void> {
    const current = await this.getTicket(ticket_id);
    const currentStatusId =
      typeof current.status === "object" && current.status !== null
        ? String(current.status.statusId)
        : current.status;

    const payload: Record<string, unknown> = {
      version: current.version,
      subject: fields.summary ?? current.subject,
      requesterUid: current.requesterUid,
      clientId: current.clientId,
      ticketFormId: current.ticketFormId,
      status: fields.status !== undefined
        ? await this.resolveStatus(fields.status)
        : currentStatusId,
      type: fields.type ?? current.type,
      priority: fields.priority ?? current.priority,
      severity: fields.severity ?? current.severity,
      assignedAppUserId: fields.assigned_app_user_id ?? current.assignedAppUserId,
      tags: fields.tags ?? current.tags ?? []
    };
    if (fields.attributes && Object.keys(fields.attributes).length > 0) {
      payload.attributes = fields.attributes;
    }
    for (const k of Object.keys(payload)) {
      if (payload[k] === undefined || payload[k] === null) delete payload[k];
    }

    try {
      await this.request<unknown>(`/ticketing/ticket/${ticket_id}`, "PUT", payload);
    } catch (err) {
      if (
        !isRetry &&
        err instanceof NinjaApiError &&
        err.resultCode === "ticket_updated_by_another_user"
      ) {
        // Stale version — re-fetch and retry once.
        return this.putTicketUpdate(ticket_id, fields, true);
      }
      throw err;
    }
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

  // Bulk-reset alerts for a source type. Destructive — guardrail-gated at the
  // tool layer.
  async resetAlertsBySource(sourceType: string): Promise<void> {
    await this.request<unknown>(`/alerts/${encodeURIComponent(sourceType)}/reset`, "POST");
  }

  // ── Device detail (Tier 1 expanders) ─────────────────────────────────────

  async getDeviceSoftware(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/software`, "GET");
  }

  async getDeviceOsPatches(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/os-patches`, "GET");
  }

  async getDeviceDisks(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/disks`, "GET");
  }

  async getDeviceVolumes(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/volumes`, "GET");
  }

  async getDeviceProcessors(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/processors`, "GET");
  }

  async getDeviceServices(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/windows-services`, "GET");
  }

  async getDeviceLastLoggedOnUser(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/last-logged-on-user`, "GET");
  }

  // ── Device writes ────────────────────────────────────────────────────────

  async setDeviceMaintenance(
    deviceId: number,
    input: { disabledFeatures: string[]; start?: number; end: number }
  ): Promise<void> {
    await this.request<unknown>(`/device/${deviceId}/maintenance`, "PUT", input);
  }

  async clearDeviceMaintenance(deviceId: number): Promise<void> {
    await this.request<unknown>(`/device/${deviceId}/maintenance`, "DELETE");
  }

  /** Destructive — gated at the tool layer. */
  async deleteDevice(deviceId: number): Promise<void> {
    await this.request<unknown>(`/device/${deviceId}`, "DELETE");
  }

  // ── Ticket destructive ───────────────────────────────────────────────────

  /** Destructive — gated at the tool layer. */
  async deleteTicket(ticketId: number): Promise<void> {
    await this.request<unknown>(`/ticketing/ticket/${ticketId}`, "DELETE");
  }

  // ── Users (technician listing) ───────────────────────────────────────────

  async listAllUsers(opts: { userType?: "TECHNICIAN" | "END_USER" } = {}): Promise<NinjaUser[]> {
    const path = opts.userType ? `/users?userType=${opts.userType}` : "/users";
    const data = await this.request<unknown>(path, "GET");
    return Array.isArray(data) ? (data as unknown[]).filter(isUser) : [];
  }

  // ── Billing ───────────────────────────────────────────────────────────────

  async listAgreements(orgId?: number): Promise<unknown> {
    const qs = orgId ? `?clientId=${orgId}` : "";
    return this.request<unknown>(`/billing/agreements${qs}`, "GET");
  }

  async getAgreement(agreementId: number): Promise<unknown> {
    return this.request<unknown>(`/billing/agreement/${agreementId}`, "GET");
  }

  async listInvoices(opts: { organizationId?: number; status?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.organizationId) params.set("clientId", String(opts.organizationId));
    if (opts.status) params.set("status", opts.status);
    const qs = params.toString();
    return this.request<unknown>(`/billing/invoices${qs ? `?${qs}` : ""}`, "GET");
  }

  async getInvoice(invoiceId: number): Promise<unknown> {
    return this.request<unknown>(`/billing/invoice/${invoiceId}`, "GET");
  }

  async listBillingProducts(): Promise<unknown> {
    return this.request<unknown>(`/billing/products`, "GET");
  }

  async listCustomerAccounts(): Promise<unknown> {
    return this.request<unknown>(`/billing/customer-accounts`, "GET");
  }

  // ── Vulnerability management ─────────────────────────────────────────────

  async listVulnerabilities(opts: {
    organizationId?: number;
    severity?: string;
    pageSize?: number;
  } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.organizationId) params.set("clientId", String(opts.organizationId));
    if (opts.severity) params.set("severity", opts.severity);
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    const qs = params.toString();
    return this.request<unknown>(`/vulnerabilities${qs ? `?${qs}` : ""}`, "GET");
  }

  async getVulnerability(cve: string): Promise<unknown> {
    return this.request<unknown>(`/vulnerability/${encodeURIComponent(cve)}`, "GET");
  }

  async listDeviceVulnerabilities(deviceId: number): Promise<unknown> {
    return this.request<unknown>(`/device/${deviceId}/vulnerabilities`, "GET");
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
      this.recordAudit(method, path, body, response.status, undefined, text);
      throw new NinjaApiError(method, path, response.status, text);
    }

    if (!response.ok) {
      const text = await safeText(response);
      const err = new NinjaApiError(method, path, response.status, text);
      this.recordAudit(method, path, body, response.status, err.resultCode, err.errorMessage ?? text);
      throw err;
    }

    this.recordAudit(method, path, body, response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Best-effort audit log. Skips GETs entirely; never throws. */
  private recordAudit(
    method: string,
    path: string,
    body: unknown,
    statusCode?: number,
    resultCode?: string,
    errorMessage?: string
  ): void {
    if (method === "GET") return;
    if (!this.auditDb) return;
    const ctx = getCurrentRequestContext();
    const actor =
      ctx?.auth.kind === "technician"
        ? { email: ctx.auth.email, source: "technician-token" }
        : ctx?.auth.kind === "shared-secret"
          ? { email: undefined, source: "shared-secret" }
          : { email: undefined, source: "open" };
    void this.auditDb.writeAudit({
      actorEmail: actor.email,
      actorSource: actor.source,
      method,
      path,
      statusCode,
      resultCode,
      payloadSummary: summarizePayload(body),
      errorMessage
    });
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
      const err = new NinjaApiError("POST", path, response.status, text);
      this.recordAudit("POST", path, "<multipart>", response.status, err.resultCode, err.errorMessage ?? text);
      throw err;
    }
    this.recordAudit("POST", path, "<multipart>", response.status);
  }
}

function summarizePayload(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body.slice(0, 500);
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return "<unserializable>";
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
