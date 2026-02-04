/**
 * Pluralize a word based on the count.
 * @param count - The count of the word.
 * @param word - The word to pluralize.
 * @returns The pluralized word.
 */
export function pluralize(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
