// Platform file, do not edit. The one Kelay client of this app. Calls go to this app's own /api/kelay
// route, which adds the signed-in person's token and the app's caller token on the server; neither is
// ever available to browser code.
import { createKelayClient } from '@kelay/sdk';
import { app } from '../kelay/schema';

declare module '@kelay/sdk' {
  interface Register {
    app: typeof app;
  }
}

const onServer = () => 'added-on-the-server';

export const kelay = createKelayClient({ dataApiUrl: '/api/kelay', app, getUserToken: onServer, getCallerToken: onServer });
