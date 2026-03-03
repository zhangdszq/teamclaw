import { Hono } from 'hono';
import {
  createSession,
  getSession,
  updateSession,
  recordMessage,
  resolvePendingPermission,
} from '../services/session.js';
import { runClaude, runCodex, stopSession, type ServerEvent } from '../services/runner.js';
import type { AgentProvider } from '../types.js';
import { loadAssistantsConfig } from '../../libs/assistants-config.js';

const agent = new Hono();

// Helper to safely parse JSON body
async function parseBody<T>(c: any): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    const data = await c.req.json();
    return { success: true, data };
  } catch {
    return { success: false, error: 'Invalid JSON body' };
  }
}

function applyAssistantContext(prompt: string, skillNames?: string[], persona?: string, assistantId?: string): string {
  const config = assistantId ? loadAssistantsConfig() : undefined;
  const assistant = config?.assistants.find((a: any) => a.id === assistantId);

  const sections: string[] = [];
  const name = assistant?.name;
  const p = persona || assistant?.persona;
  const identity = [name ? `你的名字是「${name}」。` : "", p?.trim() ?? ""].filter(Boolean).join("\n");
  if (identity) sections.push(`## 你的身份\n${identity}`);
  if (assistant?.coreValues?.trim()) sections.push(`## 核心价值观\n${assistant.coreValues.trim()}`);
  if (assistant?.relationship?.trim()) sections.push(`## 与用户的关系\n${assistant.relationship.trim()}`);
  if (assistant?.cognitiveStyle?.trim()) sections.push(`## 你的思维方式\n${assistant.cognitiveStyle.trim()}`);
  if (assistant?.operatingGuidelines?.trim()) sections.push(`## 操作规程\n${assistant.operatingGuidelines.trim()}`);
  if (config?.userContext?.trim()) sections.push(`## 关于用户\n${config.userContext.trim()}`);

  const normalized = (skillNames ?? []).map((s) => s.trim()).filter(Boolean);
  if (normalized.length > 0) sections.push(normalized.map((s) => `/${s}`).join("\n"));

  if (sections.length === 0) return prompt;
  return `${sections.join("\n\n")}\n\n${prompt}`;
}

// Helper to create SSE stream
function createSSEStream(
  sessionId: string,
  generator: AsyncGenerator<ServerEvent>
) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of generator) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
      } catch (error) {
        const errorEvent: ServerEvent = {
          type: 'runner.error',
          payload: {
            sessionId,
            message: error instanceof Error ? error.message : String(error),
          },
        };
        const data = `data: ${JSON.stringify(errorEvent)}\n\n`;
        controller.enqueue(encoder.encode(data));
      } finally {
        controller.close();
      }
    },
  });
}

// SSE Response headers
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// Start a new session with prompt
agent.post('/start', async (c) => {
  const body = await c.req.json<{
    cwd?: string;
    title: string;
    allowedTools?: string;
    prompt: string;
    externalSessionId?: string;
    provider?: AgentProvider;
    model?: string;
    assistantId?: string;
    assistantSkillNames?: string[];
    assistantPersona?: string;
  }>();

  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  if (!body.title) {
    return c.json({ error: 'title is required' }, 400);
  }

  const provider: AgentProvider = body.provider ?? 'claude';
  const effectivePrompt = applyAssistantContext(body.prompt, body.assistantSkillNames, body.assistantPersona, body.assistantId);

  // Create session with external ID if provided
  const session = createSession({
    cwd: body.cwd,
    title: body.title,
    allowedTools: body.allowedTools,
    prompt: body.prompt,
    externalId: body.externalSessionId,
    assistantId: body.assistantId,
    assistantSkillNames: body.assistantSkillNames,
  });
  session.provider = provider;
  session.model = body.model;

  // Update session status
  updateSession(session.id, {
    status: 'running',
    lastPrompt: body.prompt,
  });

  // Create event generator
  async function* eventGenerator(): AsyncGenerator<ServerEvent> {
    // Emit session status
    yield {
      type: 'session.status',
      payload: {
        sessionId: session.id,
        status: 'running',
        title: session.title,
        cwd: session.cwd,
      },
    };

    // Emit user prompt
    yield {
      type: 'stream.user_prompt',
      payload: {
        sessionId: session.id,
        prompt: body.prompt,
      },
    };

    // Record user prompt
    recordMessage(session.id, {
      type: 'user_prompt',
      prompt: body.prompt,
    });

    // Dispatch to correct runner based on provider
    const runnerOpts = {
      prompt: effectivePrompt,
      session,
      model: body.model,
      onSessionUpdate: (updates: Partial<typeof session>) => {
        updateSession(session.id, updates);
      },
    };

    if (provider === 'codex') {
      yield* runCodex(runnerOpts);
    } else {
      yield* runClaude(runnerOpts);
    }
  }

  const readable = createSSEStream(session.id, eventGenerator());
  return new Response(readable, { headers: SSE_HEADERS });
});

// Continue an existing session (stateless - accepts claudeSessionId directly)
agent.post('/continue', async (c) => {
  const body = await c.req.json<{
    sessionId: string;
    prompt: string;
    cwd?: string;
    title?: string;
    externalSessionId?: string;
    provider?: AgentProvider;
    model?: string;
  }>();

  if (!body.sessionId) {
    return c.json({ error: 'sessionId (claudeSessionId) is required' }, 400);
  }

  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  const continueProvider: AgentProvider = body.provider ?? 'claude';

  // Create a temporary session for this query with external ID
  const tempSession = createSession({
    cwd: body.cwd,
    title: body.title || 'Continued Session',
    prompt: body.prompt,
    externalId: body.externalSessionId,
  });
  tempSession.provider = continueProvider;
  tempSession.model = body.model;

  // Set the claudeSessionId for resuming
  tempSession.claudeSessionId = body.sessionId;

  // Update session status
  updateSession(tempSession.id, {
    status: 'running',
    lastPrompt: body.prompt,
  });

  // Create event generator
  async function* eventGenerator(): AsyncGenerator<ServerEvent> {
    // Emit session status
    yield {
      type: 'session.status',
      payload: {
        sessionId: tempSession.id,
        status: 'running',
        title: tempSession.title,
        cwd: tempSession.cwd,
      },
    };

    // Emit user prompt
    yield {
      type: 'stream.user_prompt',
      payload: {
        sessionId: tempSession.id,
        prompt: body.prompt,
      },
    };

    // Record user prompt
    recordMessage(tempSession.id, {
      type: 'user_prompt',
      prompt: body.prompt,
    });

    // Dispatch to correct runner based on provider
    const runnerOpts = {
      prompt: body.prompt,
      session: tempSession,
      resumeSessionId: body.sessionId,
      model: body.model,
      onSessionUpdate: (updates: Partial<typeof tempSession>) => {
        updateSession(tempSession.id, updates);
      },
    };

    if (continueProvider === 'codex') {
      yield* runCodex(runnerOpts);
    } else {
      yield* runClaude(runnerOpts);
    }
  }

  const readable = createSSEStream(tempSession.id, eventGenerator());
  return new Response(readable, { headers: SSE_HEADERS });
});

// Stop a running session
agent.post('/stop', async (c) => {
  const body = await c.req.json<{ sessionId: string }>();

  if (!body.sessionId) {
    return c.json({ error: 'sessionId is required' }, 400);
  }

  const session = getSession(body.sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Use externalId for stopping if available (matches controller tracking key)
  const trackingId = session.externalId || session.id;
  const stopped = stopSession(trackingId);
  console.log('[Agent] Stop request for session:', session.id, 'trackingId:', trackingId, 'stopped:', stopped);

  updateSession(session.id, { status: 'idle' });

  return c.json({
    stopped,
    sessionId: session.id,
    status: 'idle',
  });
});

// Handle permission response
agent.post('/permission', async (c) => {
  const body = await c.req.json<{
    sessionId: string;
    toolUseId: string;
    result: {
      behavior: 'allow' | 'deny';
      updatedInput?: unknown;
      message?: string;
    };
  }>();

  if (!body.sessionId || !body.toolUseId || !body.result) {
    return c.json({ error: 'sessionId, toolUseId, and result are required' }, 400);
  }

  const session = getSession(body.sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const resolved = resolvePendingPermission(
    body.sessionId,
    body.toolUseId,
    body.result
  );

  if (!resolved) {
    return c.json({ error: 'Permission request not found' }, 404);
  }

  return c.json({ resolved: true });
});

export { agent as agentRoutes };
