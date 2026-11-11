# @kelay/sdk

What Kelay apps import. Screens reach data only through the Data API, using the signed-in user's Kelay ID token, so every call is subject to the app's RLS policy ([contracts §3, §5](../../docs/contracts.md)).

## Define the app

```ts
import { defineApp, type Row } from '@kelay/sdk';

export const app = defineApp({
  app: 'ticket-board',
  roles: ['admin', 'member', 'guest'],
  collections: [
    {
      name: 'tickets',
      shared: true,
      ownerField: 'assignee_id',
      fields: { title: { type: 'text', required: true }, status: { type: 'text', required: true }, assignee_id: { type: 'text' } },
    },
  ],
});

type Ticket = Row<typeof app, 'tickets'>;
// { id; org_id; owner_id; created_at; updated_at; shared: boolean; title: string; status: string; assignee_id?: string | null }
```

`defineApp`, `definePolicy` and `defineGraph` validate against the contracts and throw a `KelayError` (`invalid_request`) when the value is malformed. Pass the literal directly, or use `as const`, so field types are inferred.

## Read and write data

```ts
import { createKelayClient } from '@kelay/sdk';

const kelay = createKelayClient({
  dataApiUrl: process.env.DATA_API_URL!,
  app,
  getUserToken: () => session.token,
  getCallerToken: () => runtime.callerToken,
});

const tickets = kelay.collection('tickets');
await tickets.list({ where: { status: { in: ['todo', 'doing'] } }, orderBy: [{ field: 'created_at', dir: 'desc' }], limit: 50 });
await tickets.get(id); // row or null
await tickets.create({ title: 'Fix login', status: 'todo' });
await tickets.update(id, { status: 'done' }); // row, or null if no such row is visible
await tickets.remove(id); // true if a row was deleted
```

Every failure rejects with a `KelayError` that has `code` (a contract `ErrorCode`, or `network`), `status` and `message`. `error.isDenied()` is true when the user's role may not do this: RLS refused the write, or an update or delete matched a row the user can see but may not change.

## Screens can't crash on a denied action

Wrap user actions in `safeMutation`. It never throws; it resolves with a result you can switch on:

```ts
import { safeMutation } from '@kelay/sdk';

const result = await safeMutation(() => tickets.update(id, { status: 'done' }), {
  onDenied: (e) => toast(e.message), // e.g. "you can't move that ticket"
  onError: (e) => toast('Something went wrong'),
});

switch (result.status) {
  case 'ok':
    render(result.data);
    break;
  case 'denied':
    rollBack(); // undo the optimistic move and show why
    break;
  case 'error':
    showRetry(result.error);
    break;
}
```

Hide actions the role can never perform (for example, no drag handle on a ticket you can't move), and use `safeMutation` for the cases only the server can decide.

## React

`@kelay/sdk/react` needs `react` and `@tanstack/react-query`. Its hooks report `denied` and errors as state and never throw.

```tsx
import { KelayProvider, useCollection, useMutation } from '@kelay/sdk/react';

declare module '@kelay/sdk' {
  interface Register {
    app: typeof app; // types useCollection and useMutation
  }
}

<KelayProvider client={kelay}>
  <Board />
</KelayProvider>;

function Board() {
  const { rows, loading, denied } = useCollection('tickets', { where: { status: 'todo' } });
  const move = useMutation((k, id: string, status: string) => k.collection('tickets').update(id, { status }), {
    invalidates: ['tickets'],
  });
  // await move.mutate(id, 'done') resolves with { status: 'ok' | 'denied' | 'error' }; move.denied is set too.
}
```

## Feedback

```ts
import { sendFeedback } from '@kelay/sdk';

const { ticketId } = await sendFeedback({
  controlApiUrl: process.env.CONTROL_API_URL!,
  app,
  getUserToken,
  getCallerToken,
  text: 'The label is clipped',
  route: '/tickets/123',
});
```

This sends `POST {controlApiUrl}/v1/apps/:app/feedback` with `{ text, route?, context? }`. `ticketId` is the ticket's key, such as `FB-131`: the same key the builder sees on the Feedback board.

## On the server

Behind the Kelay router, requests to an app's function URL are signed with SigV4, which takes over `authorization`. The router moves the user's token to `x-kelay-authorization` ([contracts §4](../../docs/contracts.md)). Read it with the server helper, which checks that header first and `authorization` second:

```ts
import { requireUserToken } from '@kelay/sdk/server';

export async function handler(request: Request) {
  const userToken = requireUserToken(request.headers); // throws KelayError('unauthenticated') when absent
  const kelay = createKelayClient({ dataApiUrl, app, getUserToken: () => userToken, getCallerToken });
}
```
