// The OpenCode 2.x permission request the UI renders: `action` is the tool,
// `resources` what it touches, `metadata.input` the full call.
export const toPermissionRequest = (sessionId, request) => {
  const input = request.input || {};
  const resource = input.command || input.file_path || input.path || input.url || input.pattern;
  return {
    id: request.requestId,
    sessionID: sessionId,
    action: request.toolName || 'tool',
    resources: resource ? [String(resource)] : [],
    save: ['*'],
    metadata: { input },
    message: request.summary || `${request.toolName || 'A tool'} wants to run`,
  };
};
