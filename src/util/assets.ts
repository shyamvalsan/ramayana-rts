// Resolve a public asset path against Vite's base URL so the game works both
// at the dev root (base '/') and under a GitHub Pages subpath (base
// '/ramayana-rts/'). Pass a path with or without a leading slash.
export function asset(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, '');
}
