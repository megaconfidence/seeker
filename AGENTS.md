# AGENTS.md

Notes for AI coding agents working on Seeker. Read this before changing code. The README covers what the app does
for users.

## What Seeker is

A self-hosted web app and MCP server that downloads music from Soulseek through [slskd](https://github.com/slskd/slskd),
checks the files, tags them and files them in a music library. It's published as a Docker image. slskd is a separate
dependency that users install themselves, following slskd's own docs.

## Layout

```text
docker-compose.yml          Example for users: Seeker alone, from the published image
.github/workflows/          CI: typecheck, tests, multi-arch image to GHCR
docs/screenshots/           README images
seeker/
  Dockerfile                The published image
  docker-entrypoint.sh      Starts as root, gives /data to PUID:PGID, then runs Seeker as that user (su-exec)
  server/                   Node 24 + Hono; entry point index.ts
    routes.ts               Web API used by the web app (session cookie)
    mcp.ts                  MCP server: every tool (bearer tokens)
    schemas.ts              zod schemas shared by routes.ts and mcp.ts
    catalog.ts              Deezer + MusicBrainz lookups, match preview, album targets
    jobs/engine.ts          Download state machine: search, pick folders, enqueue, monitor, stalls, wishlist
    jobs/process.ts         After download: verify, MusicBrainz enrichment, tag, move into the library
    jobs/store.ts           Job and file rows, progress
    soulseek/               slskd client, search budget, file parsing, quality, matching, album scoring, queries
    library/                Library scan, serving, ownership index, delete/upgrade, importer
    post/                   verify.ts (length, decode, fake lossless, AcoustID), tag.ts, fsops.ts
    metadata/               Deezer and MusicBrainz clients (rate limited, cached)
    db.ts                   SQLite (node:sqlite) and migrations
    settings.ts, config.ts  Saved settings with defaults; environment variables
    folders.ts              Folder checks (fatal for /data), user ids as the host sees them, permission messages
    shares.ts               When to ask slskd to rescan its shares (quiet period, downloads, 409s, slskd's own scans)
    status.ts, watchlist.ts, jellyfin.ts, backup.ts, auth.ts, log.ts
  web/src/                  React 19 + Vite + Tailwind CSS v4 + TanStack Query + React Router
    pages/                  One file per page
    components/             UI building blocks (ui.tsx has Button, Field, Tabs…), player bar, dialogs
    lib/                    API client, player, downloads helpers, toasts, confirm dialog, formatting
  shared/types.ts           Types shared by server and web
  test/                     node:test suites and fakes (fake slskd, fake Deezer/MusicBrainz)
```

## Commands

Run these in `seeker/`:

```bash
npm install
npm run dev          # server on :7335 using dev.env (copy dev.env.example; needs a running slskd and its API key)
npm run dev:web      # web app with hot reload on :5173; proxies the API to SEEKER_BACKEND (default :7335)
npm test             # all tests, offline, about 50 s; needs ffmpeg
npm run typecheck    # server and web
npm run build        # web app into web/dist (the server serves it)
```

`docker build -t seeker .` in `seeker/` builds the image locally.

Before you finish a change, `npm run typecheck` and `npm test` must pass.

## Deployment

The repository is public at `github.com/megaconfidence/seeker`. Every push to `main` runs
`.github/workflows/docker.yml`: typecheck and tests, then a multi-arch image published as
`ghcr.io/megaconfidence/seeker:latest` and `:sha-<commit>`. The owner's home server runs Watchtower, which replaces
the running Seeker container with the new image on its next check. Pushes that only change Markdown files, `docs/` or
`docker-compose.yml` skip the workflow (`paths-ignore`): they publish and deploy nothing, and the server keeps
reporting the last commit that built an image.

- **A push to `main` is a production deploy, and the owner wants every finished change pushed without being asked.**
  Once `npm run typecheck` and `npm test` pass and the work is committed, push it to `main` and check that the
  workflow published the image. Never push work in progress; that's what branches and pull requests are for (pull
  requests are tested and built, never published). Only tag a release when the owner asks.
- Version tags `v*` publish `X.Y.Z` and `X.Y`. Bump `version` in `seeker/package.json` and `server/config.ts`
  together.
- Images carry their commit (`SEEKER_COMMIT` build argument). Settings → Account and MCP `get_status` show it, which
  is how to check what the server runs.
- The README's install downloads `docker-compose.yml` from `main` by URL, so keep it at the repository root, and keep
  its settings in step with `server/config.ts` and the README's configuration tables.
- Never commit secrets: this repository is public.

## Rules

- **The app, its image and one compose file.** The owner wants users free to run Seeker however they like, so the
  repository ships the app, its image and `docker-compose.yml` (Seeker alone, from the published image), nothing
  else: no slskd setup, env templates, reverse proxy, VPN or auto-update. The README documents the image (environment
  variables, folders, port, user) and links to slskd's own docs for installing slskd. UI text and errors name
  environment variables, never a particular file such as `.env`.
- **MCP parity.** Everything the web app can do or show must be possible over MCP. When you add or change a feature
  or an API route, add or update the tool in `server/mcp.ts`, then update the expected tool list in
  `test/mcp.test.ts` and the tool table in the README. Mark tools that delete things with `destructiveHint`, and
  read-only tools with `readOnlyHint`. Never return secrets; settings show keys only as set or not set.
- **No build step for the server.** Node strips the types at runtime, so use only erasable TypeScript: no enums,
  namespaces, parameter properties or decorators. Import with explicit `.ts` extensions and use `import type` for
  types.
- **Strict TypeScript**, including `noUncheckedIndexedAccess`.
- **Validation** uses zod v4. Put schemas shared by the web API and MCP in `server/schemas.ts`.
- **Migrations** are an append-only array in `server/db.ts`. Never edit an existing migration; add a new one.
- **Configuration** comes from environment variables, read once in `server/config.ts`. Tests set them before
  importing any server module.
- **Logging** goes through `logger(scope)`. Warnings and errors are also kept in memory and shown by the MCP
  `get_status` tool, so write them for a person to read.
- **Comments** explain why, not what, and only where the code isn't obvious.
- **Writing in the UI**: short, plain sentences in sentence case. Errors say what to do next.

## Web app conventions

- Colours come from the tokens in `web/src/styles.css`: `bg`, `panel`, `raised`, `hover`, `line`, `line-strong`,
  `fg`, `muted`, `subtle`, `accent`, `ok`, `warn`, `bad`, `inverse`. Light and dark follow the system setting.
- Motion uses the `animate-*` utilities defined in `styles.css` (`page-in`, `pop-in`, `sheet-in`…). For exit
  animations, keep the element mounted with `usePresence` from `lib/presence.ts`. Reduced motion turns all of it off.
- Use the in-app `Dialog` and `useConfirm`, never `window.confirm`. Notifications go through `useToast`, with actions
  such as View or Undo where they help.
- Loading states use the skeletons in `components/skeleton.tsx`, not "Loading…" text.
- Covers: request a size that suits the spot with `coverAt(url, 250 | 500 | 1000)`.
- The playback position is deliberately not in React context, because it would re-render every component using the
  player. Read it with `getAudio()`; the seek bar paints it every animation frame (`components/scrubber.tsx`).

## Soulseek and slskd facts

- `searchTimeout` is in milliseconds. Search responses only exist once the search reports `isComplete`; fetch them
  after that, with a retry.
- The Soulseek server bans clients for about 30 minutes after roughly 34 searches in 220 seconds. `soulseek/search.ts`
  allows 32 per 220 s, one search at a time, with a gap between them. Don't bypass it.
- Downloads are enqueued with `POST transfers/downloads/batches` into `seeker/<jobId>` under the downloads folder.
- slskd reports a transfer as in progress while it is still connecting to the user. Only transferred bytes mean it is
  downloading.
- slskd only knows a download's place in the remote queue when asked:
  `GET transfers/downloads/{user}/{id}/position`. The engine asks once a minute.
- slskd only rescans its shares on `PUT shares` (or on its own `SLSKD_SHARE_CACHE_RETENTION` schedule). The PUT
  returns at once and the scan runs in the background; 409 means a scan is already running. On a big library,
  especially a network share, a scan can keep slskd from answering for minutes (a 5,000-file NFS library took 7–9).
  So never ask for a rescan per import: report library changes with `noteLibraryChange()` and let `server/shares.ts`
  ask once the library has been quiet for `shares.quietMinutes` and nothing is downloading. A scan that was already
  running may have missed new music, so it asks again afterwards. Whether a rescan is pending is saved in `meta`
  (`shares_pending`, via `setUnshared()`), and `startShares()` plans it again after a restart: every deploy restarts
  the owner's server, and the in-memory flag alone left music downloaded in the 30 minutes before unshared.
- Share quiet periods stay within 1–1440 minutes, including old or hand-edited saved settings: outside that, a timer
  fires at once (a `setTimeout` beyond about 24.8 days overflows to 1 ms). Initial indexing doesn't change audio files,
  so it only requests a rescan when `shares.rescanOnFirstScan` is on or slskd reports zero shared files.
- Only trust what slskd says it shares when the count is recent and slskd isn't scanning: counts mid-scan are partial.
  `status.ts` asks for one rescan when shares drop to nothing (`sharesLost()`), never one per poll.
- A search that fails because slskd didn't answer (a `SlskdError` with status 0) sends the download back to the queue
  to wait for slskd, never to the wishlist.
- A Soulseek account allows one session. Signing in elsewhere logs slskd out.

## Other things that have bitten us

- Albums can repeat a title (nine tracks called "Ghosts I"). Never decide ownership by title alone; use
  `ownedTrackIds` in `library/owned.ts`, which matches by ISRC, then position, then title only when it is unique.
- Deezer sometimes puts the track number in the title ("01 Ghosts I"); `cleanTitles` removes it.
- Tags are written from scratch (`post/tag.ts`). Uploaders' files carry other editions' tags under other names, which
  players would read instead of ours. Only track ReplayGain, lyrics, copyright and license are kept.
- Current Jellyfin rejects `X-Emby-Token` on its own; send `Authorization: MediaBrowser Token="…"`.
- AcoustID lookups need an application key. A user key returns "invalid API key"; the AcoustID test in Settings and
  MCP `test_acoustid` say so.
- The dev server's file watcher restarts it on any change under `seeker/`, even a `.DS_Store`. Restarts drop in-memory
  timers such as the delayed Jellyfin and share rescans.
- A local Seeker container and the dev server can both listen on port 7335 (one on IPv6, one on IPv4), so `localhost`
  may reach either. Stop one, or run a second server on another port; variables set on the command line override
  the env file: `SEEKER_PORT=7336 node --env-file=dev.env server/index.ts`.
- `/api/events` (server-sent events) stays open, so browser automation must wait for page content, not network idle.
- Rootless Docker maps container users to subordinate ids on the host (container 1000 → host 100999), so a host folder
  owned by the user isn't writable for container user 1000. The entrypoint fixes `/data` when the container starts as
  root (`PUID`/`PGID`); with `--user` it can't. `db.ts` calls `ensureDataDir()` before opening SQLite, so a data folder
  Seeker can't write to stops it with the ids and the `chown` to run, never a raw `SQLITE_CANTOPEN`.
- Never touch the music, downloads or import folders with synchronous `fs` calls. On a congested network share a
  `statSync` holds the event loop for as long as the share takes to answer, and `/healthz` with it (it took 7.5 s on
  the owner's server). `folderProblem()` is asynchronous; `folderProblemSync()` is only for the data folder at startup,
  because SQLite opens there synchronously right after.
- A scan that can't see the music folder must never empty the library index (a downed NFS mount once would have).
  `scanLibrary()` refuses when the folder is missing, unreadable, or empty while the index has tracks, or when more
  than half the tracks (and at least 100) would go, unless `force` is passed; unreadable subfolders keep their rows.
  The refusal is `library.problem` in the status. Never `mkdir` the music folder: that hides a missing mount, and
  `processJob()` refuses to file while `musicFolderProblem()` reports one.
- Storage failures keep jobs in `processing` with downloaded rows intact: an unavailable music folder (permissions, a
  lost mount, `ESTALE`, `ENOTCONN`…) or no space (`ENOSPC`/`EDQUOT`, wherever it happens, including tagging and the
  temporary copies in the data folder). `next_retry_at` persists the ten-minute processing retry and `waiting_for`
  why; `retryJob()` resumes those files directly. Never settle or clean up a waiting job: settling deletes the
  downloads. A download that vanished (`ENOENT` with the source gone) is a failed file, not a wait.
- When `processJob()` throws with downloads left, `runProcessing()` makes the job wait (`retry`). Picking it straight
  up again repeated one failing database read 21,836 times in 3.5 s. A library index failure after filing is logged,
  not thrown: the files are in the music folder, and the library scan it schedules indexes them.
- Library scans prepare album metadata before changing SQLite, and each commit is one synchronous transaction; never
  hold a SQLite transaction across asynchronous filesystem work. A full scan saves what it reads in batches
  (`BATCH_SIZE`, 200 tracks, or `SEEKER_SCAN_BATCH_MS`, 15 s), each with only its albums (the ones its tracks are on
  now and were on before), through `serializeIndex()`, filtering `changedDuringScan` each time, with a `setImmediate`
  between batches. Removals, the full album rebuild and `library_indexed = '1'` stay in the final commit, after the
  guards. A stopped, failed or interrupted scan keeps its batches, and rows carry mtime and size, so the next scan
  reads only what's left. The owned index is rebuilt at most every 15 s during batches: it reads every track.
- A first scan sets `library_indexed` to `'0'` before its first batch and `'1'` in its final commit, so one that was
  stopped or restarted is still the first scan when it resumes; `noteInitialLibrary()` runs once, when it finishes,
  even with nothing left to read (it found tracks at the start). Databases from before the flag have tracks and no
  flag, and aren't first scans. Later scans call `noteLibraryChange()` when they finish or stop, never per batch: a
  share rescan during a long scan would double the load on the share.
- `cancelLibraryScan()` (the Stop button, MCP `cancel_library_scan`) starts no more reads, abandons reads in progress
  rather than waiting for them, since a read on a hard NFS mount can't be interrupted, saves what was read, skips
  removals and drops a queued scan. Listings and stats race the stop signal too (`unlessStopped()`). A read that
  doesn't answer within `SEEKER_SCAN_READ_MS` (a minute) is abandoned the same way; its file keeps its row and is read
  next time. Two rounds of reads in a row without an answer stop the scan as if the share were down: the reason goes
  in `library.problem` and it retries in 10 minutes, instead of giving every remaining file a minute.
- Scans are slow on network shares because of round trips, not bytes: a 5,000-track NFS library took hours one
  operation at a time. So listings and stats run 16 at a time (`eachLimit()`), and tag reads 12, or 4 when `statfs`
  says the music folder is on a network filesystem (a bind mount reports its source's type), unless
  `SEEKER_SCAN_CONCURRENCY` says otherwise. The image sets `UV_THREADPOOL_SIZE=16`, as file reads use libuv's pool (4
  threads by default). A dozen reads at once kept the owner's NFS server, and everything using it, busy (issue #1).
  Albums take their cover
  image from the listing, never a second listing per album. With `duration: false`, music-metadata reads only headers;
  `skipCovers` keeps FLAC and MP4 covers from being read (MP3s read their whole ID3v2 tag regardless). Don't add
  `skipPostHeaders`: it drops ID3v1 tags whenever the ID3v2 tag holds anything, even an encoder name, for a 128-byte
  saving. `test/scan.test.ts` fails if a scan reads more than 256 kB from a FLAC with a 4 MB cover and a 48 MB MP3.
- Embedded art isn't known after a scan: `lib_tracks.has_cover` is `COVER_UNCHECKED` (-1) until `albumCover()` in
  `serve.ts` checks a file, the first time the album is shown, and stores 1 or 0 (0 for the whole album).
- A full scan lists and reads outside the index lock (`serializeIndex()`); only its commits wait, so post-import
  indexing (`scanFiles()`) runs during a scan, between batches. Paths that imports or deletions change meanwhile go in
  `changedDuringScan` (`indexedElsewhere()`), and the scan's commit leaves them alone: what it read for them is older.
  Folders in `SKIPPED_FOLDERS` (NAS metadata, recycle bins, snapshots) are never listed.
- Never file a track that kept the uploader's tags because of a permission error. When Seeker can't change a file,
  `tagForLibrary()` in `jobs/process.ts` tags a copy if it can remove the original, and otherwise fails the file.

## Tests

- `test/match.test.ts`: matching and scoring.
- `test/engine.test.ts`: the download engine end to end against the fake slskd and catalog: stalls and switching
  copies, consistent album quality, fake FLACs, failed and vanished transfers, the wishlist, cancelling, multi-disc
  albums and imports. Timings are shortened with the `SEEKER_*_MS` variables, and audio fixtures are generated with
  ffmpeg (seeded noise; the fake FLAC is a real MP3 round trip).
- `test/mcp.test.ts`: the MCP server through the official client, with no socket. It checks the full tool list,
  progress fields, settings masking and tokens.
- `test/processing.test.ts`: filing downloads when storage fails: unavailable or read-only music folders, no space
  (including while tagging and in the data folder), vanished downloads, index failures and the processing backoff.
  Errors are injected by mocking `fs`, or with SQLite triggers and renamed tables.
- `test/shares.test.ts`: share rescans against the fake slskd, which can simulate a scan in progress (409s) and a
  share count (`sharedFiles`).
- `test/share-startup.test.ts`: the first-index rescan decision, old share settings, and a pending rescan surviving a
  restart (a second Node process on the same database).
- `test/settings.test.ts`: saved settings outside today's limits.
- `test/library.test.ts` and `test/library-threshold.test.ts`: library scans with a missing, empty or unreadable
  music folder, the mass-removal limit, `force`, and atomic index commits.
- `test/scan.test.ts`: scan speed and its side effects: bytes read (counted through `FileHandle.read`), NAS folders,
  progress, one listing per folder, embedded covers checked on demand, and an import during a slowed-down full scan.
- `test/scan-resume.test.ts`: batches saved while a slowed scan reads, stopping a scan (a first scan too) and picking
  it up again, reads that don't answer within the time limit, a share that stops answering, and
  `SEEKER_SCAN_CONCURRENCY`. Reads are slowed or held per file by patching `FileHandle.read`, told apart by size.
- `test/folders.test.ts`: folder checks, host ids under rootless Docker, and a real startup with a read-only data
  folder (skipped as root, which can write anywhere).
- Tests must stay offline: the engine suite fails on any request that isn't to a local fake.
- `SEEKER_LOG_LEVEL=info` shows the server log during tests; `SEEKER_TEST_KEEP=1` keeps the temporary folders.

## Safety

- Never commit `.env` or `seeker/dev.env` (passwords, API keys). `.gitignore` also excludes the local music,
  downloads, import, data, `seeker-data` and `slskd` folders.
- When testing real downloads, use freely licensed music only, such as Nine Inch Nails' *Ghosts I–IV* and *The Slip*,
  or Jonathan Coulton's *Thing a Week* albums (Creative Commons).
- Don't modify the user's music library except through the app's own features. Test against copies or temporary
  folders.
- Don't print secrets in output or logs.
