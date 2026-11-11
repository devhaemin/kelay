// Who may do what: role → collection → operation → scope (all | mine | mine_shared | none).
// Kelay turns this into Postgres row-level security; an entry that is missing means "none".
import { definePolicy } from '@kelay/sdk';

export const policy = definePolicy({
  admin: {
    notes: { read: 'all', create: 'all', update: 'all', delete: 'all' },
  },
  member: {
    notes: { read: 'all', create: 'all', update: 'mine', delete: 'mine' },
  },
});
