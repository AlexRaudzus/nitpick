import { useEffect, useState } from 'react';

/**
 * Two-step inline confirmation. Native confirm() is clipped inside the extension popup
 * and blocks the page, so we ask in place instead.
 */
export function ConfirmButton(props: { label: string; question: string; className?: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(timer);
  }, [asking]);

  if (!asking) {
    return (
      <button className={props.className} onClick={() => setAsking(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <>
      <span className="af-confirm-question">{props.question}</span>
      <button
        className={props.className}
        onClick={() => {
          setAsking(false);
          props.onConfirm();
        }}
      >
        Ja
      </button>
      <button onClick={() => setAsking(false)}>Nein</button>
    </>
  );
}
