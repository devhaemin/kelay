import { describe, expect, it } from 'vitest';
import { KelayError } from './errors.ts';
import { requireUserToken, userTokenFromHeaders } from './server.ts';

const SIGV4 = 'AWS4-HMAC-SHA256 Credential=AKIA/20261111/ap-northeast-2/lambda/aws4_request, SignedHeaders=host, Signature=abc';

describe('userTokenFromHeaders', () => {
  it('reads the token the router moved to x-kelay-authorization on signed requests', () => {
    expect(userTokenFromHeaders(new Headers({ authorization: SIGV4, 'x-kelay-authorization': 'Bearer user.jwt' }))).toBe('user.jwt');
    expect(userTokenFromHeaders({ Authorization: SIGV4, 'X-Kelay-Authorization': ['Bearer user.jwt'] })).toBe('user.jwt');
  });

  it('falls back to authorization when the request was not signed', () => {
    expect(userTokenFromHeaders(new Headers({ authorization: 'bearer direct.jwt' }))).toBe('direct.jwt');
  });

  it('never mistakes a SigV4 signature for a user token', () => {
    expect(userTokenFromHeaders(new Headers({ authorization: SIGV4 }))).toBeNull();
    expect(userTokenFromHeaders({})).toBeNull();
    expect(() => requireUserToken({})).toThrow(KelayError);
  });
});
