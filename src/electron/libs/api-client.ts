/**
 * API client for communicating with the embedded API server
 */
import { getApiBaseUrl, isEmbeddedApiRunning, startEmbeddedApi } from '../api/server.js';
import type { ServerEvent } from '../types.js';
import { fetch as undiciFetch, Agent } from 'undici';

// Use undici directly for SSE requests to disable body timeout (prevents UND_ERR_BODY_TIMEOUT
// during long-running Claude agent tasks where the stream may be idle for minutes).
const noTimeoutAgent = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

async function sseFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  // @ts-ignore — undici Blob type conflicts with global Blob in strict TS; works at runtime
  return undiciFetch(url, {
    ...init,
    dispatcher: noTimeoutAgent,
    signal,
  }) as unknown as Response;
}

// Ensure embedded API is running
async function ensureEmbeddedApi(): Promise<void> {
  if (!isEmbeddedApiRunning()) {
    const started = await startEmbeddedApi();
    if (!started) {
      throw new Error('Failed to start embedded API server');
    }
  }
}

// Generic fetch with retry
async function apiFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  await ensureEmbeddedApi();
  
  const url = `${getApiBaseUrl()}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  return response;
}

// Health check
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await apiFetch('/health');
    return response.ok;
  } catch {
    return false;
  }
}

// Session APIs

export async function listSessions(): Promise<unknown[]> {
  const response = await apiFetch('/session');
  const data = await response.json();
  return data.sessions || [];
}

export async function getRecentCwds(limit?: number): Promise<string[]> {
  const url = limit ? `/session/recent-cwds?limit=${limit}` : '/session/recent-cwds';
  const response = await apiFetch(url);
  const data = await response.json();
  return data.cwds || [];
}

export async function getSessionHistory(sessionId: string): Promise<unknown> {
  const response = await apiFetch(`/session/${sessionId}/history`);
  if (!response.ok) {
    throw new Error('Session not found');
  }
  return response.json();
}

export async function deleteSessionApi(sessionId: string): Promise<boolean> {
  const response = await apiFetch(`/session/${sessionId}`, {
    method: 'DELETE',
  });
  return response.ok;
}

// Agent APIs with SSE streaming

export type StreamCallback = (event: ServerEvent) => void;

// Track active streams for cancellation
const activeStreams = new Map<string, AbortController>();

export function cancelStream(sessionId: string): void {
  const controller = activeStreams.get(sessionId);
  if (controller) {
    console.log('[API Client] Cancelling stream for session:', sessionId);
    controller.abort();
    activeStreams.delete(sessionId);
  }
}

export async function startSession(
  options: {
    cwd?: string;
    title: string;
    allowedTools?: string;
    prompt: string;
    externalSessionId?: string;  // Pass Electron's session ID for stop tracking
    provider?: string;
    model?: string;
    assistantId?: string;
    assistantSkillNames?: string[];
    assistantPersona?: string;
  },
  onEvent: StreamCallback
): Promise<void> {
  await ensureEmbeddedApi();

  const url = `${getApiBaseUrl()}/agent/start`;
  const abortController = new AbortController();
  const REQUEST_TIMEOUT_MS = 120000; // 2 minutes timeout

  // Track this stream if we have an external ID
  if (options.externalSessionId) {
    activeStreams.set(options.externalSessionId, abortController);
  }

  // Set up timeout
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start session');
    }

    // Handle SSE stream
    await handleSSEStream(response, onEvent, abortController.signal);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error('Request timeout - the server took too long to respond');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (options.externalSessionId) {
      activeStreams.delete(options.externalSessionId);
    }
  }
}

export async function continueSession(
  claudeSessionId: string,
  prompt: string,
  onEvent: StreamCallback,
  options?: { cwd?: string; title?: string; externalSessionId?: string; provider?: string; model?: string }
): Promise<void> {
  await ensureEmbeddedApi();

  const url = `${getApiBaseUrl()}/agent/continue`;
  const abortController = new AbortController();
  
  // Track this stream if we have an external ID
  if (options?.externalSessionId) {
    activeStreams.set(options.externalSessionId, abortController);
  }
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: claudeSessionId,  // This is the claudeSessionId for resuming
        prompt,
        cwd: options?.cwd,
        title: options?.title,
        externalSessionId: options?.externalSessionId,
        provider: options?.provider,
        model: options?.model,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to continue session');
    }

    // Handle SSE stream
    await handleSSEStream(response, onEvent, abortController.signal);
  } finally {
    if (options?.externalSessionId) {
      activeStreams.delete(options.externalSessionId);
    }
  }
}

export async function stopSession(sessionId: string): Promise<void> {
  // First cancel the local SSE stream
  cancelStream(sessionId);
  
  // Then tell embedded API to stop
  await apiFetch('/agent/stop', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export async function sendPermissionResponse(
  sessionId: string,
  toolUseId: string,
  result: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }
): Promise<void> {
  await apiFetch('/agent/permission', {
    method: 'POST',
    body: JSON.stringify({ sessionId, toolUseId, result }),
  });
}

// SSE stream handler
async function handleSSEStream(
  response: Response,
  onEvent: StreamCallback,
  signal?: AbortSignal
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    console.error('[API Client] No response body');
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  console.log('[API Client] Starting SSE stream processing');

  // Handle abort signal
  const abortHandler = () => {
    console.log('[API Client] Stream aborted, cancelling reader');
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abortHandler);

  try {
    while (true) {
      // Check if aborted
      if (signal?.aborted) {
        console.log('[API Client] Stream aborted, breaking loop');
        break;
      }

      const { done, value } = await reader.read();
      
      if (done) {
        console.log('[API Client] SSE stream ended');
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      console.log('[API Client] Received chunk:', chunk.length, 'bytes');
      buffer += chunk;

      // Process complete SSE messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const event = JSON.parse(data) as ServerEvent;
            console.log('[API Client] SSE event:', event.type);
            onEvent(event);
          } catch (error) {
            console.error('[API Client] Failed to parse SSE event:', error, data);
          }
        }
      }
    }
  } catch (error) {
    // Ignore abort errors
    if ((error as Error).name === 'AbortError') {
      console.log('[API Client] Stream aborted');
      return;
    }
    // undici body timeout — the SSE connection went idle for too long (default 300s).
    // Treat as a graceful stream end so the session result is not lost.
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code === 'UND_ERR_BODY_TIMEOUT') {
      console.warn('[API Client] SSE body timeout — treating as stream end');
      return;
    }
    console.error('[API Client] SSE stream error:', error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    console.log('[API Client] Releasing reader lock');
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released
    }
  }
}
