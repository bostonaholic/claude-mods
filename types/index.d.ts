export type AgentPaneType = { name: string; summary: string; source: string }

export type AgentPaneCatalog = { isListed: boolean; types: AgentPaneType[] }

export type AgentPaneStart =
  | { status: 'starting' }
  | { status: 'started'; agentId?: string }
  | { status: 'failed'; reason: string }

export type AgentPaneMeta = { model?: string; color?: string }

declare module 'claude-code' {
  interface PluginState {
    'bostonaholic': {
      agentPaneCatalog: AgentPaneCatalog
      agentPaneStarts: Record<string, AgentPaneStart>
      agentPaneMeta: Record<string, AgentPaneMeta>
    }
  }
}
