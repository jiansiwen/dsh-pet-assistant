import type { SessionCommand } from '../session-types.js'

export interface OverlayBox { x1: number; y1: number; x2: number; y2: number }

export function validBoxes(value: unknown): value is OverlayBox[] {
  return Array.isArray(value) && value.length <= 64 && value.every(box => box &&
    ['x1', 'y1', 'x2', 'y2'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) &&
    box.x1 <= box.x2 && box.y1 <= box.y2)
}

export function shouldDismissOverlay(
  state: { open: boolean; running: boolean; blocked: boolean; after: number; boxes: readonly OverlayBox[] },
  press: { x: number; y: number; time: number },
): boolean {
  return state.open && !state.running && !state.blocked && press.time > state.after &&
    !state.boxes.some(box => press.x >= box.x1 && press.x <= box.x2 && press.y >= box.y1 && press.y <= box.y2)
}

export function isSessionCommand(value: unknown): value is SessionCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  if (typeof command.bindingId !== 'string' || !command.bindingId || command.bindingId.length > 256) return false
  const text = (key: string, max: number) => typeof command[key] === 'string' && (command[key] as string).trim().length > 0 &&
    (command[key] as string).length <= max
  switch (command.kind) {
    case 'prompt': return text('text', 60_000) && (command.spoken === undefined || typeof command.spoken === 'boolean')
    case 'cancel': return true
    case 'model': return text('provider', 256) && text('model', 512) &&
      (command.reasoningEffort === undefined || text('reasoningEffort', 128))
    case 'permission': return text('value', 128) && /^[a-zA-Z0-9_-]+$/.test(command.value as string)
    default: return false
  }
}
