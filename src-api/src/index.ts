import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';

import { agentRoutes } from './routes/agent.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/session.js';
import { initSessionStore, shutdownSessionStore } from './services/session.js';

const app = new Hono();

// Global middleware
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Routes
app.route('/health', healthRoutes);
app.route('/agent', agentRoutes);
app.route('/session', sessionRoutes);

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'DinoClaw API',
    version: '0.0.2',
    endpoints: {
      health: '/health',
      agent: '/agent',
      session: '/session',
    },
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Default port: 2620 for API server
const port = Number(process.env.PORT) || 2620;

// Store server instance for cleanup
let server: ServerType | null = null;

// Cleanup function
const cleanup = async () => {
  console.log('Shutting down API server...');
  
  try {
    await shutdownSessionStore();
  } catch (error) {
    console.error('Error shutting down session store:', error);
  }

  if (server) {
    server.close();
    server = null;
  }
  
  process.exit(0);
};

// Handle shutdown signals
process.on('SIGTERM', () => cleanup());
process.on('SIGINT', () => cleanup());

// Initialize and start server
async function start() {
  console.log(`🚀 DinoClaw API starting...`);

  // Initialize session store with data directory from env or default
  const dataDir = process.env.DATA_DIR || process.env.HOME + '/.vk-cowork';
  await initSessionStore(dataDir);

  console.log(`🚀 Server starting on http://localhost:${port}`);

  server = serve({
    fetch: app.fetch,
    port,
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
