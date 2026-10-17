import express from 'express';
import { registerEngineRoutes } from '../packages/web/server/lib/engine/routes.js';
import { createEngineRegistry } from '../packages/web/server/lib/engine/registry.js';
import { createClaudeEngine } from '../packages/web/server/lib/engine/claude/adapter.js';
import { detectClaudeInstallation, resolvePackageManager, ClaudeInstaller } from '../packages/web/server/lib/engine/claude/installer.js';

async function main() {
  console.log('--- Testing Claude Code Auto-Installer Detection & Resolution ---');

  // 1. Direct detection test
  const detection = detectClaudeInstallation();
  console.log('Detection result:', JSON.stringify(detection, null, 2));

  // 2. Package manager resolution test
  const pm = resolvePackageManager();
  console.log('Package manager resolution:', JSON.stringify(pm, null, 2));

  // 3. API Routes test via Express
  console.log('\n--- Testing API Endpoints ---');
  const app = express();
  app.use(express.json());

  const installer = new ClaudeInstaller();
  registerEngineRoutes(app, { registry: createEngineRegistry([createClaudeEngine({ installer })]) });

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Test GET /api/engine/status
    const statusRes = await fetch(`${baseUrl}/api/engine/status`);
    const statusData = await statusRes.json();
    console.log('GET /api/engine/status:', statusData);
    if (!statusData.engine || statusData.engine !== 'claude') {
      throw new Error('Invalid engine returned');
    }

    // Test GET /api/codecli/compatibility
    const compatRes = await fetch(`${baseUrl}/api/codecli/compatibility`);
    const compatData = await compatRes.json();
    console.log('GET /api/codecli/compatibility:', compatData);
    if (!['compatible', 'incompatible'].includes(compatData.state)) {
      throw new Error(`Unexpected compatibility state: ${compatData.state}`);
    }

    // Test SSE Stream /api/engine/install/stream
    console.log('\n--- Testing SSE Log Streaming ---');
    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/engine/install/stream`, {
      signal: controller.signal,
    });

    if (streamRes.headers.get('content-type') !== 'text/event-stream') {
      throw new Error('Not an SSE stream');
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();

    // Trigger mock log
    setTimeout(() => {
      installer._appendLog('stdout', 'npm notice mock downloading @anthropic-ai/claude-code...\n');
    }, 50);

    let chunksReceived = 0;
    while (chunksReceived < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      console.log('Received SSE chunk:', text.trim());
      chunksReceived++;
    }

    controller.abort();
    console.log('\n[SUCCESS] Claude Code Auto-Installer backend verified cleanly!');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('[FAILED]', err);
  process.exit(1);
});
