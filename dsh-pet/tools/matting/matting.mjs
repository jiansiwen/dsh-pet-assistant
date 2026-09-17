import { removeBackground } from '@imgly/background-removal-node'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const petsDir = path.resolve(dir, '../../assets/pets')
const candDir = path.resolve(dir, 'candidates')

const jobs = [
  ['panda3.png', 'panda.png'],
  ['girl2.png', 'girl-glasses.png'],
  ['boy2.png', 'boy-glasses.png']
]

for (const [src, out] of jobs) {
  const buf = readFileSync(path.join(candDir, src))
  const blob = new Blob([buf], { type: 'image/png' })
  const res = await removeBackground(blob, { output: { format: 'image/png' } })
  writeFileSync(path.join(petsDir, out), Buffer.from(await res.arrayBuffer()))
  console.log('OK', out)
}
