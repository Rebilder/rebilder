/**
 * tools/index.ts — the registry. Five tools, declaration order is `tools/list`
 * order, and the order is chosen for a reader: scan, compare, explain, look up,
 * install. That is the arc of a conversation with this server, ending at the
 * thing that fixes the problem.
 */

import { compareAgentViewTool } from './compare-agent-view'
import { explainCheckTool } from './explain-check'
import { getIndexEntryTool } from './get-index-entry'
import { installSnippetTool } from './install-snippet'
import { scanUrlTool } from './scan-url'
import type { Tool } from './types'

export const TOOLS: readonly Tool[] = Object.freeze([
  scanUrlTool,
  compareAgentViewTool,
  explainCheckTool,
  getIndexEntryTool,
  installSnippetTool,
])

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

export {
  compareAgentViewTool,
  explainCheckTool,
  getIndexEntryTool,
  installSnippetTool,
  scanUrlTool,
}
export * from './types'
