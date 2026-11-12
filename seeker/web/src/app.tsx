import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, Route, Routes } from 'react-router'
import { Layout } from './components/layout.tsx'
import { Empty } from './components/ui.tsx'
import { api } from './lib/api.ts'
import { ConfirmProvider } from './lib/confirm.tsx'
import { useServerEvents } from './lib/live.ts'
import { PlayerProvider } from './lib/player.tsx'
import { AlbumPage } from './pages/album.tsx'
import { ArtistPage } from './pages/artist.tsx'
import { DownloadsPage } from './pages/downloads.tsx'
import { ImportPage } from './pages/import.tsx'
import { LibraryAlbumPage } from './pages/library-album.tsx'
import { LibraryPage } from './pages/library.tsx'
import { LoginPage } from './pages/login.tsx'
import { SearchPage } from './pages/search.tsx'
import { SettingsPage } from './pages/settings.tsx'
import { SoulseekPage } from './pages/soulseek.tsx'
import { WatchlistPage } from './pages/watchlist.tsx'
import { WishlistPage } from './pages/wishlist.tsx'

export function App() {
  const client = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ loggedIn: boolean }>('/auth/me'), staleTime: Infinity })
  const loggedIn = me.data?.loggedIn === true

  useEffect(() => {
    const onUnauthorized = () => client.setQueryData(['me'], { loggedIn: false })
    window.addEventListener('seeker:unauthorized', onUnauthorized)
    return () => window.removeEventListener('seeker:unauthorized', onUnauthorized)
  }, [client])

  useServerEvents(loggedIn)

  if (me.isPending) return null
  if (!loggedIn) {
    return (
      <LoginPage
        onLoggedIn={() => {
          client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' })
          client.setQueryData(['me'], { loggedIn: true })
        }}
      />
    )
  }

  return (
    <PlayerProvider>
      <ConfirmProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<SearchPage />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
            <Route path="/album/mb/:mbid" element={<AlbumPage />} />
            <Route path="/album/:id" element={<AlbumPage />} />
            <Route path="/soulseek" element={<SoulseekPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/wishlist" element={<WishlistPage />} />
            <Route path="/watchlist" element={<WatchlistPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/library/album/:id" element={<LibraryAlbumPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={
                <Empty title="Page not found">
                  <Link to="/" className="underline">
                    Back to search
                  </Link>
                </Empty>
              }
            />
          </Routes>
        </Layout>
      </ConfirmProvider>
    </PlayerProvider>
  )
}
