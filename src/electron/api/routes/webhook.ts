import { Hono } from 'hono';
import { loadAssistantsConfig } from '../../libs/assistants-config.js';
import { loadUserSettings } from '../../libs/user-settings.js';
import type { ClientEvent } from '../../types.js';

type SessionRunner = (event: ClientEvent) => Promise<void>;
let sessionRunner: SessionRunner | null = null;

export function setWebhookSessionRunner(fn: SessionRunner): void {
  sessionRunner = fn;
}

const webhook = new Hono();

/**
 * POST /webhook/:assistantId
 *
 * Trigger an agent session from an external system (GitHub, Jira, etc.)
 *
 * Body: { prompt: string, cwd?: string, title?: string, token?: string }
 * Headers: Authorization: Bearer <webhookToken>  (optional, if webhookToken is configured)
 */
webhook.post('/:assistantId', async (c) => {
  if (!sessionRunner) {
    return c.json({ error: 'Session runner not available' }, 503);
  }

  // Optional bearer token auth
  const settings = loadUserSettings();
  if (settings.webhookToken) {
    const authHeader = c.req.header('Authorization') ?? '';
    const bodyToken = (await c.req.json().catch(() => ({}))).token as string | undefined;
    const provided = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : bodyToken;

    if (provided !== settings.webhookToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  let body: { prompt?: string; cwd?: string; title?: string; token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { prompt, cwd, title } = body;
  if (!prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  const assistantId = c.req.param('assistantId');

  // Look up assistant config
  const config = loadAssistantsConfig();
  const assistant = assistantId
    ? config.assistants.find(a => a.id === assistantId)
    : config.assistants.find(a => a.id === config.defaultAssistantId) ?? config.assistants[0];

  if (assistantId && !assistant) {
    return c.json({ error: `Assistant "${assistantId}" not found` }, 404);
  }

  const sessionTitle = title ?? `Webhook: ${prompt.slice(0, 40).trim()}`;

  try {
    await sessionRunner({
      type: 'session.start',
      payload: {
        title: sessionTitle,
        prompt,
        cwd: cwd || assistant?.defaultCwd,
        assistantId: assistant?.id,
        assistantSkillNames: assistant?.skillNames ?? [],
        assistantPersona: assistant?.persona,
        provider: assistant?.provider ?? 'claude',
        model: assistant?.model,
        sourceType: 'system',
        sourceChannel: 'webhook',
      },
    });

    return c.json({ status: 'started', assistant: assistant?.name ?? 'default' });
  } catch (err) {
    console.error('[Webhook] Failed to start session:', err);
    return c.json({ error: 'Failed to start session' }, 500);
  }
});

export { webhook as webhookRoutes };
