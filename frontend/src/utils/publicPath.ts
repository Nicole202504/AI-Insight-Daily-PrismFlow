export function publicPath(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  const cleanPath = path.replace(/^\/+/, '');
  return `${cleanBase}${cleanPath}`;
}

export function publicAssetUrl(url: string): string {
  if (!url) return url;
  if (/^(https?:|data:|blob:|mailto:|#)/i.test(url)) return url;
  return publicPath(url);
}
