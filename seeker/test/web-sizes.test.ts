// The web app sizes everything in rem, so touch screens can make the whole interface bigger with
// the root font size (web/src/styles.css). A px size stays small on a phone.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const web = path.join(import.meta.dirname, '..', 'web', 'src')
const styles = await fs.readFile(path.join(web, 'styles.css'), 'utf8')
const sources = await Promise.all(
  (await fs.readdir(web, { recursive: true }))
    .filter((file) => /\.tsx?$/.test(file))
    .map(async (file) => ({ file, text: await fs.readFile(path.join(web, file), 'utf8') })),
)

test('the interface is drawn at 110% on a desktop, and bigger on touch screens', () => {
  const desktop = /\n  html \{\s*font-size: (\d+(?:\.\d+)?)%;/.exec(styles)
  const touch = /@media \(pointer: coarse\) \{\s*html \{\s*font-size: (\d+(?:\.\d+)?)%;/.exec(styles)
  assert.equal(desktop?.[1], '110')
  assert.ok(touch && Number(touch[1]) > Number(desktop[1]), `touch screens get ${touch?.[1]}%`)
})

test('web app sizes are in rem: px only for blurs', () => {
  const px = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/[\w:[\]().,-]*\d(?:\.\d+)?px\b[\w\]).,-]*/g)]
      .map((match) => match[0])
      .filter((value) => !/^backdrop-blur-\[\d+px\]$/.test(value))
      .map((value) => `${file}: ${value}`),
  )
  assert.deepEqual(px, [])
})

test('every text size class has its token in styles.css', () => {
  const tokens = new Set([...styles.matchAll(/--text-(\d+(?:\\\.\d+)?):/g)].map((match) => match[1]!.replace('\\.', '.')))
  const used = new Set(sources.flatMap(({ text }) => [...text.matchAll(/(?<![\w-])text-(\d+(?:\.\d+)?)(?![\w.])/g)].map((match) => match[1]!)))
  assert.ok(used.size > 10, `found ${used.size} text sizes`)
  assert.deepEqual([...used].filter((size) => !tokens.has(size)).sort(), [])
})
