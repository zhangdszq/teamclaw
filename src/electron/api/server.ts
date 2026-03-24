/**
 * DinoClaw 内嵌 API 服务
 * This replaces the external sidecar process
 */

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { app as electronApp } from 'electron';

import { agentRoutes } from './routes/agent.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/session.js';
import { memoryRoutes } from './routes/memory.js';
import { webhookRoutes, setWebhookSessionRunner } from './routes/webhook.js';
import { initSessionStore, shutdownSessionStore } from './services/session.js';

export { setWebhookSessionRunner };

const honoApp = new Hono();

// Global middleware
honoApp.use('*', logger());
honoApp.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Routes
honoApp.route('/health', healthRoutes);
honoApp.route('/agent', agentRoutes);
honoApp.route('/session', sessionRoutes);
honoApp.route('/memory', memoryRoutes);
honoApp.route('/webhook', webhookRoutes);

// Root endpoint
honoApp.get('/', (c) => {
  return c.json({
    name: 'DinoClaw API（内嵌）',
    version: '0.0.4',
    endpoints: {
      health: '/health',
      agent: '/agent',
      session: '/session',
      memory: '/memory',
      webhook: '/webhook/:assistantId',
    },
  });
});

// 404 handler
honoApp.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
honoApp.onError((err, c) => {
  console.error('[API] Server error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Server state
let server: ServerType | null = null;
const DEFAULT_PORT = 2620;

/**
 * Start the embedded API server
 */
export async function startEmbeddedApi(port: number = DEFAULT_PORT): Promise<boolean> {
  if (server) {
    console.log('[API] Server already running');
    return true;
  }

  try {
    // Initialize session store
    const dataDir = electronApp.getPath('userData');
    await initSessionStore(dataDir);

    // Set up bundled CLI path for packaged app
    if (electronApp.isPackaged) {
      const { join } = await import('path');
      const { existsSync } = await import('fs');
      const cliBundlePath = join(process.resourcesPath, 'cli-bundle');
      const cliMjsPath = join(cliBundlePath, 'claude.mjs');
      
      if (existsSync(cliMjsPath)) {
        process.env.CLAUDE_CLI_PATH = cliMjsPath;
        // Add cli-bundle to PATH so node.exe can be found
        const pathSeparator = process.platform === 'win32' ? ';' : ':';
        process.env.PATH = cliBundlePath + pathSeparator + (process.env.PATH || '');
        console.log('[API] Bundled CLI path set:', cliMjsPath);
      } else {
        console.warn('[API] Bundled CLI not found at:', cliMjsPath);
      }
    }

    // Apply user settings to environment
    try {
      const { loadUserSettings } = await import('../libs/user-settings.js');
      const settings = loadUserSettings();

      if (settings.anthropicAuthToken) {
        process.env.ANTHROPIC_API_KEY = settings.anthropicAuthToken;
      }
      if (settings.anthropicBaseUrl) {
        process.env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
      }
      if (settings.anthropicModel) {
        process.env.ANTHROPIC_MODEL = settings.anthropicModel;
      }
      // Proxy settings
      if (settings.proxyEnabled && settings.proxyUrl) {
        process.env.PROXY_URL = settings.proxyUrl;
        process.env.HTTP_PROXY = settings.proxyUrl;
        process.env.HTTPS_PROXY = settings.proxyUrl;
        process.env.ALL_PROXY = settings.proxyUrl;
        process.env.http_proxy = settings.proxyUrl;
        process.env.https_proxy = settings.proxyUrl;
        process.env.all_proxy = settings.proxyUrl;
      }
    } catch (error) {
      console.error('[API] Failed to load user settings:', error);
    }

    console.log(`[API] Starting embedded server on port ${port}...`);

    // Wrap in a promise to properly catch listen errors
    return new Promise((resolve) => {
      try {
        server = serve({
          fetch: honoApp.fetch,
          port,
        });

        // Add error handler for the server
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            console.error(`[API] Port ${port} is already in use`);
          } else {
            console.error('[API] Server error:', err);
          }
          server = null;
          resolve(false);
        });

        server.on('listening', () => {
          console.log(`[API] Embedded server started on http://localhost:${port}`);
          resolve(true);
        });
      } catch (error) {
        console.error('[API] Failed to start embedded server:', error);
        resolve(false);
      }
    });
  } catch (error) {
    console.error('[API] Failed to start embedded server:', error);
    return false;
  }
}

/**
 * Stop the embedded API server
 */
export async function stopEmbeddedApi(): Promise<void> {
  console.log('[API] Stopping embedded server...');

  try {
    await shutdownSessionStore();
  } catch (error) {
    console.error('[API] Error shutting down session store:', error);
  }

  if (server) {
    server.close();
    server = null;
    console.log('[API] Embedded server stopped');
  }
}

/**
 * Check if the embedded API server is running
 */
export function isEmbeddedApiRunning(): boolean {
  return server !== null;
}

/**
 * Get the API base URL
 */
export function getApiBaseUrl(port: number = DEFAULT_PORT): string {
  return `http://localhost:${port}`;
}
