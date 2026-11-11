// The app's data: roles, collections and actions (see CLAUDE.md, "Data"). Every collection becomes a
// table with id, org_id, owner_id, created_at and updated_at added for you.
import { defineApp } from '@kelay/sdk';

export const app = defineApp({
  app: 'starter-app',
  roles: ['admin', 'member'],
  collections: [
    {
      name: 'notes',
      label: 'Notes',
      fields: {
        title: { type: 'text', required: true },
        body: { type: 'text' },
      },
    },
  ],
});
