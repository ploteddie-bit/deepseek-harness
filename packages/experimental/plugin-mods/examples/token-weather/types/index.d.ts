// Token Weather's type contract, from https://claude.dev/blog/getting-started-with-plugin-mods/
// (Anthropic, 2026-10-01). The published file, unchanged.

export type TokenWeatherReading = { tokens: number; window: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'token-weather': { readings: TokenWeatherReading[] }
  }
}
