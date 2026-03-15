/**
 * Memory API routes
 * Provides CRUD endpoints for the three-layer memory system:
 *   - Shared user layer (MEMORY.md)
 *   - Shared knowledge layer (sops/ + daily/)
 *   - Per-assistant layer (assistants/{id}/)
 *
 * Pass ?assistantId=xxx to scope per-assistant operations.
 */
import { Hono } from 'hono';
import {
  readLongTermMemory,
  writeLongTermMemory,
  readDailyMemory,
  appendDailyMemory,
  writeDailyMemory,
  listDailyMemories,
  buildMemoryContext,
  getMemoryDir,
  getMemorySummary,
  ScopedMemory,
  isConfiguredAssistantId,
  validateMemoryEntry,
} from '../../libs/memory-store.js';

export const memoryRoutes = new Hono();

function getScopedMemory(c: { req: { query: (k: string) => string | undefined } }): ScopedMemory | null {
  const assistantId = c.req.query('assistantId');
  if (assistantId && !isConfiguredAssistantId(assistantId)) {
    throw new Error(`Unknown assistantId: ${assistantId}`);
  }
  return assistantId ? new ScopedMemory(assistantId) : null;
}

// GET /memory — full assembled memory context
memoryRoutes.get('/', async (c) => {
  try {
    const assistantId = c.req.query('assistantId');
    if (assistantId && !isConfiguredAssistantId(assistantId)) {
      return c.json({ error: 'Invalid assistantId' }, 400);
    }
    const context = await buildMemoryContext(assistantId);
    const scoped = getScopedMemory(c);
    const summary = scoped ? scoped.getMemorySummary() : getMemorySummary();
    return c.json({ context, summary, memoryDir: getMemoryDir() });
  } catch (error) {
    return c.json({ error: 'Failed to read memory', message: String(error) }, 500);
  }
});

// GET /memory/long-term — raw MEMORY.md content (shared)
memoryRoutes.get('/long-term', (c) => {
  try {
    const content = readLongTermMemory();
    return c.json({ content });
  } catch (error) {
    return c.json({ error: 'Failed to read long-term memory', message: String(error) }, 500);
  }
});

// PUT /memory/long-term — overwrite MEMORY.md (shared)
memoryRoutes.put('/long-term', async (c) => {
  try {
    const { content } = await c.req.json<{ content: string }>();
    writeLongTermMemory(content);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: 'Failed to write long-term memory', message: String(error) }, 500);
  }
});

// GET /memory/daily/:date? — get shared daily memory (defaults to today)
memoryRoutes.get('/daily/:date?', (c) => {
  try {
    const date = c.req.param('date') ?? new Date().toISOString().slice(0, 10);
    const content = readDailyMemory(date);
    return c.json({ date, content });
  } catch (error) {
    return c.json({ error: 'Failed to read daily memory', message: String(error) }, 500);
  }
});

// POST /memory/daily — append to today's shared daily memory
memoryRoutes.post('/daily', async (c) => {
  try {
    const { content, date } = await c.req.json<{ content: string; date?: string }>();
    const validation = validateMemoryEntry(content, { allowMarkdownBlocks: true, maxChars: 20_000 });
    if (!validation.ok) {
      return c.json({ error: validation.message ?? 'Invalid daily memory content' }, 400);
    }
    appendDailyMemory(validation.normalized, date);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: 'Failed to append daily memory', message: String(error) }, 500);
  }
});

// PUT /memory/daily/:date — overwrite a specific shared daily memory
memoryRoutes.put('/daily/:date', async (c) => {
  try {
    const date = c.req.param('date');
    const { content } = await c.req.json<{ content: string }>();
    writeDailyMemory(content, date);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: 'Failed to write daily memory', message: String(error) }, 500);
  }
});

// GET /memory/list — list all memory files
memoryRoutes.get('/list', (c) => {
  try {
    const scoped = getScopedMemory(c);
    const dailies = listDailyMemories();
    const longTerm = readLongTermMemory();
    return c.json({
      memoryDir: getMemoryDir(),
      longTermExists: longTerm.length > 0,
      longTermSize: longTerm.length,
      dailies,
      assistantDailies: scoped ? scoped.listDailies() : [],
    });
  } catch (error) {
    return c.json({ error: 'Failed to list memories', message: String(error) }, 500);
  }
});
