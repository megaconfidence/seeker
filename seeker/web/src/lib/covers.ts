// Deezer and the Cover Art Archive serve several sizes of each cover; pick one that suits where it's shown.
export function coverAt(url: string | null | undefined, size: 250 | 500 | 1000): string | null {
  if (!url) return null
  const caa = size === 1000 ? 1200 : size
  return url.replace(/\/(\d{2,4})x\1-/, `/${size}x${size}-`).replace(/\/front-(250|500|1200)$/, `/front-${caa}`)
}
