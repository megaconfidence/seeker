import { EventEmitter } from 'node:events'
import type { ServerEvent } from '../shared/types.ts'

const bus = new EventEmitter()
bus.setMaxListeners(200)

export function emit(event: ServerEvent) {
  bus.emit('event', event)
}

export function subscribe(listener: (event: ServerEvent) => void): () => void {
  bus.on('event', listener)
  return () => bus.off('event', listener)
}
