import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { send } from '@/lib/messages';
import { describeElement } from '@/lib/describe-element';
import type { CommentKind, FeedbackComment, FeedbackSession, Rect } from '@/lib/types';
import { probeComponents, requestContext } from './bridge-client';
import { captureScreenshots } from './capture';
import { startRecorder } from './recorder';
import { ConfirmButton } from '@/components/ConfirmButton';

type Mode = 'idle' | 'pick' | 'region';

interface Draft {
  kind: CommentKind;
  element?: Element;
  /** Viewport rect at the time of selection. */
  rect?: Rect;
}

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });
const samePage = (a: string, b: string) => {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Hold to comment: Ctrl+Alt (Windows/Linux), ⌘+⌥ on macOS where Ctrl+click is the context menu. */
const HOLD_LABEL = isMac ? '⌘+⌥' : 'Strg+Alt';
function holdPressed(e: KeyboardEvent | MouseEvent): boolean {
  // AltGr is reported as Ctrl+Alt on Windows; typing "@" or "€" must not trigger the picker.
  if (e.getModifierState?.('AltGraph') || e.shiftKey) return false;
  return isMac ? e.metaKey && e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
}

type Drawer = 'note' | 'list' | null;

export function App({ host }: { host: HTMLElement }) {
  const [session, setSession] = useState<FeedbackSession | null>(null);
  // Picker is active while the hold keys are pressed, or for a single pick after clicking "Kommentar".
  const [held, setHeld] = useState(false);
  const [oneShot, setOneShot] = useState(false);
  const [regionActive, setRegionActive] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const mode: Mode = !session?.active || draft ? 'idle' : regionActive ? 'region' : held || oneShot ? 'pick' : 'idle';

  // Render in the browser's top layer so we stay above any z-index, modal or popover of the page.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !session) return;
    const raise = () => {
      if (!root.isConnected) return;
      try {
        if (root.matches(':popover-open')) root.hidePopover();
        root.showPopover();
      } catch {
        // popover API unavailable: CSS z-index fallback applies
      }
    };
    raise();
    // Elements the page adds to the top layer later (dialog.showModal, popovers) would cover us: re-raise.
    let scheduled = false;
    const schedule = (ev?: Event) => {
      if (ev && ev.composedPath().includes(host)) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        raise();
      });
    };
    const observer = new MutationObserver(() => schedule());
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('toggle', schedule, true);
    document.addEventListener('fullscreenchange', schedule);
    return () => {
      observer.disconnect();
      document.removeEventListener('toggle', schedule, true);
      document.removeEventListener('fullscreenchange', schedule);
    };
  }, [!!session, host]);

  const isOwnUi = useCallback((ev: Event) => ev.composedPath().includes(host), [host]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  // Session state is owned by the background; mirror it from storage.
  useEffect(() => {
    // A storage change can arrive before the initial read resolves; never let the stale read win.
    let changed = false;
    send({ type: 'session:get' }).then((s) => !changed && setSession(s), () => undefined);
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !('session' in changes)) return;
      changed = true;
      setSession((changes.session.newValue as FeedbackSession) ?? null);
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => startRecorder(() => !!sessionRef.current?.active, isOwnUi), [isOwnUi]);

  // Keyboard command from the background (Alt+Shift+C): pick one element
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if ((msg as { type?: string })?.type !== 'command') return;
      if (!sessionRef.current?.active) send({ type: 'session:start' });
      setDraft(null);
      setRegionActive(false);
      setOneShot((v) => !v);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  // Hold-to-comment
  useEffect(() => {
    if (!session?.active) return;
    const sync = (e: KeyboardEvent | MouseEvent) => setHeld(holdPressed(e));
    const release = () => setHeld(false);
    window.addEventListener('keydown', sync, true);
    window.addEventListener('keyup', sync, true);
    window.addEventListener('mousemove', sync, true); // catches keys released while the window had no focus
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', sync, true);
      window.removeEventListener('keyup', sync, true);
      window.removeEventListener('mousemove', sync, true);
      window.removeEventListener('blur', release);
    };
  }, [session?.active]);

  // ---- Element picker -------------------------------------------------------
  const hoverEl = useRef<Element | null>(null);
  useEffect(() => {
    if (mode !== 'pick') {
      hoverEl.current = null;
      setHover(null);
      return;
    }
    const targetOf = (ev: Event) => {
      const t = ev.composedPath()[0];
      return t instanceof Element && !isOwnUi(ev) ? t : null;
    };
    const onMove = (ev: MouseEvent) => {
      const el = targetOf(ev);
      hoverEl.current = el;
      setHover(el ? toRect(el.getBoundingClientRect()) : null);
    };
    const onScroll = () => hoverEl.current && setHover(toRect(hoverEl.current.getBoundingClientRect()));
    const block = (ev: Event) => {
      if (isOwnUi(ev)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    const onClick = (ev: MouseEvent) => {
      if (isOwnUi(ev)) return;
      block(ev);
      const el = hoverEl.current ?? targetOf(ev);
      if (!el) return;
      setOneShot(false);
      setDraft({ kind: 'element', element: el, rect: toRect(el.getBoundingClientRect()) });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOneShot(false);
      // ArrowUp selects the parent of the hovered element (for wrappers that are hard to hit)
      if (ev.key === 'ArrowUp' && hoverEl.current?.parentElement && hoverEl.current.parentElement !== document.body) {
        ev.preventDefault();
        hoverEl.current = hoverEl.current.parentElement;
        setHover(toRect(hoverEl.current.getBoundingClientRect()));
      }
    };
    // When the picker is entered by holding keys, highlight what is under the cursor right away
    const last = lastPointer.current;
    if (last) {
      const el = document.elementsFromPoint(last.x, last.y).find((e) => e !== host && !host.contains(e));
      if (el) {
        hoverEl.current = el;
        setHover(toRect(el.getBoundingClientRect()));
      }
    }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('click', onClick, true);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu'] as const) {
      window.addEventListener(t, block, true);
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('click', onClick, true);
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu'] as const) {
        window.removeEventListener(t, block, true);
      }
      window.removeEventListener('keydown', onKey, true);
    };
  }, [mode, isOwnUi, host]);

  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const track = (e: MouseEvent) => (lastPointer.current = { x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', track, true);
    return () => window.removeEventListener('mousemove', track, true);
  }, []);

  // ---- Drawer (note / list) that grows out of the toolbar on hover ------------
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [drawerPinned, setDrawerPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverDrawer = (d: Drawer, delay: number) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setDrawer(d), delay);
  };
  const toggleDrawer = (d: Exclude<Drawer, null>) => {
    clearTimeout(hoverTimer.current);
    if (drawer === d && drawerPinned) {
      setDrawer(null);
      setDrawerPinned(false);
    } else {
      setDrawer(d);
      setDrawerPinned(true);
    }
  };
  const closeDrawer = () => {
    clearTimeout(hoverTimer.current);
    setDrawer(null);
    setDrawerPinned(false);
  };

  // ---- Saving ---------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const saveComment = async (d: Draft, text: string): Promise<boolean> => {
    if (!session) return false;
    setSaving(true);
    try {
      let element = undefined;
      let rect = d.rect;
      if (d.element?.isConnected) {
        element = { ...describeElement(d.element), ...(await probeComponents(d.element)) };
        rect = element.viewportRect;
      } else if (d.kind === 'region' && rect) {
        // Give the agent a code anchor for the area: the innermost page element at its center
        const center = document
          .elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          .find((el) => el !== host && !host.contains(el) && el !== document.documentElement && el !== document.body);
        if (center) element = { ...describeElement(center), ...(await probeComponents(center)) };
      }
      const [metadata, screenshots] = await Promise.all([
        requestContext(),
        captureScreenshots(rootRef.current!, rect, (session.comments.at(-1)?.index ?? 0) + 1),
      ]);
      await send({
        type: 'comment:add',
        comment: {
          kind: d.kind,
          text,
          createdAt: Date.now(),
          url: location.href,
          pageTitle: document.title,
          element,
          region: d.kind === 'region' ? rect : undefined,
          metadata,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: Math.round(window.devicePixelRatio * 100) / 100,
            scrollX: Math.round(window.scrollX),
            scrollY: Math.round(window.scrollY),
          },
        },
        screenshots,
      });
      return true;
    } catch (err) {
      notify(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const exportFolder = async () => {
    try {
      const res = await send({ type: 'export:folder' });
      notify(res.copied ? `Exportiert · Pfad kopiert: ${res.path}` : `${res.files} Dateien in Downloads/${res.folder} gespeichert`);
    } catch (err) {
      notify(`Export fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
    }
  };

  const copyMarkdown = async () => {
    const md = await send({ type: 'export:markdown' });
    notify((await send({ type: 'clipboard:copy', text: md })) ? 'Markdown kopiert (ohne Screenshots)' : 'Kopieren fehlgeschlagen');
  };

  if (!session) return null;

  const commentsHere = session.comments.filter((c) => samePage(c.url, location.href));
  const listButton = (
    <button
      className={drawer === 'list' ? 'af-on-soft' : ''}
      onMouseEnter={() => hoverDrawer('list', 120)}
      onClick={() => toggleDrawer('list')}
    >
      Liste
    </button>
  );

  return (
    <div className="af-root" ref={rootRef} popover="manual">
      {mode === 'pick' && hover && <div className="af-highlight" style={rectStyle(hover)} />}
      {mode === 'region' && (
        <RegionSelector
          onCancel={() => setRegionActive(false)}
          onSelect={(rect) => {
            setRegionActive(false);
            setDraft({ kind: 'region', rect });
          }}
        />
      )}
      {!draft && (
        <Pins
          comments={commentsHere}
          onClick={() => {
            setDrawer('list');
            setDrawerPinned(true);
          }}
        />
      )}
      {draft && (
        <>
          {draft.rect && <div className="af-highlight af-selected" style={rectStyle(draft.rect)} />}
          <Composer
            anchor={draft.rect}
            kind={draft.kind}
            saving={saving}
            onCancel={() => setDraft(null)}
            onSave={async (text) => {
              if (await saveComment(draft, text)) setDraft(null);
            }}
          />
        </>
      )}

      <div
        className="af-dock"
        onMouseEnter={() => clearTimeout(hoverTimer.current)}
        onMouseLeave={() => !drawerPinned && hoverDrawer(null, 350)}
      >
        <div className={`af-drawer${drawer ? ' af-open' : ''}`}>
          <div className="af-drawer-inner">
            {drawer === 'note' && (
              <NoteForm
                saving={saving}
                onEngage={() => setDrawerPinned(true)}
                onCancel={closeDrawer}
                onSave={async (text) => {
                  if (await saveComment({ kind: 'note' }, text)) closeDrawer();
                }}
              />
            )}
            {drawer === 'list' && <CommentList session={session} onEngage={() => setDrawerPinned(true)} />}
          </div>
        </div>

        <div className="af-toolbar">
          {session.active ? (
            <>
              <span className="af-rec" title="Session läuft">
                <span className="af-dot" /> {session.comments.length}
              </span>
              <button
                className={oneShot ? 'af-on' : ''}
                title={`Ein Element kommentieren – oder ${HOLD_LABEL} gedrückt halten und klicken`}
                onClick={() => {
                  setDraft(null);
                  setRegionActive(false);
                  setOneShot(!oneShot);
                }}
              >
                + Kommentar
              </button>
              <button
                className={mode === 'region' ? 'af-on' : ''}
                title="Bereich markieren"
                onClick={() => {
                  setDraft(null);
                  setOneShot(false);
                  setRegionActive(!regionActive);
                }}
              >
                Bereich
              </button>
              <button
                className={drawer === 'note' ? 'af-on-soft' : ''}
                title="Allgemeine Notiz zur Seite"
                onMouseEnter={() => hoverDrawer('note', 120)}
                onClick={() => toggleDrawer('note')}
              >
                Notiz
              </button>
              <span className="af-sep" />
              {listButton}
              <button className="af-primary" onClick={() => send({ type: 'session:stop' })}>
                Fertig
              </button>
            </>
          ) : (
            <>
              <span className="af-label">Beendet · {session.comments.length}</span>
              <button className="af-primary" onClick={exportFolder}>
                Exportieren
              </button>
              <button onClick={copyMarkdown}>Markdown kopieren</button>
              {listButton}
              <button onClick={() => send({ type: 'session:resume' })}>Fortsetzen</button>
              <ConfirmButton
                label="Verwerfen"
                question="Alle verwerfen?"
                className="af-danger"
                onConfirm={() => send({ type: 'session:discard' })}
              />
            </>
          )}
        </div>
      </div>
      {mode === 'region' && <div className="af-hint">Bereich aufziehen · Esc abbrechen</div>}
      {oneShot && mode === 'pick' && <div className="af-hint">Element anklicken · ↑ Elternelement · Esc abbrechen</div>}
      {toast && <div className="af-toast">{toast}</div>}
    </div>
  );
}

function rectStyle(r: Rect): React.CSSProperties {
  return { left: r.x, top: r.y, width: r.width, height: r.height };
}

function RegionSelector({ onSelect, onCancel }: { onSelect: (r: Rect) => void; onCancel: () => void }) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const toR = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });

  return (
    <div
      className="af-region-layer"
      onMouseDown={(e) => {
        setStart({ x: e.clientX, y: e.clientY });
        setRect(null);
      }}
      onMouseMove={(e) => start && setRect(toR(start, { x: e.clientX, y: e.clientY }))}
      onMouseUp={(e) => {
        if (!start) return;
        const r = toR(start, { x: e.clientX, y: e.clientY });
        setStart(null);
        if (r.width > 8 && r.height > 8) onSelect(r);
        else setRect(null);
      }}
    >
      {rect && <div className="af-highlight af-selected" style={rectStyle(rect)} />}
    </div>
  );
}

function Composer(props: {
  anchor?: Rect;
  kind: CommentKind;
  saving: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    const w = box?.width ?? 320;
    const h = box?.height ?? 160;
    const a = props.anchor;
    if (!a) {
      setPos({ left: window.innerWidth / 2 - w / 2, top: window.innerHeight / 2 - h / 2 });
      return;
    }
    let top = a.y + a.height + 10;
    if (top + h > window.innerHeight - 70) top = a.y - h - 10;
    top = Math.max(10, Math.min(top, window.innerHeight - h - 70));
    const left = Math.max(10, Math.min(a.x, window.innerWidth - w - 10));
    setPos({ left, top });
  }, [props.anchor]);

  const title = { element: 'Kommentar zum Element', region: 'Kommentar zum Bereich', note: 'Notiz zur Seite' }[props.kind];

  return (
    <div className="af-composer" ref={ref} style={pos}>
      <div className="af-composer-title">{title}</div>
      <textarea
        autoFocus
        value={text}
        placeholder="Was soll sich ändern?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) props.onSave(text.trim());
        }}
      />
      <div className="af-composer-actions">
        <span className="af-muted">⌘/Strg + Enter</span>
        <button onClick={props.onCancel}>Abbrechen</button>
        <button className="af-primary" disabled={!text.trim() || props.saving} onClick={() => props.onSave(text.trim())}>
          {props.saving ? 'Speichere…' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

/** Numbered markers on elements that already have a comment on this page. */
function Pins({ comments, onClick }: { comments: FeedbackComment[]; onClick: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const timer = setInterval(update, 1000);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      {comments.map((c) => {
        let left: number | undefined;
        let top: number | undefined;
        if (c.element) {
          let el: Element | null = null;
          try {
            el = document.querySelector(c.element.selector);
          } catch {
            // selector may be an xpath fallback
          }
          if (el) {
            const r = el.getBoundingClientRect();
            left = r.left;
            top = r.top;
          } else {
            left = c.element.documentRect.x - window.scrollX;
            top = c.element.documentRect.y - window.scrollY;
          }
        } else if (c.region) {
          left = c.region.x + c.viewport.scrollX - window.scrollX;
          top = c.region.y + c.viewport.scrollY - window.scrollY;
        }
        if (left == null || top == null) return null;
        return (
          <button
            key={c.id}
            className="af-pin"
            style={{ left: Math.max(4, left - 11), top: Math.max(4, top - 11) }}
            title={c.text}
            onClick={onClick}
          >
            {c.index}
          </button>
        );
      })}
    </>
  );
}

function NoteForm(props: {
  saving: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onEngage: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="af-drawer-section">
      <div className="af-composer-title">Notiz zur Seite</div>
      <textarea
        value={text}
        placeholder="Allgemeines Feedback zu dieser Seite…"
        onFocus={props.onEngage}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) props.onSave(text.trim());
        }}
      />
      <div className="af-composer-actions">
        <span className="af-muted">⌘/Strg + Enter</span>
        <button className="af-primary" disabled={!text.trim() || props.saving} onClick={() => props.onSave(text.trim())}>
          {props.saving ? 'Speichere…' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

function CommentList({ session, onEngage }: { session: FeedbackSession; onEngage: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const path = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };

  return (
    <div className="af-drawer-section af-list">
      {!session.comments.length && <p className="af-muted">Noch keine Kommentare.</p>}
      {session.comments.map((c) => (
        <div key={c.id} className="af-item">
          <div className="af-item-head">
            <span className="af-badge">{c.index}</span>
            <span className="af-muted">
              {path(c.url)} ·{' '}
              {c.kind === 'region'
                ? 'Bereich'
                : c.element
                ? c.element.name
                  ? `${c.element.role ?? c.element.tag} "${c.element.name}"`
                  : c.element.tag
                : 'Notiz'}
            </span>
          </div>
          {editing === c.id ? (
            <>
              <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} />
              <div className="af-composer-actions">
                <button onClick={() => setEditing(null)}>Abbrechen</button>
                <button
                  className="af-primary"
                  onClick={async () => {
                    await send({ type: 'comment:update', id: c.id, text });
                    setEditing(null);
                  }}
                >
                  Speichern
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="af-item-text">{c.text}</p>
              <div className="af-item-actions">
                <button
                  onClick={() => {
                    onEngage();
                    setEditing(c.id);
                    setText(c.text);
                  }}
                >
                  Bearbeiten
                </button>
                <button className="af-danger" onClick={() => send({ type: 'comment:delete', id: c.id })}>
                  Löschen
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
