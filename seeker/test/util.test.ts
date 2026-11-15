// Small helpers shared across the server.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eachLimit } from '../server/util.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('eachLimit treats a synchronous throw like a rejection, and still waits for work already started', { timeout: 5_000 }, async () => {
  const finished: number[] = []
  const work = (item: number): Promise<void> => {
    if (item === 2) throw new Error('two threw')
    return sleep(item === 1 ? 30 : 0).then(() => {
      finished.push(item)
    })
  }
  await assert.rejects(eachLimit([1, 2, 3], 2, work), /two threw/)
  // 1 had started before 2 threw, so eachLimit waited for it; 3 never started.
  assert.deepEqual(finished, [1])

  // A throw from an item started later, from inside a completion callback, rejects too instead of
  // escaping as an unhandled rejection and leaving eachLimit pending forever.
  await assert.rejects(
    eachLimit([1, 2, 3, 4], 1, (item: number): Promise<void> => {
      if (item === 3) throw new Error('three threw')
      return sleep(1)
    }),
    /three threw/,
  )
})
