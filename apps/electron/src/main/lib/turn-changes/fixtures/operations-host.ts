import type { TerminalCreateInput, TerminalOutputAck, TerminalOutputEvent, TerminalState } from '@proma/shared'
export * from './ipc-host'

export const terminalHost: { pending: boolean; acknowledgements: TerminalOutputAck[]; parents: Set<number>; resolve?: (state: TerminalState) => void; output?: (event: TerminalOutputEvent) => void; exit?: (event: { terminalId: string; exitCode: number }) => void } = { pending: false, acknowledgements: [], parents: new Set() }
export const terminalRuntimeClient = {
  onOutput: (callback: (event: TerminalOutputEvent) => void): void => { terminalHost.output = callback },
  onExit: (callback: (event: { terminalId: string; exitCode: number }) => void): void => { terminalHost.exit = callback },
  create: async (input: TerminalCreateInput): Promise<TerminalState> => {
    const result: TerminalState = { terminalId: input.terminalId, cwd: input.cwd!, title: 'fixture', profile: 'default', pid: 1 }
    if (terminalHost.pending) return new Promise(done => { terminalHost.resolve = done })
    return result
  },
  kill: (): void => {}, write: async (): Promise<void> => {}, resize: async (): Promise<void> => {},
  acknowledgeOutput: (event: TerminalOutputAck): void => { terminalHost.acknowledgements.push({ terminalId: event.terminalId, sequence: event.sequence }) },
  stop: async (): Promise<void> => {},
}
export async function readTerminalProcessParents(): Promise<Set<number>> { return new Set(terminalHost.parents) }
export function resolveAgentTerminalCwd(input: { cwd?: string }): string { if (!input.cwd) throw new Error('fixture cwd missing'); return input.cwd }
