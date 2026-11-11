// The MCP client ("personal assistant") the e2e suite connects with. Kelay ID identifies an MCP
// client by the HTTPS URL of its Client ID Metadata Document and only fetches public hosts, so the
// e2e Kelay ID process (identity-server.ts) answers for this one URL itself.
export const ASSISTANT_CLIENT_ID = 'https://assistant.example.com/oauth/client.json';
export const ASSISTANT_REDIRECT_URI = 'http://127.0.0.1:33418/callback';

export const ASSISTANT_METADATA = {
  client_id: ASSISTANT_CLIENT_ID,
  client_name: 'E2E Assistant',
  client_uri: 'https://assistant.example.com',
  redirect_uris: [ASSISTANT_REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
} as const;
