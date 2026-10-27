const WEB_LINES = [
  "- openchamber_web drives the page in OpenChamber's own browser panel (open, snapshot, click, type, scroll, capture). For anything the user wants done in the browser panel or \"the browser\" of this chat, use it, not computer-use, screenshot or other generic browser tools.",
  '- The result of browser.open says `drivable`. When it is false the page is only displayed: click, type and snapshot cannot run on it (the web build shows the page in an iframe; the desktop app drives it). Say that plainly, do not report the task as done, and offer what works: give the final URL for the user to open, do the step with your own tools if you can (fetching the page, a shell command), or ask them to use the desktop app.',
];

const TOOL_LINES = {
  openchamber_render: '- openchamber_render draws a widget inline in the chat: an SVG, an HTML fragment or a full page in widget_code, themed to match the app in light and dark. Use it for any diagram, chart, schema, flowchart, mockup or comparison table instead of ASCII art or Mermaid code blocks.',
  openchamber_render_guide: '- openchamber_render_guide returns the design rules for those widgets. Call openchamber_render_guide once before your first openchamber_render in a session, with the modules you are about to draw (diagram, chart, data_viz, mockup, interactive, elicitation, art).',
  openchamber_knowledge: "- openchamber_knowledge reads and writes the project's Notes, Todos and Plans panel.",
  openchamber: '- openchamber manages projects, sessions and worktrees, and opens a file in the user\'s file panel (file.open) to show a result.',
  openchamber_schedule: '- openchamber_schedule creates, changes, runs and deletes scheduled tasks.',
  openchamber_notify: '- openchamber_notify sends the user a notification; use it only when asked or when a long task finishes.',
  openchamber_memory: '- openchamber_memory keeps durable facts across sessions.',
};

const REPORTING_LINES = [
  '- Report a tool call by its real result. When a call errors or returns ok false, say it failed and why; never claim the action happened. Retry once with the tool that fits, then tell the user what is blocked.',
];

/**
 * The text for the tools the server lists now, or null when it lists none, so
 * a session without OpenChamber's tools carries nothing extra.
 * @param {string[]} toolNames names from the tool server's `tools/list`
 */
export const buildToolInstructions = (toolNames) => {
  const available = new Set(toolNames);
  const lines = [
    ...(available.has('openchamber_web') ? WEB_LINES : []),
    ...Object.entries(TOOL_LINES).filter(([name]) => available.has(name)).map(([, line]) => line),
  ];
  if (lines.length === 0) return null;
  return [
    "You run inside OpenChamber, which gives you its own tools through the MCP server `openchamber` (tool names start with `openchamber`). Prefer them over generic equivalents; they act on the user's OpenChamber window.",
    ...lines,
    ...REPORTING_LINES,
  ].join('\n');
};
