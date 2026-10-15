import { describe, expect, it } from 'vitest';
import {
  appendLines,
  CHAT_KEEP,
  type ChatLine,
  systemLine,
  toBlocks,
} from '../src/components/chat-lines.ts';

let next = 0;
const user = (text: string): ChatLine => ({
  key: `m:${next++}`,
  at: 0,
  text,
  from: { kind: 'user', name: 'Ada', username: 'ada' },
});
const note = (text: string) => systemLine(text);

const shape = (lines: ChatLine[]) =>
  toBlocks(lines).map((block) =>
    block.kind === 'line'
      ? block.line.text
      : `[${block.folded.map((line) => line.text).join(',')}] ${block.latest.text}`,
  );

describe('toBlocks', () => {
  it('shows up to two notes in a row as they are', () => {
    expect(shape([note('a'), note('b'), user('hi')])).toEqual(['a', 'b', 'hi']);
  });

  it('folds longer runs behind their latest note', () => {
    expect(shape([note('a'), note('b'), note('c'), note('d')])).toEqual(['[a,b,c] d']);
  });

  it('starts a new run after each message from a person or a bot', () => {
    expect(
      shape([note('a'), note('b'), note('c'), user('hi'), note('d'), note('e'), note('f')]),
    ).toEqual(['[a,b] c', 'hi', '[d,e] f']);
  });

  it('keeps the fold key while the run grows', () => {
    const first = note('a');
    const run = [first, note('b'), note('c')];
    const before = toBlocks(run)[0]!;
    const after = toBlocks([...run, note('d')])[0]!;
    expect(before.kind === 'fold' && after.kind === 'fold' && before.key === after.key).toBe(true);
  });
});

describe('appendLines', () => {
  it('drops a note that repeats the one right before it', () => {
    const lines = appendLines([note('Now watching A')], [note('Now watching A')]);
    expect(lines.map((line) => line.text)).toEqual(['Now watching A']);
  });

  it('keeps a repeated note once something else came in between', () => {
    const lines = appendLines([note('a')], [user('hi'), note('a')]);
    expect(lines.map((line) => line.text)).toEqual(['a', 'hi', 'a']);
  });

  it('ignores lines it already has and keeps the most recent ones', () => {
    const first = user('first');
    const many = Array.from({ length: CHAT_KEEP + 5 }, (_, index) => user(`m${index}`));
    const lines = appendLines([first], [first], many);
    expect(lines).toHaveLength(CHAT_KEEP);
    expect(lines.at(-1)!.text).toBe(`m${CHAT_KEEP + 4}`);
  });
});
