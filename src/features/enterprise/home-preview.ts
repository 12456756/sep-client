/** Bound dashboard previews so dense data never turns the home page into a feed. */
export function createHomePreview<T>(items: readonly T[], limit: number): { items: T[]; remaining: number } {
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    items: items.slice(0, safeLimit),
    remaining: Math.max(0, items.length - safeLimit),
  };
}
