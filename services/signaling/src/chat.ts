/* Text chat: what a room (src/room.ts) and a party (src/party.ts) accept
   from a player and pass on to the others. Nothing here is stored beyond
   the room's or party's life.

   A message is one line of plain text. The server bounds its length, drops
   control characters, limits how often one player may speak, and masks the
   words on the profanity list before anyone else sees them. The client adds
   a per-player mute of its own (port/web/chat.js). */

export const CHAT_MAX_LENGTH = 200;
/* a player may send this many messages in each window */
export const CHAT_MESSAGES_PER_WINDOW = 5;
export const CHAT_WINDOW_MS = 10_000;
/* how many messages a party keeps for members who join or poll late */
export const PARTY_CHAT_HISTORY = 50;

/* C0 and C1 controls, the zero-width and bidirectional marks, the line and
   paragraph separators, and the byte-order mark: nothing a line of chat
   needs, and the way to fake a name or hide text. */
const UNWANTED_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/gu;

/* The text as it will be shown, or null when it is not a chat line: not a
   string, empty once trimmed, or too long. The length limit applies to the
   text as sent, so a client's maxlength matches it. */
export function normaliseChatText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > CHAT_MAX_LENGTH) return null;
  const text = value.replace(UNWANTED_CHARACTERS, "").replace(/\s+/gu, " ").trim();
  return text.length === 0 ? null : text;
}

/* ---------- the profanity filter

   A short list of the words that have no place in a game's chat: the
   slurs, and the common obscenities. Each is matched as a whole word after
   folding the common disguises (capitals, 0/1/3/4/5/7/@/$ for letters,
   stretched letters), with the usual endings. A matched word becomes
   asterisks of the same length; the rest of the line is untouched. It is
   a basic filter, not a complete one: players also have the mute. */
const BLOCKED_WORDS: readonly string[] = [
  "fuck", "shit", "cunt", "bitch", "asshole", "dick", "cock", "pussy", "whore", "slut",
  "motherfucker", "bastard", "wanker", "twat", "bollocks", "prick",
  "nigger", "nigga", "faggot", "fag", "retard", "retarded", "tranny", "kike", "spic", "chink",
  "wetback", "gook", "dyke", "coon", "raghead", "towelhead", "beaner",
];
const BLOCKED_SUFFIXES: readonly string[] = ["", "s", "es", "ed", "er", "ers", "ing", "in", "y", "head", "heads"];

const BLOCKED = new Set<string>();
for (const word of BLOCKED_WORDS) {
  for (const suffix of BLOCKED_SUFFIXES) BLOCKED.add(word + suffix);
}

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "l",
};

function fold(token: string): string {
  let out = "";
  for (const character of token.toLowerCase()) out += LEET[character] ?? character;
  return out;
}

/* "fuuuck" and "shiiit": every run of a letter down to one, and to two
   (for the words that have doubles). */
function isBlocked(token: string): boolean {
  const folded = fold(token);
  if (BLOCKED.has(folded)) return true;
  const toTwo = folded.replace(/(.)\1{2,}/gu, "$1$1");
  if (BLOCKED.has(toTwo)) return true;
  const toOne = folded.replace(/(.)\1+/gu, "$1");
  return BLOCKED.has(toOne);
}

/* a word: letters, digits and the symbols that stand in for letters;
   punctuation around a word is kept as it is */
const WORD = /[\p{L}\p{N}@$!|]+/gu;

export function censorChatText(text: string): string {
  return text.replace(WORD, (token) => {
    /* "$hit" is the word with a symbol for a letter; "FUCK!" is the word
       and its punctuation */
    if (isBlocked(token)) return "*".repeat(token.length);
    const edges = /^([@$!|]*)(.*?)([@$!|]*)$/su.exec(token)!;
    const [, before, core, after] = edges as unknown as [string, string, string, string];
    return isBlocked(core) ? `${before}${"*".repeat(core.length)}${after}` : token;
  });
}

/* ---------- the rate limit

   A fixed window per speaker, kept on whatever the caller stores for them
   (a socket's attachment, a party member). True when this message may go
   out; the counters are updated either way so a flood never resets them. */
export interface ChatRateState {
  chatCount?: number;
  chatWindowStartedAt?: number;
}

export function allowChat(state: ChatRateState, now: number): boolean {
  if (typeof state.chatWindowStartedAt !== "number" || now - state.chatWindowStartedAt >= CHAT_WINDOW_MS) {
    state.chatWindowStartedAt = now;
    state.chatCount = 0;
  }
  state.chatCount = (typeof state.chatCount === "number" ? state.chatCount : 0) + 1;
  return state.chatCount <= CHAT_MESSAGES_PER_WINDOW;
}
