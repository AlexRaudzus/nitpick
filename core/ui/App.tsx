import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeElement } from '../describe-element';
import type { FeedbackHost } from '../host';
import type { CommentKind, ElementDescriptor, FeedbackComment, FeedbackSession, Rect } from '../types';
import { captureScreenshots } from './capture';
import { ConfirmButton } from './ConfirmButton';
import { HOLD_LABEL, holdPressed, SHORTCUTS, type Command } from './keys';
import { startRecorder } from './recorder';

type Mode = 'idle' | 'pick' | 'region';

interface Draft {
  kind: CommentKind;
  element?: Element;
  /** Already described elsewhere (picked inside an iframe). */
  described?: ElementDescriptor;
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

type Drawer = 'note' | 'list' | null;


/**
 * Toolbar, picker and composer. `host` is the shadow host element of the UI (used to tell our own
 * events apart from the page's), `api` connects it to the extension or the embed.
 */
export function App({ host, api }: { host: HTMLElement; api: FeedbackHost }) {
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

  // Session state is owned by the host (service worker / IndexedDB); mirror it.
  useEffect(() => {
    // A change can arrive before the initial read resolves; never let the stale read win.
    let changed = false;
    api.load().then((s) => !changed && setSession(s), () => undefined);
    return api.subscribe((s) => {
      changed = true;
      setSession(s);
    });
  }, [api]);

  useEffect(() => startRecorder(api, () => !!sessionRef.current?.active, isOwnUi), [api, isOwnUi]);

  // Shortcuts: everything except picking is bound late (needs drawer/export helpers defined below).
  const commandRef = useRef<(cmd: Command) => void>(() => undefined);
  useEffect(
    () =>
      api.onCommand?.((cmd) => {
        if (cmd === 'pick' && !sessionRef.current?.active) api.start();
        commandRef.current(cmd);
      }),
    [api],
  );
  // While holding the comment keys: Ctrl+Alt+B/N/K/H/E (⌘⌥ on macOS)
  useEffect(() => {
    if (!session?.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!holdPressed(e)) return;
      const cmd = SHORTCUTS[e.code];
      if (!cmd) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) commandRef.current(cmd);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session?.active]);

  // A session that was just started in headless mode shows nothing else, so say that it runs
  // (unless a toast is already up, e.g. the export message after an export restarted the session).
  useEffect(() => {
    if (!session?.active || !session.hidden || session.comments.length) return;
    if (Date.now() - session.startedAt > 3000) return;
    setToast((t) => t ?? `Feedback-Session läuft im Hintergrund · ${HOLD_LABEL} halten zum Kommentieren`);
    setTimeout(() => setToast((t) => (t?.startsWith('Feedback-Session läuft') ? null : t)), 3500);
  }, [session?.id]);

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

  // Pickers inside iframes: tell them when picking is on, take over their hover/pick/keys
  useEffect(() => api.frames?.setPickerActive(mode === 'pick'), [api, mode]);
  useEffect(
    () =>
      api.frames?.onEvent((e) => {
        if (e.type === 'held') setHeld(e.held);
        else if (e.type === 'shortcut') {
          const cmd = SHORTCUTS[e.code];
          if (cmd && sessionRef.current?.active) commandRef.current(cmd);
        } else if (e.type === 'escape') setOneShot(false);
        else if (e.type === 'hover') {
          hoverEl.current = null;
          setHover(e.rect);
        } else if (e.type === 'picked') {
          setOneShot(false);
          setHeld(false);
          setDraft({ kind: 'element', described: e.element, rect: e.rect });
        }
      }),
    [api],
  );

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
  const saveComment = async (d: Draft, text: string): Promise<FeedbackComment | null> => {
    commandRef.current = (cmd) => {
    const s = sessionRef.current;
    if (!s) return;
    switch (cmd) {
      case 'pick':
        setDraft(null);
        setRegionActive(false);
        setOneShot((v) => !v);
        return;
      case 'region':
        setDraft(null);
        setOneShot(false);
        setRegionActive((v) => !v);
        return;
      case 'note':
      case 'list':
        if (drawer === cmd && drawerPinned) closeDrawer();
        else {
          clearTimeout(hoverTimer.current);
          setDrawer(cmd);
          setDrawerPinned(true);
        }
        return;
      case 'toggle-toolbar':
        api.setHidden(!s.hidden);
        return;
      case 'export': {
        const primary = api.finishActions[0];
        if (!s.comments.length) notify('Noch keine Kommentare zum Exportieren');
        else if (primary) runAction(primary.run);
        return;
      }
    }
  };

  if (!session) return null;
  // Headless mode only applies while recording; a finished session always shows its actions.
  const hidden = session.active && !!session.hidden;
    setSaving(true);
    try {
      let element = undefined;
      let rect = d.rect;
      if (d.described) {
        element = d.described;
      } else if (d.element?.isConnected) {
        element = { ...describeElement(d.element), ...(await api.probeComponents(d.element)) };
        rect = element.viewportRect;
      } else if (d.kind === 'region' && rect) {
        // Give the agent a code anchor for the area: the innermost page element at its center
        const center = document
          .elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          .find((el) => el !== host && !host.contains(el) && el !== document.documentElement && el !== document.body);
        if (center) element = { ...describeElement(center), ...(await api.probeComponents(center)) };
      }
      const [metadata, screenshots] = await Promise.all([
        api.requestContext(),
        captureScreenshots(() => api.captureViewport(), rootRef.current!, rect, (session.comments.at(-1)?.index ?? 0) + 1),
      ]);
      const created = await api.addComment(
        {
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
      );
      if (sessionRef.current?.hidden) notify(`Kommentar ${created.index} gespeichert`);
      // Show it right away; the authoritative state follows via subscribe
      const s = sessionRef.current;
      if (s && !s.comments.some((c) => c.id === created.id)) {
        sessionRef.current = { ...s, comments: [...s.comments, created] };
        setSession(sessionRef.current);
      }
      return created;
    } catch (err) {
      notify(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      setSaving(false);
    }
  };

  // One note per page, saved automatically: edits update it, emptying it deletes it.
  const noteQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pageNote = () =>
    sessionRef.current?.comments.findLast((c) => c.kind === 'note' && samePage(c.url, location.href));
  const persistNote = (raw: string) => {
    const text = raw.trim();
    const run = async () => {
      const existing = pageNote();
      if (existing) {
        if (!text) await api.deleteComment(existing.id);
        else if (text !== existing.text) await api.updateComment(existing.id, text);
      } else if (text && sessionRef.current?.active) {
        await saveComment({ kind: 'note' }, text);
      }
    };
    noteQueue.current = noteQueue.current.then(run, run);
    return noteQueue.current;
  };

  const runAction = async (run: () => Promise<string | void>) => {
    try {
      const msg = await run();
      if (msg) notify(msg);
    } catch (err) {
      notify(`Fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
    }
  };

  commandRef.current = (cmd) => {
    const s = sessionRef.current;
    if (!s) return;
    switch (cmd) {
      case 'pick':
        setDraft(null);
        setRegionActive(false);
        setOneShot((v) => !v);
        return;
      case 'region':
        setDraft(null);
        setOneShot(false);
        setRegionActive((v) => !v);
        return;
      case 'note':
      case 'list':
        if (drawer === cmd && drawerPinned) closeDrawer();
        else {
          clearTimeout(hoverTimer.current);
          setDrawer(cmd);
          setDrawerPinned(true);
        }
        return;
      case 'toggle-toolbar':
        api.setHidden(!s.hidden);
        return;
      case 'export': {
        const primary = api.finishActions[0];
        if (!s.comments.length) notify('Noch keine Kommentare zum Exportieren');
        else if (primary) runAction(primary.run);
        return;
      }
    }
  };

  if (!session) return null;
  // Headless mode only applies while recording; a finished session always shows its actions.
  const hidden = session.active && !!session.hidden;

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
      {!draft && (!hidden || held) && (
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

      {(!hidden || (drawer && drawerPinned)) && <div
        className={`af-dock${hidden ? ' af-dock-bare' : ''}`}
        onMouseEnter={() => clearTimeout(hoverTimer.current)}
        onMouseLeave={() => !drawerPinned && hoverDrawer(null, 350)}
      >
        <div className={`af-drawer${drawer ? ' af-open' : ''}`}>
          <div className="af-drawer-inner">
            {drawer === 'note' && (
              <NoteForm
                key={location.pathname}
                initial={pageNote()?.text ?? ''}
                exists={!!pageNote()}
                saving={saving}
                onEngage={() => setDrawerPinned(true)}
                autoFocus={drawerPinned}
                onClose={closeDrawer}
                onPersist={persistNote}
              />
            )}
            {drawer === 'list' && <CommentList api={api} session={session} onEngage={() => setDrawerPinned(true)} />}
          </div>
        </div>

        {!hidden && <div className="af-toolbar">
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
              <button className="af-primary" onClick={() => api.stop()}>
                Fertig
              </button>
              <button className="af-icon" title={`Toolbar ausblenden – alles per Tastenkürzel (${HOLD_LABEL}+H)`} onClick={() => api.setHidden(true)}>
                ⌄
              </button>
            </>
          ) : (
            <>
              <span className="af-label">Beendet · {session.comments.length}</span>
              {api.finishActions.map((a) => (
                <button key={a.label} className={a.primary ? 'af-primary' : ''} onClick={() => runAction(a.run)}>
                  {a.label}
                </button>
              ))}
              {listButton}
              <button onClick={() => api.resume()}>Fortsetzen</button>
              <ConfirmButton
                label="Verwerfen"
                question="Alle verwerfen?"
                className="af-danger"
                onConfirm={() => api.discard()}
              />
            </>
          )}
        </div>}
      </div>}
      {held && !oneShot && !draft && mode !== 'region' && (
        <div className="af-hint af-keys">
          <b>Klick</b> Element · <b>↑</b> Eltern · <b>B</b> Bereich · <b>N</b> Notiz · <b>K</b> Liste · <b>E</b> Export ·{' '}
          <b>H</b> Toolbar {hidden ? 'zeigen' : 'ausblenden'}
        </div>
      )}
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
            // Selectors of elements inside iframes are relative to the frame's document
            if (!c.element.frames) el = document.querySelector(c.element.selector);
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

/**
 * Page note without a save button: edits of an existing note are saved while typing; a new note is
 * created (with screenshot) when the field loses focus or the drawer closes/switches, so nothing typed is lost.
 */
function NoteForm(props: {
  initial: string;
  autoFocus?: boolean;
  exists: boolean;
  saving: boolean;
  onPersist: (text: string) => Promise<unknown>;
  onClose: () => void;
  onEngage: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const [dirty, setDirty] = useState(false);
  const latest = useRef({ text, dirty, persist: props.onPersist });
  latest.current = { text, dirty, persist: props.onPersist };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = () => {
    clearTimeout(timer.current);
    if (!latest.current.dirty) return;
    setDirty(false);
    latest.current.dirty = false;
    latest.current.persist(latest.current.text);
  };
  // Drawer closed or switched to the list: save what was typed
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (latest.current.dirty) latest.current.persist(latest.current.text);
    },
    [],
  );

  const status = props.saving ? 'Speichere…' : dirty ? (props.exists ? 'Ungespeichert…' : 'Wird beim Verlassen gespeichert') : props.exists ? 'Gespeichert' : '';
  return (
    <div className="af-drawer-section">
      <div className="af-composer-title">Notiz zur Seite</div>
      <textarea
        autoFocus={props.autoFocus}
        value={text}
        placeholder="Allgemeines Feedback zu dieser Seite…"
        onFocus={props.onEngage}
        onBlur={flush}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          clearTimeout(timer.current);
          // Updating an existing note needs no screenshot, so it can happen while typing
          if (props.exists) timer.current = setTimeout(flush, 600);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            flush();
            props.onClose();
          }
        }}
      />
      <div className="af-composer-actions">
        <span className="af-muted">{status}</span>
      </div>
    </div>
  );
}

function CommentList({ api, session, onEngage }: { api: FeedbackHost; session: FeedbackSession; onEngage: () => void }) {
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
                    await api.updateComment(c.id, text);
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
                <button className="af-danger" onClick={() => api.deleteComment(c.id)}>
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
