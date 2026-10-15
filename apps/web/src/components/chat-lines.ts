import type { ChatAuthor, ChatMessage } from '@bomberman/protocol';

/** Lines kept across matches; older ones drop off so the chat never piles up. */
export const CHAT_KEEP = 100;
/** Longest run of TV notes shown in full; longer runs fold all but their latest note. */
export const VISIBLE_NOTES = 2;

/** A chat line as shown: a message from a match, or a note from the TV itself. */
export interface ChatLine {
  key: string;
  at: number;
  text: string;
  from: ChatAuthor | { kind: 'system' };
}

export const chatLine = (message: ChatMessage): ChatLine => ({
  key: `${message.matchId}:${message.id}`,
  at: message.at,
  text: message.text,
  from: message.from,
});

export const systemLine = (text: string): ChatLine => ({
  key: `system:${crypto.randomUUID()}`,
  at: Date.now(),
  text,
  from: { kind: 'system' },
});

/**
 * Adds lines the chat does not show yet, keeping the most recent ones. A TV note that
 * repeats the one right before it is dropped.
 */
export function appendLines(lines: ChatLine[], ...batches: ChatLine[][]): ChatLine[] {
  const seen = new Set(lines.map((line) => line.key));
  const next = [...lines];
  for (const line of batches.flat()) {
    if (seen.has(line.key)) continue;
    const previous = next.at(-1);
    if (
      line.from.kind === 'system' &&
      previous?.from.kind === 'system' &&
      previous.text === line.text
    ) {
      continue;
    }
    seen.add(line.key);
    next.push(line);
  }
  return next.length === lines.length ? lines : next.slice(-CHAT_KEEP);
}

/** The text of the most recent TV note, if any. */
export const lastNote = (lines: ChatLine[]): string | null =>
  lines.findLast((line) => line.from.kind === 'system')?.text ?? null;

const isChatLine = (value: unknown): value is ChatLine => {
  const line = value as Partial<ChatLine> | null;
  return (
    typeof line?.key === 'string' &&
    typeof line.at === 'number' &&
    typeof line.text === 'string' &&
    typeof line.from?.kind === 'string'
  );
};

/** Restores the chat saved by {@link saveLines}; anything unreadable starts it empty. */
export function loadLines(storageKey: string): ChatLine[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(saved) ? saved.filter(isChatLine).slice(-CHAT_KEEP) : [];
  } catch {
    return [];
  }
}

/** Keeps the chat across page loads; storage being full or blocked only loses the history. */
export function saveLines(storageKey: string, lines: ChatLine[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(lines.slice(-CHAT_KEEP)));
  } catch {
    // The live chat keeps working without it.
  }
}

export type ChatBlock =
  | { kind: 'line'; line: ChatLine }
  | { kind: 'fold'; key: string; folded: ChatLine[]; latest: ChatLine };

/** Groups consecutive TV notes so they never crowd out what people and bots say. */
export function toBlocks(lines: ChatLine[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let run: ChatLine[] = [];
  const flush = () => {
    if (run.length > VISIBLE_NOTES) {
      blocks.push({
        kind: 'fold',
        key: run[0]!.key,
        folded: run.slice(0, -1),
        latest: run.at(-1)!,
      });
    } else {
      for (const line of run) blocks.push({ kind: 'line', line });
    }
    run = [];
  };
  for (const line of lines) {
    if (line.from.kind === 'system') {
      run.push(line);
    } else {
      flush();
      blocks.push({ kind: 'line', line });
    }
  }
  flush();
  return blocks;
}
