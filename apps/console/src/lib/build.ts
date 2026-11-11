export const DEFAULT_PROMPT =
  'A Jira-style ticket board for my team: To do, In progress, Review and Done columns, assignees, comments, and drag to move tickets.';

export interface BuildPlan {
  /** The Builder's first reply in the chat panel. */
  reply: string;
  /** Steps the Building stage shows while the Builder workspace creates the first version. */
  steps: string[];
}

const BOARD_PLAN: BuildPlan = {
  reply: 'On it. I’ll make a board with four columns, tickets with assignees and comments, and drag to move.',
  steps: ['Understood the request', 'Created data: tickets, comments, projects', 'Generated the board screen', 'Dev preview ready'],
};

const GENERIC_PLAN: BuildPlan = {
  reply: 'On it. I’ll plan the data, wire the actions and generate the first screen.',
  steps: ['Understood the request', 'Created the data model', 'Generated the first screen', 'Dev preview ready'],
};

/** The prototype's copy describes a ticket board, so other prompts get neutral wording. */
export const buildPlan = (prompt: string): BuildPlan => (/ticket|jira|kanban|board/i.test(prompt) ? BOARD_PLAN : GENERIC_PLAN);
