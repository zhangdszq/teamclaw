import { Hono } from 'hono';
import {
  createSession,
  getSession,
  updateSession,
  recordMessage,
  resolvePendingPermission,
} from '../services/session.js';
import { runClaude, stopSession, type ServerEvent } from '../services/runner.js';
import type { AgentProvider } from '../types.js';
import {
  applyAssistantContextToPrompt,
  resolveSkillPromptContext,
} from '../../libs/skill-context.js';

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
    assistantActivatedSkillContent?: string;
  }>();

  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  if (!body.title) {
    return c.json({ error: 'title is required' }, 400);
  }

  // Validate optional field: cwd (must be a non-empty string if provided)
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== 'string' || body.cwd.trim() === '') {
      return c.json({ error: 'cwd must be a non-empty string' }, 400);
    }
  }

  // Validate optional field: allowedTools (must be a non-empty string if provided)
  if (body.allowedTools !== undefined) {
    if (typeof body.allowedTools !== 'string' || body.allowedTools.trim() === '') {
      return c.json({ error: 'allowedTools must be a non-empty string' }, 400);
    }
  }

  // Validate optional field: model (must be a non-empty string if provided)
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      return c.json({ error: 'model must be a non-empty string' }, 400);
    }
  }

  // Validate optional field: assistantId (must be a non-empty string if provided)
  if (body.assistantId !== undefined) {
    if (typeof body.assistantId !== 'string' || body.assistantId.trim() === '') {
      return c.json({ error: 'assistantId must be a non-empty string' }, 400);
    }
  }

  // Validate optional field: assistantSkillNames (must be an array if provided)
  if (body.assistantSkillNames !== undefined) {
    if (!Array.isArray(body.assistantSkillNames)) {
      return c.json({ error: 'assistantSkillNames must be an array' }, 400);
    }
    for (const item of body.assistantSkillNames) {
      if (typeof item !== 'string') {
        return c.json({ error: 'assistantSkillNames must contain only strings' }, 400);
      }
    }
  }

  if (
    body.assistantActivatedSkillContent !== undefined &&
    typeof body.assistantActivatedSkillContent !== 'string'
  ) {
    return c.json({ error: 'assistantActivatedSkillContent must be a string' }, 400);
  }

  const provider: AgentProvider = body.provider ?? 'claude';
  const startSkillContext = body.assistantActivatedSkillContent
    ? {
        skillName: "",
        userText: body.prompt,
        skillContent: body.assistantActivatedSkillContent,
      }
    : resolveSkillPromptContext(body.prompt, body.assistantSkillNames);
  const effectiveUserPrompt = startSkillContext?.userText ?? body.prompt;
  const effectivePrompt = applyAssistantContextToPrompt(effectiveUserPrompt, {
    skillNames: body.assistantSkillNames,
    persona: body.assistantPersona,
    assistantId: body.assistantId,
    activatedSkillContent: startSkillContext?.skillContent,
  });

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

    yield* runClaude({ ...runnerOpts, provider: provider === 'openai' ? 'openai' : 'claude' });
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
    assistantId?: string;
    assistantSkillNames?: string[];
    assistantActivatedSkillContent?: string;
  }>();

  if (!body.sessionId) {
    return c.json({ error: 'sessionId (claudeSessionId) is required' }, 400);
  }

  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  // Validate optional field: cwd (must be a non-empty string if provided)
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== 'string' || body.cwd.trim() === '') {
      return c.json({ error: 'cwd must be a non-empty string' }, 400);
    }
  }

  // Validate optional field: title (must be a non-empty string if provided)
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return c.json({ error: 'title must be a non-empty string' }, 400);
    }
  }

  // Validate optional field: model (must be a non-empty string if provided)
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      return c.json({ error: 'model must be a non-empty string' }, 400);
    }
  }

  if (body.assistantId !== undefined) {
    if (typeof body.assistantId !== 'string' || body.assistantId.trim() === '') {
      return c.json({ error: 'assistantId must be a non-empty string' }, 400);
    }
  }

  if (body.assistantSkillNames !== undefined) {
    if (!Array.isArray(body.assistantSkillNames)) {
      return c.json({ error: 'assistantSkillNames must be an array' }, 400);
    }
    for (const item of body.assistantSkillNames) {
      if (typeof item !== 'string') {
        return c.json({ error: 'assistantSkillNames must contain only strings' }, 400);
      }
    }
  }

  if (
    body.assistantActivatedSkillContent !== undefined &&
    typeof body.assistantActivatedSkillContent !== 'string'
  ) {
    return c.json({ error: 'assistantActivatedSkillContent must be a string' }, 400);
  }

  const continueProvider: AgentProvider = body.provider ?? 'claude';
  const continueSkillContext = body.assistantActivatedSkillContent
    ? {
        skillName: "",
        userText: body.prompt,
        skillContent: body.assistantActivatedSkillContent,
      }
    : resolveSkillPromptContext(body.prompt, body.assistantSkillNames);
  const effectiveContinuePrompt = applyAssistantContextToPrompt(
    continueSkillContext?.userText ?? body.prompt,
    {
      skillNames: body.assistantSkillNames,
      assistantId: body.assistantId,
      activatedSkillContent: continueSkillContext?.skillContent,
    },
  );

  // Create a temporary session for this query with external ID
  const tempSession = createSession({
    cwd: body.cwd,
    title: body.title || 'Continued Session',
    prompt: body.prompt,
    externalId: body.externalSessionId,
    assistantId: body.assistantId,
    assistantSkillNames: body.assistantSkillNames,
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
      prompt: effectiveContinuePrompt,
      session: tempSession,
      resumeSessionId: body.sessionId,
      model: body.model,
      onSessionUpdate: (updates: Partial<typeof tempSession>) => {
        updateSession(tempSession.id, updates);
      },
    };

    yield* runClaude({ ...runnerOpts, provider: continueProvider === 'openai' ? 'openai' : 'claude' });
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
