import { spawn } from 'node:child_process';

async function run() {
  console.log('1. Starting OpenChamber server on port 3457...');
  const serverProc = spawn('bun', ['packages/web/server/index.js', '--port', '3457', '--host', '127.0.0.1'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });

  serverProc.stdout.on('data', (d) => {
    console.log('   [Server]', d.toString().trim());
  });

  serverProc.stderr.on('data', (d) => console.error('   [Server Err]', d.toString().trim()));

  // Wait for server ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:3457/api/health');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    serverProc.kill();
    throw new Error('Server failed to start within timeout');
  }
  console.log('2. Server is healthy on 127.0.0.1:3457');

  // Create session
  const createRes = await fetch('http://127.0.0.1:3457/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E Live Test', model: 'sonnet' }),
  });
  const created = await createRes.json();
  const sessionId = created.data.id;
  console.log('3. Created session:', sessionId);

  // Subscribe to SSE stream
  const eventStreamPromise = (async () => {
    const streamRes = await fetch(`http://127.0.0.1:3457/api/sessions/${sessionId}/stream`);
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let fullText = '';
    let thinkingDeltas = 0;
    let textDeltas = 0;
    let completed = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'session.reasoning.delta') {
              thinkingDeltas++;
              process.stdout.write('💭');
            } else if (ev.type === 'session.text.delta') {
              textDeltas++;
              fullText += ev.data.delta || '';
              process.stdout.write(ev.data.delta || '');
            } else if (ev.type === 'session.idle') {
              completed = true;
            }
          } catch {}
        }
      }
      if (completed) break;
    }
    return { fullText, thinkingDeltas, textDeltas };
  })();

  // Wait a moment for stream to be connected
  await new Promise((r) => setTimeout(r, 500));

  // Send prompt
  console.log('4. Sending prompt to Claude Code CLI...');
  const promptRes = await fetch(`http://127.0.0.1:3457/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Explain this project structure in one single sentence.',
      model: 'sonnet',
      effort: 'low',
    }),
  });
  console.log('   Prompt dispatched, status:', promptRes.status);

  // Await stream completion
  const streamResult = await eventStreamPromise;
  console.log('\n\n5. Live Streaming Verification Results:');
  console.log('   - Thinking deltas received:', streamResult.thinkingDeltas);
  console.log('   - Text deltas received:', streamResult.textDeltas);
  console.log('   - Final response:\n', streamResult.fullText.trim());

  // Check messages stored
  const messagesRes = await fetch(`http://127.0.0.1:3457/api/session/${sessionId}/message`);
  const messages = await messagesRes.json();
  console.log('6. Stored messages count:', messages.data.length);

  serverProc.kill();
  console.log('7. Test completed successfully!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
