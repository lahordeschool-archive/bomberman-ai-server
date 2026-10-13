import { Trash } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

export interface ConsoleLine {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'system';
  message: string;
  tick?: number;
}

export function ConsolePanel({ lines, onClear }: { lines: ConsoleLine[]; onClear: () => void }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [lines]);

  return (
    <div className="console">
      <div className="console-header">
        <h3>Console</h3>
        <button type="button" className="icon-button" onClick={onClear} aria-label="Clear console">
          <Trash />
        </button>
      </div>
      <ol className="console-lines mono" ref={list} aria-live="polite">
        {lines.length === 0 ? (
          <li className="console-empty">
            console.log output and errors from your bot show up here.
          </li>
        ) : (
          lines.map((line) => (
            <li key={line.id} className={`console-${line.level}`}>
              {line.tick !== undefined ? <span className="console-tick">t{line.tick}</span> : null}
              <span>{line.message}</span>
            </li>
          ))
        )}
      </ol>
    </div>
  );
}
