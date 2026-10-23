import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { send } from '@/lib/messages';
import type { FeedbackSession } from '@/lib/types';
import { ConfirmButton } from '@/components/ConfirmButton';

export function Popup() {
  const [session, setSession] = useState<FeedbackSession | null | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);

  const [shortcut, setShortcut] = useState<string | null | undefined>(undefined);
  const refresh = () => send({ type: 'session:get' }).then(setSession);
  useEffect(() => {
    refresh();
    browser.commands.getAll().then((cmds) => setShortcut(cmds.find((c) => c.name === 'toggle-picker')?.shortcut || null));
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    refresh();
  };

  if (session === undefined) return null;

  return (
    <main>
      <h1>Agent Feedback</h1>
      {!session && (
        <>
          <p className="muted">Starte eine Session, klick dich durch die App und kommentiere, was dir auffällt.</p>
          <button className="primary" onClick={() => run(() => send({ type: 'session:start' })).then(() => window.close())}>
            Session starten
          </button>
        </>
      )}
      {session && (
        <>
          <p>
            {session.active ? '● Session läuft' : 'Session beendet'} · {session.comments.length} Kommentare ·{' '}
            {session.timeline.length} Schritte
          </p>
          {session.active ? (
            <button onClick={() => run(() => send({ type: 'session:stop' }))}>Session beenden</button>
          ) : (
            <button onClick={() => run(() => send({ type: 'session:resume' }))}>Fortsetzen</button>
          )}
          <button
            className="primary"
            onClick={() =>
              run(async () => {
                const res = await send({ type: 'export:folder' });
                setStatus(res.copied ? `Pfad kopiert: ${res.path}` : `Gespeichert in Downloads/${res.folder}`);
              })
            }
          >
            Exportieren
          </button>
          <div className="row">
            <ConfirmButton
              label="Verwerfen"
              question="Wirklich verwerfen?"
              className="danger"
              onConfirm={() => run(() => send({ type: 'session:discard' }))}
            />
          </div>
        </>
      )}
      {status && <p className="status">{status}</p>}
      {shortcut !== undefined && (
        <p className="muted small">
          {shortcut ? `${shortcut}: Kommentieren an/aus · ` : 'Kein Shortcut zugewiesen · '}
          <a href="#" onClick={() => browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
            {shortcut ? 'ändern' : 'festlegen'}
          </a>
        </p>
      )}
    </main>
  );
}
