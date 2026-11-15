import clsx from 'clsx'
import { Disc3, UserRound } from 'lucide-react'
import { useState } from 'react'

export function Cover({
  src,
  alt = '',
  className,
  rounded = 'md',
  kind = 'album',
}: {
  src: string | null | undefined
  alt?: string
  className?: string
  rounded?: 'sm' | 'md' | 'full'
  kind?: 'album' | 'artist'
}) {
  // Tracked per address, so a new cover fades in again and a broken one doesn't hide the next.
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const radius = rounded === 'full' ? 'rounded-full' : rounded === 'sm' ? 'rounded-sm' : 'rounded-md'
  const showImage = !!src && failed !== src
  return (
    <div className={clsx('relative aspect-square shrink-0 overflow-hidden bg-panel', radius, className)}>
      {(!showImage || loaded !== src) && (
        <div className="absolute inset-0 flex items-center justify-center text-subtle">
          {kind === 'artist' ? <UserRound className="size-1/3" strokeWidth={1.5} /> : <Disc3 className="size-1/3" strokeWidth={1.5} />}
        </div>
      )}
      {showImage && (
        <img
          key={src}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          ref={(image) => {
            if (image?.complete && image.naturalWidth > 0 && loaded !== src) setLoaded(src)
          }}
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
          className={clsx('relative size-full object-cover transition-opacity duration-300', loaded === src ? 'opacity-100' : 'opacity-0')}
        />
      )}
      <div className={clsx('pointer-events-none absolute inset-0 ring-1 ring-black/5 ring-inset dark:ring-white/5', radius)} />
    </div>
  )
}
