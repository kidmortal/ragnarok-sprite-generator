/**
 * Hangul to Latin letters, so a name with no translation is still typeable.
 *
 * This is a transliteration, not the full Revised Romanization: RR respells
 * consonants across syllable boundaries (한국 is "Hanguk", not "Hangug"), and
 * those rules need to know where the words are, which a sprite file name does
 * not say. Letter-for-letter is what a search box wants anyway -- it is
 * reversible, so typing what you see gets you the file.
 *
 * Only precomposed syllables (U+AC00–U+D7A3) are converted; anything else is
 * passed through, which is why a name that is already Latin comes back
 * untouched.
 */

const BASE = 0xac00;
const LAST = 0xd7a3;

// The three jamo series a syllable block decomposes into, in code point order.
const INITIAL = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const MEDIAL = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const FINAL = ["","k","k","ks","n","nj","nh","t","l","lk","lm","lb","ls","lt","lp","lh","m","p","ps","t","t","ng","t","t","k","t","p","h"];

/** Whether a string contains any Hangul syllable. */
export const hasHangul = (text: string): boolean => /[가-힣]/.test(text);

/** One Hangul syllable in Latin letters, or null if it is not one. */
export function romaniseSyllable(codePoint: number): string | null {
  if (codePoint < BASE || codePoint > LAST) return null;
  const offset = codePoint - BASE;
  const final = offset % 28;
  const medial = Math.floor(offset / 28) % 21;
  const initial = Math.floor(offset / 28 / 21);
  return INITIAL[initial] + MEDIAL[medial] + FINAL[final];
}

/** Every Hangul syllable in a string transliterated; everything else kept. */
export function romanise(text: string): string {
  let out = "";
  for (const character of text.normalize("NFC")) {
    out += romaniseSyllable(character.codePointAt(0)!) ?? character;
  }
  return out;
}
