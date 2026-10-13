import { useEffect, useRef, useState } from 'react';

/** Large statement whose words light up one by one as they cross the middle of the viewport. */
export function TaglineReveal({ text }: { text: string }) {
  const words = text.split(' ');
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
            setActive((current) => Math.max(current, index + 1));
          }
        }
      },
      { rootMargin: '0px 0px -45% 0px' },
    );
    for (const element of refs.current) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="tagline" aria-label={text}>
      <p aria-hidden>
        {words.map((word, index) => (
          <span
            key={index}
            data-index={index}
            ref={(element) => {
              refs.current[index] = element;
            }}
            className={index < active ? 'is-lit' : undefined}
          >
            {word}{' '}
          </span>
        ))}
      </p>
    </section>
  );
}
