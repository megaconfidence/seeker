import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Settings, TargetAlbum, TargetTrack } from '../shared/types.ts'
import { groupFolders, rankFolders, scoreFolder } from '../server/soulseek/album.ts'
import { candidatesFrom, type Candidate } from '../server/soulseek/files.ts'
import { cleanTitles } from '../server/match/normalize.ts'
import { artistInText, detectVersions, parseName, scoreTrack, titleKey, TRACK_THRESHOLD } from '../server/soulseek/match.ts'
import { qualityOf } from '../server/soulseek/quality.ts'
import { albumQueries, trackQueries } from '../server/soulseek/queries.ts'
import type { SlskdResponse } from '../server/soulseek/slskd.ts'

const quality: Settings['quality'] = { formats: ['flac', 'mp3'], minBitrate: 320, acceptVbr: false, hiRes: 'accept' }

function response(username: string, files: [string, number?, Partial<SlskdResponse['files'][number]>?][], peer: Partial<SlskdResponse> = {}): SlskdResponse {
  return {
    username,
    hasFreeUploadSlot: true,
    uploadSpeed: 1_000_000,
    queueLength: 0,
    fileCount: files.length,
    ...peer,
    files: files.map(([filename, length, extra]) => ({
      filename,
      size: 30_000_000,
      length,
      bitRate: filename.endsWith('.mp3') ? 320 : undefined,
      ...extra,
    })),
  }
}

const inRainbows: TargetAlbum = { title: 'In Rainbows', artist: 'Radiohead', year: 2007, trackCount: 10, discCount: 1 }
const titles = ['15 Step', 'Bodysnatchers', 'Nude', 'Weird Fishes/Arpeggi', 'All I Need', 'Faust Arp', 'Reckoner', 'House of Cards', 'Jigsaw Falling Into Place', 'Videotape']
const durations = [237, 242, 255, 318, 228, 129, 290, 328, 249, 279]
const tracks: TargetTrack[] = titles.map((title, index) => ({ index, title, artist: 'Radiohead', disc: 1, track: index + 1, duration: durations[index]! }))

test('parseName reads track numbers and titles from common layouts', () => {
  assert.deepEqual(parseName('01 - 15 Step', {}).track, 1)
  assert.ok(parseName('01 - 15 Step', {}).titles.includes('15 Step'))
  const prefixed = parseName('Radiohead - In Rainbows - 04 - Weird Fishes_Arpeggi', { artist: 'Radiohead', album: 'In Rainbows' })
  assert.equal(prefixed.track, 4)
  assert.ok(prefixed.titles.some((title) => titleKey(title) === titleKey('Weird Fishes/Arpeggi')))
  const disc = parseName('2-03 Something', {})
  assert.equal(disc.disc, 2)
  assert.equal(disc.track, 3)
  assert.ok(parseName('7 rings', {}).titles.includes('7 rings'))
})

test('a song called "Live Forever" is not mistaken for a live version', () => {
  assert.equal(detectVersions('03 - Live Forever', ['Live Forever']).has('live'), false)
  assert.equal(detectVersions('03 - Live Forever (Live at Knebworth)', ['Live Forever']).has('live'), true)
  assert.equal(detectVersions('Song (Radio Edit)').has('radio'), true)
  assert.equal(detectVersions('Song (Radio Edit)').has('remix'), false)
  assert.equal(detectVersions('Song (Club Mix)').has('remix'), true)
  assert.equal(detectVersions('Song (Original Mix)').size, 0)
})

test('quality: FLAC beats MP3 320, low bitrate is rejected', () => {
  const [flac, mp3, low] = candidatesFrom([
    response('a', [['@@a\\Music\\x.flac', 200], ['@@a\\Music\\y.mp3', 200], ['@@a\\Music\\z.mp3', 200, { bitRate: 192 }]]),
  ]) as [Candidate, Candidate, Candidate]
  assert.equal(qualityOf(flac, quality)!.rung, 0)
  assert.equal(qualityOf(mp3, quality)!.rung, 1)
  assert.equal(qualityOf(low, quality), null)
  assert.equal(qualityOf(flac, { ...quality, hiRes: 'avoid' })?.rung, 0)
  const hiRes = candidatesFrom([response('b', [['@@b\\x.flac', 200, { bitDepth: 24, sampleRate: 96000 }]])])[0]!
  assert.equal(qualityOf(hiRes, { ...quality, hiRes: 'avoid' }), null)
  assert.equal(qualityOf(hiRes, { ...quality, hiRes: 'prefer' })!.rung, 0)
})

test('track scoring: right file passes, wrong artist/version fails', () => {
  const want = { title: 'Reckoner', artist: 'Radiohead', album: 'In Rainbows', duration: 290 }
  const files = candidatesFrom([
    response('good', [['@@g\\Music\\Radiohead\\2007 - In Rainbows\\07 - Reckoner.flac', 290]]),
    response('live', [['@@l\\Music\\Radiohead\\Live\\07 - Reckoner (Live from the Basement).flac', 300]]),
    response('other', [['@@o\\Music\\Someone Else\\Reckoner.flac', 290]]),
    response('karaoke', [['@@k\\Karaoke Hits\\Radiohead - Reckoner (Karaoke Version).mp3', 290]]),
    response('short', [['@@s\\Music\\Radiohead\\In Rainbows\\07 - Reckoner.flac', 120]]),
  ])
  const score = (user: string) => scoreTrack(want, files.find((file) => file.username === user)!)
  assert.ok(score('good').score >= TRACK_THRESHOLD, `good scored ${score('good').score}`)
  assert.ok(score('live').score < TRACK_THRESHOLD)
  assert.ok(score('other').score < TRACK_THRESHOLD)
  assert.ok(score('karaoke').score < TRACK_THRESHOLD)
  assert.ok(score('short').score < TRACK_THRESHOLD, 'a 2-minute file is not a 5-minute track')
})

test('album folders: complete FLAC folder wins over partial and MP3 copies', () => {
  const flacFolder = titles.map((title, i) => [`@@aa\\Music\\Radiohead\\Radiohead - In Rainbows (2007) [FLAC]\\${String(i + 1).padStart(2, '0')} - ${title.replace('/', '_')}.flac`, durations[i]] as [string, number])
  const mp3Folder = titles.map((title, i) => [`@@bb\\mp3\\Radiohead - In Rainbows\\${String(i + 1).padStart(2, '0')} ${title.replace('/', '_')}.mp3`, durations[i]] as [string, number])
  const partial = flacFolder.slice(0, 5).map(([name, length]) => [name.replace('@@aa', '@@cc'), length] as [string, number])
  const deluxe = titles.map((title, i) => [`@@dd\\Radiohead\\In Rainbows (Deluxe Live Remix Edition)\\${i + 1}. ${title} (Live).flac`, durations[i]! + 40] as [string, number])
  const responses = [
    response('flacuser', flacFolder),
    response('mp3user', mp3Folder),
    response('partialuser', partial),
    response('liveuser', deluxe),
  ]
  const folders = groupFolders(candidatesFrom(responses))
  const scored = folders.map((folder) => scoreFolder(inRainbows, tracks, folder, quality))
  const byUser = (user: string) => scored.find((score) => score.folder.username === user)!
  assert.equal(byUser('flacuser').coverage, 1)
  assert.ok(byUser('flacuser').eligible, byUser('flacuser').reason ?? "")
  assert.equal(byUser('mp3user').coverage, 1)
  assert.ok(byUser('mp3user').eligible, byUser('mp3user').reason ?? "")
  assert.equal(byUser('partialuser').eligible, false)
  assert.equal(byUser('liveuser').eligible, false)
  const ranked = rankFolders(scored.filter((score) => score.eligible))
  assert.equal(ranked[0]!.folder.username, 'flacuser')
  assert.equal(ranked[1]!.folder.username, 'mp3user')
})

test('multi-disc folders (CD1/CD2) are grouped into one album', () => {
  const discTracks: TargetTrack[] = [
    { index: 0, title: 'One', artist: 'X', disc: 1, track: 1, duration: 200 },
    { index: 1, title: 'Two', artist: 'X', disc: 1, track: 2, duration: 210 },
    { index: 2, title: 'Three', artist: 'X', disc: 2, track: 1, duration: 220 },
    { index: 3, title: 'Four', artist: 'X', disc: 2, track: 2, duration: 230 },
  ]
  const album: TargetAlbum = { title: 'Double Album', artist: 'X', trackCount: 4, discCount: 2 }
  const files = candidatesFrom([
    response('u', [
      ['@@u\\Music\\X - Double Album\\CD1\\01 One.flac', 200],
      ['@@u\\Music\\X - Double Album\\CD1\\02 Two.flac', 210],
      ['@@u\\Music\\X - Double Album\\CD2\\01 Three.flac', 220],
      ['@@u\\Music\\X - Double Album\\CD2\\02 Four.flac', 230],
    ]),
  ])
  const folders = groupFolders(files)
  assert.equal(folders.length, 1)
  const scored = scoreFolder(album, discTracks, folders[0]!, quality)
  assert.equal(scored.coverage, 1)
  assert.ok(scored.eligible, scored.reason ?? "")
})

test('artist matching ignores a leading "The" and squashed names, but not substrings', () => {
  assert.ok(artistInText('The Beatles', 'Beatles - Abbey Road'))
  assert.ok(artistInText('The Beatles', 'Beatles, The'))
  assert.ok(artistInText('AC/DC', 'ACDC - Back in Black'))
  assert.ok(artistInText('Simon & Garfunkel', 'Simon and Garfunkel - Bookends'))
  assert.equal(artistInText('Muse', 'Museum Pieces'), false)
  assert.equal(artistInText('Sia', 'Enthusiastic'), false)
  const want = { title: 'Something', artist: 'The Beatles', album: 'Abbey Road', duration: 182 }
  const [file] = candidatesFrom([response('u', [['@@u\\Music\\Beatles\\Abbey Road\\02 - Something.flac', 182]])])
  assert.ok(scoreTrack(want, file!).score >= TRACK_THRESHOLD)
})

test('doubled track numbers are stripped only when most of the album has them', () => {
  const ghosts = cleanTitles([
    { title: '01 Ghosts I', track: 1 },
    { title: '02 Ghosts I', track: 2 },
    { title: '10 Ghosts II', track: 10 },
  ])
  assert.deepEqual(
    ghosts.map((track) => track.title),
    ['Ghosts I', 'Ghosts I', 'Ghosts II'],
  )
  const normal = cleanTitles([
    { title: 'Intro', track: 1 },
    { title: 'Other', track: 2 },
    { title: '7 Rings', track: 7 },
  ])
  assert.equal(normal[2]!.title, '7 Rings')
})

test('repeated titles are matched by track number', () => {
  const ghostTracks: TargetTrack[] = [1, 2, 3, 4, 5, 6].map((n, index) => ({
    index,
    title: 'Ghosts I',
    artist: 'Nine Inch Nails',
    disc: 1,
    track: n,
    duration: 150 + n * 5,
  }))
  const album: TargetAlbum = { title: 'Ghosts I-IV', artist: 'Nine Inch Nails', trackCount: 6, discCount: 1 }
  const files = candidatesFrom([
    response('u', [
      ['@@u\\Nine Inch Nails\\Ghosts I-IV\\05 Ghosts I.flac', 175],
      ['@@u\\Nine Inch Nails\\Ghosts I-IV\\04 Ghosts I.flac', 170],
    ]),
  ])
  const folder = groupFolders(files)[0]!
  const scored = scoreFolder(album, ghostTracks, folder, quality)
  assert.equal(scored.pairs.get(3)?.name, '04 Ghosts I.flac')
  assert.equal(scored.pairs.get(4)?.name, '05 Ghosts I.flac')
  // Titles that repeat the number ("05 5 Ghosts I") still land on the right track.
  const numbered = groupFolders(
    candidatesFrom([response('v', [['@@v\\NIN\\Ghosts\\05 5 Ghosts I.flac', 175], ['@@v\\NIN\\Ghosts\\04 4 Ghosts I.flac', 170]])]),
  )[0]!
  const again = scoreFolder(album, ghostTracks, numbered, quality)
  assert.equal(again.pairs.get(3)?.name, '04 4 Ghosts I.flac')
  assert.equal(again.pairs.get(4)?.name, '05 5 Ghosts I.flac')
})

test('queries: no short title-only searches, self-titled albums use the year', () => {
  assert.deepEqual(albumQueries(inRainbows), ['Radiohead In Rainbows'])
  assert.deepEqual(albumQueries({ title: 'Weezer', artist: 'Weezer', year: 1994, trackCount: 10, discCount: 1 }), ['Weezer 1994', 'Weezer'])
  const queries = trackQueries(tracks[2]!, inRainbows)
  assert.ok(queries.every((query) => query.toLowerCase().includes('radiohead') || query.length >= 12))
  assert.ok(albumQueries({ title: 'The Downward Spiral', artist: 'Nine Inch Nails', trackCount: 14, discCount: 1 }).includes('The Downward Spiral'))
})
