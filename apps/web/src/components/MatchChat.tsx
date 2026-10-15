import { MAX_CHAT_LENGTH } from '@bomberman/bot-sdk';
import { PLAYER_COLORS } from '@bomberman/game-engine';
import type { ChatAuthor, ChatMessage } from '@bomberman/protocol';
import {
  CaretDown,
  CaretRight,
  ChatsCircle,
  Eye,
  PaperPlaneRight,
  Robot,
} from '@phosphor-icons/react';
import { type FormEvent, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SLOT_COLOR_SWATCHES } from '../game/player-colors.ts';
import { emitWithAck } from '../lib/socket.ts';
import { type ChatLine, toBlocks } from './chat-lines.ts';

const SEND_COOLDOWN_MS = 1000;
const NAME_COLORS = ['#ff8a3d', '#6fd38f', '#56ccf2', '#f2c94c', '#e88ad8', '#ff7a7a', '#b4e06b'];

function nameColor(from: ChatAuthor): string {
  if (from.kind === 'bot') {
    return SLOT_COLOR_SWATCHES[PLAYER_COLORS[from.slot % PLAYER_COLORS.length]!];
  }
  let hash = 0;
  for (const char of from.username) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return NAME_COLORS[hash % NAME_COLORS.length]!;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function MatchChat({
  matchId,
  messages,
  username,
  closedNotice = 'Waiting for the next live match',
  viewers = null,
}: {
  /** `null` while nothing is on air: the chat is read only. */
  matchId: string | null;
  messages: ChatLine[];
  username: string;
  /** Why the chat is read only, while `matchId` is `null`. */
  closedNotice?: string;
  /** How many are watching, for example "3 viewers"; hidden when `null`. */
  viewers?: string | null;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (key: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  useEffect(() => {
    setError(null);
    pinned.current = true;
    if (!matchId) setText('');
  }, [matchId]);

  useLayoutEffect(() => {
    const node = list.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!cooling) return;
    const timer = setTimeout(() => setCooling(false), SEND_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [cooling]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const line = (input.current?.value ?? text).trim();
    if (!matchId || !line) return;
    if (cooling) {
      setError('One message per second, please.');
      return;
    }
    setCooling(true);
    setError(null);
    setText('');
    pinned.current = true;
    try {
      await emitWithAck<ChatMessage>('match:chat', { matchId, text: line });
    } catch (failure) {
      setText((current) => current || line);
      setError((failure as Error).message);
    }
  }

  const renderLine = (message: ChatLine) =>
    message.from.kind === 'system' ? (
      <li key={message.key} className="tv-chat-system">
        <span>{message.text}</span>
      </li>
    ) : (
      <li
        key={message.key}
        className={[
          'tv-chat-line',
          message.from.kind === 'bot' ? 'is-bot' : null,
          message.from.kind === 'user' && message.from.username === username ? 'is-me' : null,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <time className="mono" dateTime={new Date(message.at).toISOString()}>
          {clock.format(message.at)}
        </time>
        {message.from.kind === 'bot' ? <Robot className="tv-chat-bot" aria-label="Bot" /> : null}
        <strong style={{ color: nameColor(message.from) }}>{message.from.name}</strong>
        <span className="tv-chat-text">{message.text}</span>
      </li>
    );

  return (
    <aside className="tv-chat" aria-label="Live chat">
      <div className="tv-chat-inner">
        <header className="tv-chat-header">
          <ChatsCircle aria-hidden />
          <span>Live chat</span>
          {viewers ? (
            <span className="tv-chat-viewers" title="Watching this match right now">
              <Eye aria-hidden weight="bold" />
              {viewers}
            </span>
          ) : null}
        </header>
        <ol
          ref={list}
          className="tv-chat-list"
          aria-live="polite"
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
        >
          {messages.length === 0 ? (
            <li className="tv-chat-empty muted">
              {matchId ? 'Say hi. Bots can talk here too with SAY.' : `${closedNotice}.`}
            </li>
          ) : (
            toBlocks(messages).map((block) => {
              if (block.kind === 'line') return renderLine(block.line);
              const open = unfolded.has(block.key);
              return (
                <Fragment key={`fold:${block.key}`}>
                  <li className="tv-chat-fold">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleFold(block.key)}
                    >
                      {open ? <CaretDown aria-hidden /> : <CaretRight aria-hidden />}
                      {open
                        ? `Hide ${block.folded.length} earlier updates`
                        : `${block.folded.length} earlier updates · View all`}
                    </button>
                  </li>
                  {open ? block.folded.map(renderLine) : null}
                  {renderLine(block.latest)}
                </Fragment>
              );
            })
          )}
        </ol>
        <form className="tv-chat-form" onSubmit={send}>
          <input
            ref={input}
            value={text}
            maxLength={MAX_CHAT_LENGTH}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            placeholder={matchId ? 'Send a message' : closedNotice}
            aria-label="Chat message"
            disabled={!matchId}
          />
          <button type="submit" className="tv-chat-send" aria-label="Send" disabled={!matchId}>
            <PaperPlaneRight weight="fill" />
          </button>
        </form>
        {error ? (
          <p className="tv-chat-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
