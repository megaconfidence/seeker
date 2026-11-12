import path from 'node:path'
import { ByteVector, File, Id3v2Settings, Picture, PictureType, TagTypes, type XiphComment } from 'node-taglib-sharp'

Id3v2Settings.defaultVersion = 4
Id3v2Settings.forceDefaultVersion = true

export interface TagData {
  title: string
  artists: string[]
  albumArtist: string
  album: string
  year: number | null
  track: number
  trackCount: number
  disc: number
  discCount: number
  genres: string[]
  isrc?: string
  label?: string
  compilation?: boolean
  mbRecordingId?: string
  mbReleaseId?: string
  mbReleaseGroupId?: string
  mbArtistId?: string
  mbAlbumArtistId?: string
}

function ensureTag(file: File, ext: string) {
  switch (ext) {
    case '.mp3':
      file.getTag(TagTypes.Id3v2, true)
      break
    case '.flac':
    case '.ogg':
    case '.oga':
    case '.opus':
      file.getTag(TagTypes.Xiph, true)
      break
    case '.m4a':
    case '.mp4':
    case '.aac':
    case '.alac':
      file.getTag(TagTypes.Apple, true)
      break
    default:
      break
  }
}

export function writeTags(filePath: string, data: TagData, cover?: Buffer | null) {
  const file = File.createFromPath(filePath)
  try {
    // Start from clean tags: uploaders' files often carry another edition's tags under other
    // names (TOTALTRACKS, release ids…) that players would read instead of ours. Keep only what
    // still describes this exact audio.
    const old = file.tag
    const oldXiph = file.getTag(TagTypes.Xiph, false) as XiphComment | undefined
    const kept = {
      gain: old.replayGainTrackGain,
      peak: old.replayGainTrackPeak,
      lyrics: old.lyrics,
      copyright: old.copyright,
      license: oldXiph?.getFieldFirstValue('LICENSE') ?? '',
      pictures: old.pictures,
    }
    file.removeTags(TagTypes.AllTags)
    ensureTag(file, path.extname(filePath).toLowerCase())
    const tag = file.tag
    if (Number.isFinite(kept.gain)) tag.replayGainTrackGain = kept.gain
    if (Number.isFinite(kept.peak)) tag.replayGainTrackPeak = kept.peak
    if (kept.lyrics) tag.lyrics = kept.lyrics
    if (kept.copyright) tag.copyright = kept.copyright
    if (kept.license) (file.getTag(TagTypes.Xiph, true) as XiphComment | undefined)?.setFieldAsStrings('LICENSE', kept.license)
    if (!cover?.length && kept.pictures?.length) tag.pictures = kept.pictures
    tag.title = data.title
    tag.performers = data.artists.length ? data.artists : [data.albumArtist]
    tag.albumArtists = [data.albumArtist]
    tag.album = data.album
    tag.year = data.year ?? 0
    tag.track = data.track
    tag.trackCount = data.trackCount
    tag.disc = data.disc
    tag.discCount = data.discCount
    tag.genres = data.genres
    if (data.isrc) tag.isrc = data.isrc
    if (data.label) tag.publisher = data.label
    tag.isCompilation = !!data.compilation
    if (data.mbRecordingId) tag.musicBrainzTrackId = data.mbRecordingId
    if (data.mbReleaseId) tag.musicBrainzReleaseId = data.mbReleaseId
    if (data.mbReleaseGroupId) tag.musicBrainzReleaseGroupId = data.mbReleaseGroupId
    if (data.mbArtistId) tag.musicBrainzArtistId = data.mbArtistId
    if (data.mbAlbumArtistId) tag.musicBrainzReleaseArtistId = data.mbAlbumArtistId
    if (cover && cover.length > 0) {
      const picture = Picture.fromData(ByteVector.fromByteArray(cover))
      picture.type = PictureType.FrontCover
      picture.description = 'Cover'
      tag.pictures = [picture]
    }
    file.save()
  } finally {
    file.dispose()
  }
}
