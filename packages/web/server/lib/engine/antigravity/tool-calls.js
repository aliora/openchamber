import { z } from 'zod';
import { replacementHunk, toolFileDiff } from '../tool-file-diff.js';

const MCP_TOOL = 'call_mcp_tool';

const mcpCallSchema = z.object({
  ServerName: z.string(),
  ToolName: z.string(),
  Arguments: z.record(z.string(), z.unknown()).catch({}),
});

const text = z.string().optional().catch(undefined);
const lineNumber = z.number().int().positive().optional().catch(undefined);

const definedFields = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

const editSchema = z.object({ TargetFile: text, TargetContent: text, ReplacementContent: text, StartLine: lineNumber });

const editDiff = ({ TargetFile: file, TargetContent: before, ReplacementContent: after, StartLine: start }) => {
  if (!file || before === undefined || after === undefined) return undefined;
  return { files: [toolFileDiff({ file, hunks: replacementHunk(before, after, start), status: 'modified' })] };
};

const BUILTIN_TOOLS = {
  run_command: {
    name: 'shell',
    schema: z.object({ CommandLine: text, Cwd: text, toolSummary: text }),
    input: ({ CommandLine, Cwd, toolSummary }) => ({ command: CommandLine, cwd: Cwd, description: toolSummary }),
  },
  view_file: {
    name: 'read',
    schema: z.object({ AbsolutePath: text }),
    input: ({ AbsolutePath }) => ({ path: AbsolutePath }),
  },
  write_to_file: {
    name: 'write',
    schema: z.object({ TargetFile: text, CodeContent: text }),
    input: ({ TargetFile, CodeContent }) => ({ path: TargetFile, content: CodeContent }),
  },
  replace_file_content: {
    name: 'edit',
    schema: editSchema,
    input: ({ TargetFile, TargetContent, ReplacementContent }) => ({ path: TargetFile, oldString: TargetContent, newString: ReplacementContent }),
    metadata: editDiff,
  },
  grep_search: {
    name: 'grep',
    schema: z.object({ Query: text, SearchPath: text }),
    input: ({ Query, SearchPath }) => ({ pattern: Query, path: SearchPath }),
  },
  read_url_content: {
    name: 'webfetch',
    schema: z.object({ Url: text }),
    input: ({ Url }) => ({ url: Url }),
  },
  search_web: {
    name: 'websearch',
    schema: z.object({ query: text }),
    input: ({ query }) => ({ query }),
  },
};

export const agyToolCall = (step, ownServer) => {
  const name = step.tool_name || step.tool_info?.name || 'tool';
  const parameters = step.tool_info?.parameters || {};
  const builtin = BUILTIN_TOOLS[name];
  if (builtin) {
    const fields = builtin.schema.parse(parameters);
    return { name: builtin.name, input: definedFields(builtin.input(fields)), metadata: builtin.metadata?.(fields) };
  }
  const mcpCall = name === MCP_TOOL ? mcpCallSchema.safeParse(parameters) : null;
  if (!mcpCall?.success) return { name, input: parameters };
  const { ServerName: server, ToolName: tool, Arguments: input } = mcpCall.data;
  return { name: server === ownServer ? tool : `mcp__${server}__${tool}`, input };
};

export const agyToolResult = (step) => {
  const failure = step.tool_info?.error;
  return {
    output: failure ? failure.message ?? 'The tool failed' : step.tool_info?.output ?? '',
    isError: Boolean(failure) || step.state === 'ERROR',
  };
};
