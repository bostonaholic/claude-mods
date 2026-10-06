export type AgentPaneType = { name: string; summary: string }

export type AgentPaneCatalog = { isListed: boolean; types: AgentPaneType[] }

declare module 'claude-code' {
  interface PluginState {
    'bostonaholic-mods': { agentPaneCatalog: AgentPaneCatalog }
  }
}
