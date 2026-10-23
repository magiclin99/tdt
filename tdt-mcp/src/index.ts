#!/usr/bin/env node
// TDT (Talk Driven Testing) MCP server.
// Claude Code ─stdio─► this server ─CDP─► QA Chrome (TDT_CDP_URL, default :9222)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { tabContext } from './browser.js';
import { tools, type Content } from './tools.js';

const server = new McpServer({ name: 'tdt', version: '0.1.0' });

const errorResult = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
});

for (const [name, tool] of Object.entries(tools)) {
  server.registerTool(name, { description: tool.description, inputSchema: tool.schema.shape }, async (args: any) => {
    try {
      const { content, tabId } = await tool.run(args);
      return { content: [...content, { type: 'text' as const, text: await tabContext(tabId) }] };
    } catch (e) {
      return errorResult(e);
    }
  });
}

server.registerTool('browser_batch', {
  description: [
    'Run several TDT tool calls in ONE round trip, sequentially, stopping at the first error.',
    'Each item is {name, input} where input is exactly what that tool takes standalone (tabId is required for page tools here).',
    'Use it whenever you can predict two or more steps, e.g. navigate → click field → type → key Enter → screenshot.',
    'Coordinates in the batch refer to the last screenshot taken before this call. Cannot be nested.',
  ].join(' '),
  inputSchema: {
    actions: z.array(z.object({
      name: z.string().describe('Tool name, e.g. "computer", "navigate", "read_page", "form_input".'),
      input: z.record(z.string(), z.any()).describe('That tool\'s input.'),
    })).min(1),
  },
}, async ({ actions }) => {
  const out: Content[] = [];
  let lastTab: number | undefined;
  for (let i = 0; i < actions.length; i++) {
    const name = actions[i].name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
    const tool = tools[name];
    const label = `[${name}${actions[i].input.action ? ':' + actions[i].input.action : ''}]`;
    try {
      if (name === 'browser_batch') throw new Error('browser_batch cannot be nested.');
      if (!tool) throw new Error(`Unknown tool "${actions[i].name}". Available: ${Object.keys(tools).join(', ')}.`);
      const parsed = tool.schema.safeParse(actions[i].input);
      if (!parsed.success) throw new Error(`Invalid input: ${parsed.error.issues.map(x => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')}`);
      const { content, tabId } = await tool.run(parsed.data);
      lastTab = tabId ?? lastTab;
      let labelled = false;
      for (const c of content) {
        if (c.type === 'text' && !labelled) {
          out.push({ type: 'text', text: `${label} ${c.text}` });
          labelled = true;
        } else {
          out.push(c);
        }
      }
      if (!labelled) out.push({ type: 'text', text: `${label} done` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ type: 'text', text: `${label} failed: ${msg} (${i} completed, ${actions.length - i - 1} not run)` });
      out.push({ type: 'text', text: await tabContext(lastTab) });
      return { isError: true, content: out };
    }
  }
  out.push({ type: 'text', text: await tabContext(lastTab) });
  return { content: out };
});

await server.connect(new StdioServerTransport());
console.error('tdt-mcp ready');
