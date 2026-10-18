import { OpenChamberControlError } from './error.js';

export const RENDER_GUIDE_MODULES = Object.freeze(['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation']);

const CORE_GUIDE = `# Widgets in OpenChamber

## What to send
- widget_code is one of: an <svg> element (detected when the code starts with <svg), an HTML fragment (no <html>, <head> or <body> needed), or a complete HTML document.
- title is a short snake_case name such as release_timeline; it names the download and the full-screen view.
- loading_messages are up to 4 short lines the chat cycles through while the widget arrives.
- Scripts run once the whole call has arrived, never on half-written code.

## Theme variables
They are set on :root and change live when the user switches between light and dark or picks another theme.
- --foreground main text; --muted-foreground secondary text and axis labels
- --background the chat background; --card a raised surface, --card-foreground its text; --muted a quiet fill
- --border hairlines, dividers and gridlines
- --primary the accent, --primary-foreground text on an accent fill
- --success, --warning, --destructive, --info status colors
- --chart-1 to --chart-6 categorical series, used in order
- --radius corners, --font-sans and --font-mono type
Take every color from these, or tint one: color-mix(in srgb, var(--foreground) 5%, transparent) is a quiet box, var(--chart-2) at 18% a soft category fill. A hard-coded hex that reads well in dark disappears in light.

## Size and layout
- The widget is as wide as the reply column: about 720px on desktop, about 360px on a phone. Use fluid widths, flex or grid with wrapping, and max-width; nothing may be wider than the column.
- SVG: always give a viewBox (about 680 wide is a good design width) and leave the width to the chat, which draws a top-level <svg> at 100% width with its height from the viewBox ratio.
- The frame takes the content's height. Never use 100vh, height:100% on html or body, or tall fixed heights; a canvas chart sits in a wrapper with a fixed pixel height of about 240 to 360px.
- The background stays transparent. Add no outer card, border or heading that repeats the title: the widget is part of your reply.

## Light and dark
- Check both: text on a tinted fill must stay readable in each. Put --primary-foreground on --primary, and --foreground on tints of --foreground.
- Canvas and library charts do not follow CSS by themselves. Read the colors with getComputedStyle(document.documentElement).getPropertyValue('--chart-1') and redraw on the window event "openchamber-theme", which fires after each theme change.

## Accessibility
- An SVG gets role="img" and a <title> (plus aria-labelledby when there is a description). Controls are real <button>, <input> and <select> elements with visible text or an aria-label.
- Never carry meaning by color alone: add labels, values or shape differences.
- Text is at least 12px; click targets are at least 32px tall; respect prefers-reduced-motion for animation.

## Scripts and network
- Inline <script> and <style> work. External scripts and stylesheets load only from https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net and https://unpkg.com, pinned to an exact version. Other hosts, fetch to APIs and nested frames are blocked, and the VS Code extension blocks external scripts too, so prefer code that needs no library.
- Images must be https or data: URLs. The widget has no access to OpenChamber, its storage or the user's files; links open in the user's browser.
- sendPrompt(text) sends text as the user's next message in this session. It works only from a click and returns true when the message was handed over.`;

const MODULE_GUIDES = {
  diagram: `## Diagrams (flowcharts, architecture, schemas, sequences)
- Draw with SVG: <rect rx="6"> boxes, <line> or <path> connectors, and one arrowhead <marker> in <defs> whose fill is var(--muted-foreground); connectors use stroke var(--muted-foreground) at 1.5px.
- Lay nodes on a grid you compute first (fixed column and row steps), flowing left to right or top to bottom; keep at most about 12 nodes and split a bigger system into two widgets.
- Labels are <text> at 13px or more, text-anchor="middle", with at least 10px of padding inside their box; size each box to its longest label, and never let a connector cross a label.
- Show groups as a tinted background rect behind their members, with the group name at its top-left in --muted-foreground.
- Color only what differs: category boxes take a --chart-n tint fill with a --chart-n stroke; everything else stays neutral.
- A schema lists each table as a box with a header row and one row per column; relations run between the key rows.`,
  chart: `## Charts
- Prefer inline SVG for up to a few dozen points: compute the scales in a short script or by hand, draw bars, lines and dots, and label the axes and units.
- For many points, zooming or rich tooltips, use Chart.js: <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>, with responsive: true and maintainAspectRatio: false inside a div of fixed pixel height.
- Read series colors from --chart-1 onward, set Chart.defaults.color to --muted-foreground and the grid color to --border, and on "openchamber-theme" re-read them and call chart.update().
- Start bars at zero, sort categories by value unless their order means something, show a legend only for two or more series, and put the value on the bar when there are few bars.`,
  data_viz: `## Data visualization
- Pick the form from the question: compare items with bars, show a trend with a line, a share of a whole with a stacked bar (a pie only for up to four parts), a distribution with a histogram, a relationship with a scatter plot.
- One to four headline numbers read best as stat tiles: a large value, a small label and the change against the previous period.
- A table right-aligns numbers with font-variant-numeric: tabular-nums, keeps units in the header, and sits in its own overflow-x:auto box when it is wide.
- State the takeaway in one short line above the visual and highlight the item it is about in --primary, keeping the rest in a muted tone.`,
  mockup: `## Interface mockups
- Draw the interface as it would look, in the app's own variables, with real controls and realistic content instead of placeholder text.
- Show alternatives or before and after side by side with a short caption under each; they stack on a phone.
- Keep the mockup at its natural size for the column; a desktop screen is scaled down as one block rather than reflowed into something it would never be.`,
  interactive: `## Interactive widgets
- Tabs, toggles, sliders, sorting and filtering update the page in place with plain script; keep state in variables, not in storage.
- Tooltips and popups stay inside the widget; flip them to the other side near an edge, and show them on tap as well as hover.
- For a follow-up the agent should handle, add a button whose click calls sendPrompt with the sentence the user would write, in their language, such as "Explain the spike in March". Mark the button as sent afterwards so it is not pressed twice.`,
  elicitation: `## Asking the user
- Offer each option as a button whose click calls sendPrompt with the whole answer in words ("Use layout B with the sidebar on the left"), so the message reads on its own in the chat.
- Add an optional text field with a send button when the options may not cover what the user wants.
- When your next step depends on the answer in the middle of the work, use awaitAnswer with openchamber.submit(data, summary) instead (see the openchamber_render description); a sendPrompt answer arrives as a new message after your turn.`,
  art: `## Illustration and generative art
- Use SVG for crisp shapes, or a <canvas> sized to its wrapper for many particles; size by viewBox or the wrapper's width.
- Take the palette from the theme variables so the piece sits in both light and dark.
- Animate with requestAnimationFrame, keep it light on the CPU, and stay still under prefers-reduced-motion.`,
};

export const createRenderGuideAction = ({ isEnabled }) => async (input = {}) => {
  if (!await isEnabled()) {
    throw new OpenChamberControlError('The render tool is turned off in OpenChamber settings', 403);
  }
  const requested = input.modules ?? [];
  if (!Array.isArray(requested)) {
    throw new OpenChamberControlError(`modules must be a list of: ${RENDER_GUIDE_MODULES.join(', ')}`, 400);
  }
  const unknown = requested.find((name) => !RENDER_GUIDE_MODULES.includes(name));
  if (unknown !== undefined) {
    throw new OpenChamberControlError(`Unknown module: ${String(unknown)}. Use any of: ${RENDER_GUIDE_MODULES.join(', ')}`, 400);
  }
  const modules = [...new Set(requested)];
  return { modules, guide: [CORE_GUIDE, ...modules.map((name) => MODULE_GUIDES[name])].join('\n\n') };
};
