import type { TerminalCreateInput, TerminalOutputEvent, TerminalState } from '@proma/shared'
export * from './ipc-host'

export const terminalHost: { pending: boolean; resolve?: (state: TerminalState) => void; output?: (event: TerminalOutputEvent) => void; exit?: (event: { terminalId: string; exitCode: number }) => void } = { pending: false }
export const terminalRuntimeClient = {
  onOutput: (callback: (event: TerminalOutputEvent) => void): void => { terminalHost.output = callback },
  onExit: (callback: (event: { terminalId: string; exitCode: number }) => void): void => { terminalHost.exit = callback },
  create: async (input: TerminalCreateInput): Promise<TerminalState> => {
    const result: TerminalState = { terminalId: input.terminalId, cwd: input.cwd!, title: 'fixture', profile: 'default', pid: 1 }
    if (terminalHost.pending) return new Promise(done => { terminalHost.resolve = done })
    return result
  },
  kill: (): void => {}, write: async (): Promise<void> => {}, resize: async (): Promise<void> => {}, acknowledgeOutput: (): void => {}, stop: async (): Promise<void> => {},
}
export function resolveAgentTerminalCwd(input: { cwd?: string }): string { if (!input.cwd) throw new Error('fixture cwd missing'); return input.cwd }
