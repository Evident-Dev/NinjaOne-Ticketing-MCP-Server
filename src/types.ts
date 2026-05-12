export interface NinjaOrganization {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface CreateTicketInput {
  organization_name?: string;
  organization_id?: number;
  subject: string;
  description: string;
  priority?: string;
  requester_email?: string;
  form_id?: number;
  board_id?: number;
}

export interface NinjaTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}
