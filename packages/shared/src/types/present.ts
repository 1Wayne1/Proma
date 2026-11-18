export interface PresentTurn {
  sessionId: string
  turnId: string
}

export interface PresentedResource {
  id: string
  name: string
  extension: string
  description?: string
  status: 'pending' | 'opening' | 'presented' | 'cancelled' | 'unavailable'
  browserAvailable: boolean
  vaultAvailable: boolean
}

export interface PresentAction extends PresentTurn {
  resourceId: string
  action: 'open' | 'browser' | 'vault' | 'locate' | 'cancel'
}

export interface VaultPresentation extends PresentTurn {
  requestId: string
  vaultId: string
  relativePath: string
}

export interface PresentReceipt extends PresentTurn {
  requestId: string
  outcome: 'presented' | 'cancelled'
}

export interface PresentActionResult {
  vault?: VaultPresentation
  browserTabId?: string
}

export const PRESENT_IPC_CHANNELS = {
  LIST: 'present:list',
  ACT: 'present:act',
  RECEIPT: 'present:receipt',
  CHANGED: 'present:changed',
} as const
