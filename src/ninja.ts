import type { AppConfig } from "./config.js";
import type { CreateTicketInput, NinjaOrganization, NinjaTokenResponse } from "./types.js";

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class NinjaClient {
  private token?: CachedToken;

  constructor(private readonly config: AppConfig) {}

  async testConnection(): Promise<{ ok: boolean; orgCount: number }> {
    const orgs = await this.getOrganizations();
    return { ok: true, orgCount: orgs.length };
  }

  async getOrganizations(): Promise<NinjaOrganization[]> {
    const data = await this.request<unknown>("/organizations", "GET");

    // Ninja normally returns an array here, but this keeps us from faceplanting if it changes.
    if (Array.isArray(data)) {
      return data.filter(isOrganization);
    }

    if (isRecord(data) && Array.isArray(data.results)) {
      return data.results.filter(isOrganization);
    }

    return [];
  }

  async findOrganizations(query: string, limit = 10): Promise<NinjaOrganization[]> {
    const cleaned = query.trim().toLowerCase();
    const orgs = await this.getOrganizations();

    return orgs
      .filter((org) => org.name.toLowerCase().includes(cleaned))
      .sort((a, b) => scoreOrgMatch(a.name, cleaned) - scoreOrgMatch(b.name, cleaned))
      .slice(0, limit);
  }

  async listTicketForms(): Promise<unknown> {
    return this.request<unknown>("/ticketing/ticket-form", "GET");
  }

  async listTicketBoards(): Promise<unknown> {
    return this.request<unknown>("/ticketing/board", "GET");
  }

  async createTicket(input: CreateTicketInput): Promise<unknown> {
    const organizationId = await this.resolveOrganizationId(input);
    const payload = buildTicketPayload(input, organizationId, this.config);

    return this.request<unknown>("/ticketing/ticket", "POST", payload);
  }

  private async resolveOrganizationId(input: CreateTicketInput): Promise<number> {
    if (input.organization_id) return input.organization_id;
    if (!input.organization_name) {
      throw new Error("Provide organization_id or organization_name.");
    }

    const matches = await this.findOrganizations(input.organization_name, 5);

    if (matches.length === 0) {
      throw new Error(`No NinjaOne organization matched '${input.organization_name}'.`);
    }

    const exactMatches = matches.filter(
      (org) => org.name.toLowerCase() === input.organization_name!.trim().toLowerCase()
    );

    if (exactMatches.length === 1) return exactMatches[0].id;

    if (matches.length === 1) return matches[0].id;

    // Better to be annoying than create a ticket for the wrong client.
    const options = matches.map((org) => `${org.name} (${org.id})`).join(", ");
    throw new Error(`Multiple organizations matched '${input.organization_name}'. Pick one by organization_id: ${options}`);
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 60_000) {
      return this.token.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.ninjaClientId,
      client_secret: this.config.ninjaClientSecret
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
      throw new Error(`NinjaOne token request failed: ${response.status} ${await safeText(response)}`);
    }

    const tokenData = (await response.json()) as NinjaTokenResponse;
    if (!tokenData.access_token) {
      throw new Error("NinjaOne token response did not include access_token.");
    }

    const expiresInSeconds = tokenData.expires_in ?? 3600;
    this.token = {
      accessToken: tokenData.access_token,
      expiresAtMs: now + expiresInSeconds * 1000
    };

    return this.token.accessToken;
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
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
      throw new Error(`NinjaOne API request failed: ${method} ${path} ${response.status} ${await safeText(response)}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function buildTicketPayload(input: CreateTicketInput, organizationId: number, config: AppConfig): Record<string, unknown> {
  const formId = input.form_id ?? config.defaultTicketFormId;
  const boardId = input.board_id ?? config.defaultBoardId;

  const payload: Record<string, unknown> = {
    organizationId,
    subject: input.subject,
    description: input.description
  };

  if (formId) payload.formId = formId;
  if (boardId) payload.boardId = boardId;
  if (input.priority) payload.priority = input.priority;

  // Heads up: requester fields may vary by tenant/form. We keep this simple for the first pass.
  if (input.requester_email) payload.requesterEmail = input.requester_email;

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOrganization(value: unknown): value is NinjaOrganization {
  return isRecord(value) && typeof value.id === "number" && typeof value.name === "string";
}

function scoreOrgMatch(name: string, query: string): number {
  const lower = name.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  return 2;
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 2000);
  } catch {
    return "<unable to read response body>";
  }
}
