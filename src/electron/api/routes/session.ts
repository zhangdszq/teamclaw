import { Hono } from 'hono';
import {
  createSession,
  getSession,
  listSessions,
  getSessionHistory,
  deleteSession,
  listRecentCwds,
} from '../services/session.js';

const session = new Hono();

// List all sessions
session.get('/', (c) => {
  const sessions = listSessions();
  return c.json({ sessions });
});

// Get recent working directories
session.get('/recent-cwds', (c) => {
  const limit = Number(c.req.query('limit')) || 8;
  const cwds = listRecentCwds(limit);
  return c.json({ cwds });
});

// Create a new session
session.post('/', async (c) => {
  let body: {
    cwd?: string;
    title: string;
    allowedTools?: string;
    prompt?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.title) {
    return c.json({ error: 'title is required' }, 400);
  }

  const newSession = createSession({
    cwd: body.cwd,
    title: body.title,
    allowedTools: body.allowedTools,
    prompt: body.prompt,
  });

  return c.json({ session: newSession });
});

// Get session by ID
session.get('/:id', (c) => {
  const id = c.req.param('id');
  const sess = getSession(id);

  if (!sess) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ session: sess });
});

// Get session history
session.get('/:id/history', (c) => {
  const id = c.req.param('id');
  const history = getSessionHistory(id);

  if (!history) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json(history);
});

// Delete session
session.delete('/:id', (c) => {
  const id = c.req.param('id');
  const deleted = deleteSession(id);

  if (!deleted) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ deleted: true });
});

export { session as sessionRoutes };
