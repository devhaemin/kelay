// A2A agent card for one app (A2A specification 1.0, §4.4 AgentCard and §8.5 sample card).
// Skills mirror the MCP tools: one per collection and one per action.
import type { AppSchema, CollectionDef } from '@kelay/contracts';
import { SCOPES, type AppUrls } from './auth.ts';
import { fieldAbout, nounOf } from './tools.ts';

export const A2A_PROTOCOL_VERSION = '1.0';

export interface OAuthEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  /** RFC 8414 authorization server metadata. */
  metadataUrl: string;
}

const fieldSummary = (c: CollectionDef): string =>
  Object.entries(c.fields)
    .map(([name, f]) => `${name} (${fieldAbout(f)})`)
    .join(', ');

export function buildAgentCard(opts: { schema: AppSchema; urls: AppUrls; version: string; oauth: OAuthEndpoints }) {
  const { schema, urls, oauth } = opts;
  const collectionSkills = schema.collections.map((c) => {
    const { one, many } = nounOf(c);
    return {
      id: c.name,
      name: c.label ?? many,
      description: `List, read, create, update and delete ${many} you have access to. Fields of a ${one}: ${fieldSummary(c)}.`,
      tags: ['collection', c.name],
      examples: [`List my ${many}`, `Create a ${one}`],
    };
  });
  const actionSkills = (schema.actions ?? []).map((a) => ({
    id: `action_${a.name}`,
    name: a.name.replaceAll('_', ' '),
    description: a.description,
    tags: ['action'],
  }));
  return {
    name: schema.app,
    description: `The ${schema.app} app on Kelay. Every call runs as the signed-in user, under that user's role and plan. MCP clients can also connect at ${urls.resource}.`,
    supportedInterfaces: [{ url: urls.a2a, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    version: opts.version,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      kelayId: {
        oauth2SecurityScheme: {
          description: 'Kelay ID, the account people use for every Kelay app.',
          oauth2MetadataUrl: oauth.metadataUrl,
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorizationUrl,
              tokenUrl: oauth.tokenUrl,
              scopes: SCOPES,
              pkceRequired: true,
            },
          },
        },
      },
    },
    securityRequirements: [{ schemes: { kelayId: { list: ['openid'] } } }],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [...collectionSkills, ...actionSkills],
  };
}

/** RFC 8414 §3: the well-known segment goes between the issuer's origin and its path. */
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}
