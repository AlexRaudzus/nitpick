import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeElement } from '../describe-element';
import type { FeedbackHost, FinishAction } from '../host';
import { readExportFolder, type ImportedExport } from '../import';
import type { CommentKind, ElementDescriptor, FeedbackComment, FeedbackSession, Rect } from '../types';
import { captureScreenshots } from './capture';
import { HOLD_LABEL, holdPressed, SHORTCUTS, type Command } from './keys';
import { startRecorder } from './recorder';
import { loadPageParams, pageLabel, queryParams, routeLikeParams, samePage, savePageParams, type PageParamsPref } from './page-params';

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

type Drawer = 'note' | 'list' | 'params' | null;


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
    if (!root || !(session || toast)) return;
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
  }, [!!session, !!toast, host]);

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
  // ---- Which query parameters distinguish pages on this site -----------------
  const [href, setHref] = useState(location.href);
  useEffect(() => {
    const update = () => setHref(location.href);
    const off = api.onPageEvent((e) => e.type === 'navigate' && update());
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      off();
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, [api]);
  const [pageParams, setPageParamsState] = useState<PageParamsPref>(loadPageParams);
  const pageParamsRef = useRef(pageParams);
  pageParamsRef.current = pageParams;
  const setPageParams = (params: string[]) => {
    const pref = { params, decided: true };
    savePageParams(pref);
    setPageParamsState(pref);
  };
  const suggestedParams = pageParams.decided ? [] : routeLikeParams(href).filter((p) => !pageParams.params.includes(p));

  const [drawer, setDrawer] = useState<Drawer>(null);
  const [drawerPinned, setDrawerPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverDrawer = (d: Drawer, delay: number) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setDrawer(d), delay);
  };
  // Mouse: open on hover/click, close when the pointer leaves the dock. Keyboard shortcuts and
  // marker clicks open it "pinned" (there is no hover to end), until the pointer has been in the dock once.
  const toggleDrawer = (d: Exclude<Drawer, null>) => {
    clearTimeout(hoverTimer.current);
    setDrawerPinned(false);
    setDrawer(drawer === d ? null : d);
  };
  const closeDrawer = () => {
    clearTimeout(hoverTimer.current);
    setDrawer(null);
    setDrawerPinned(false);
  };

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** A picked export waiting for "replace the current comments?" */
  const [pendingImport, setPendingImport] = useState<ImportedExport | null>(null);
  const asking = confirmDiscard || !!pendingImport;
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setConfirmDiscard(false);
      setPendingImport(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [asking]);
  // A new or resumed session never starts in the question
  useEffect(() => {
    setConfirmDiscard(false);
    setPendingImport(null);
  }, [session?.id, session?.active]);

  // ---- Import of a previous export ------------------------------------------
  const importInput = useRef<HTMLInputElement>(null);
  const runImport = (data: ImportedExport) =>
    runAction(async () => {
      setPendingImport(null);
      await api.importExport!(data);
      const n = data.session.comments.length;
      return `${n === 1 ? '1 Kommentar' : `${n} Kommentare`} importiert · Fortsetzen zum Weiterkommentieren`;
    });
  const onImportPicked = async (files: File[]) => {
    try {
      const data = await readExportFolder(files);
      if (sessionRef.current?.comments.length) setPendingImport(data);
      else runImport(data);
    } catch (err) {
      notify(`Import fehlgeschlagen: ${err instanceof Error ? err.message : err}`);
    }
  };
  const moreActions: MenuItem[] = [
    ...(api.importExport ? [{ label: 'Nitpick importieren…', run: () => importInput.current?.click() }] : []),
    {
      label: 'Seiten unterscheiden nach…',
      run: () => {
        // Opened from inside the dock: closes like a hovered drawer once the pointer leaves
        clearTimeout(hoverTimer.current);
        setDrawer('params');
        setDrawerPinned(false);
      },
    },
  ];

  // ---- Draggable dock (so elements behind it can be picked) -----------------
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockPos, setDockPos] = useState<DockPos | null>(loadDockPos);
  const saveDockPos = (pos: DockPos | null) => {
    setDockPos(pos);
    try {
      if (pos) localStorage.setItem(DOCK_KEY, JSON.stringify(pos));
      else localStorage.removeItem(DOCK_KEY);
    } catch {
      // storage blocked
    }
  };
  const startDrag = (e: React.PointerEvent) => {
    const dock = dockRef.current;
    if (!dock || e.button !== 0) return;
    e.preventDefault();
    const r = dock.getBoundingClientRect();
    const bar = dock.querySelector('.af-toolbar')!.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, top: bar.top };
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    let pos: DockPos = { right: from.right, top: from.top };
    const move = (ev: PointerEvent) => {
      pos = clampDock({ right: from.right - (ev.clientX - from.x), top: from.top + (ev.clientY - from.y) }, dock);
      setDockPos(pos);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      saveDockPos(pos);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  // ---- Saving ---------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const saveComment = async (d: Draft, text: string): Promise<FeedbackComment | null> => {
    if (!session) return null;
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
    sessionRef.current?.comments.findLast((c) => c.kind === 'note' && samePage(c.url, location.href, pageParamsRef.current.params));
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

  // The toast outlives the session, e.g. the export message after an export discarded it.
  if (!session)
    return toast ? (
      <div className="af-root" ref={rootRef} popover="manual">
        <div className="af-toast">{toast}</div>
      </div>
    ) : null;
  // Headless mode only applies while recording; a finished session always shows its actions.
  const hidden = session.active && !!session.hidden;

  const commentsHere = session.comments.filter((c) => samePage(c.url, href, pageParams.params));
  const listButton = (
    <button
      className={`af-list-btn${drawer === 'list' ? ' af-on-soft' : ''}`}
      aria-label={`Liste (${session.comments.length})`}
      title={`Kommentare (${HOLD_LABEL}+K)`}
      onMouseEnter={() => hoverDrawer('list', 120)}
      onClick={() => toggleDrawer('list')}
    >
      {session.active && <span className="af-dot" title="Session läuft" />}
      <ListIcon />
      <span className="af-rec">{session.comments.length}</span>
    </button>
  );
  // A finished session is reviewed: the list is simply always open.
  const shownDrawer: Drawer = session.active || drawer === 'params' ? drawer : 'list';
  const flipped = !!dockPos && dockPos.top < window.innerHeight / 2;

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
        ref={dockRef}
        className={`af-dock${hidden ? ' af-dock-bare' : ''}${flipped ? ' af-dock-top' : ''}${session.active ? '' : ' af-finished'}`}
        style={dockPos ? dockStyle(clampDock(dockPos, dockRef.current), toolbarHeight(dockRef.current)) : undefined}
        onMouseEnter={() => {
          clearTimeout(hoverTimer.current);
          setDrawerPinned(false);
        }}
        onMouseLeave={() => !drawerPinned && hoverDrawer(null, 350)}
      >
        <div className={`af-drawer${shownDrawer ? ' af-open' : ''}`}>
          <div className="af-drawer-inner">
            {shownDrawer === 'note' && (
              <NoteForm
                key={location.pathname}
                initial={pageNote()?.text ?? ''}
                exists={!!pageNote()}
                saving={saving}
                autoFocus={drawerPinned}
                onClose={closeDrawer}
                onPersist={persistNote}
              />
            )}
            {shownDrawer === 'list' && <CommentList api={api} session={session} href={href} pageParams={pageParams.params} />}
            {shownDrawer === 'params' && <PageParamsForm href={href} chosen={pageParams.params} onChange={setPageParams} />}
          </div>
        </div>

        {!hidden && !asking && suggestedParams.length > 0 && (
          <div className="af-suggest">
            <span>
              Diese Seite nutzt {suggestedParams.map((p, i) => (
                <span key={p}>
                  {i > 0 && ', '}
                  <code>{p}</code>
                </span>
              ))}{' '}
              wie eine Route. Kommentare danach trennen?
            </span>
            <span className="af-spacer" />
            <button className="af-ghost" onClick={() => setPageParams(pageParams.params)}>
              Nein
            </button>
            <button className="af-primary" onClick={() => setPageParams([...pageParams.params, ...suggestedParams])}>
              Trennen
            </button>
          </div>
        )}
        {!hidden && <div className="af-toolbar">
          <span
            className="af-grip"
            title="Verschieben · Doppelklick: zurücksetzen"
            onPointerDown={startDrag}
            onDoubleClick={() => saveDockPos(null)}
          >
            <GripIcon />
          </span>
          {asking ? (
            // Asking replaces the whole row: nothing else to click while deciding
            <>
              <span className="af-confirm-question">
                {pendingImport
                  ? `${session.comments.length === 1 ? 'Den Kommentar' : `Die ${session.comments.length} Kommentare`} durch den Import ersetzen?`
                  : `${session.comments.length === 1 ? 'Den Kommentar' : `Alle ${session.comments.length} Kommentare`} verwerfen?`}
              </span>
              <span className="af-spacer" />
              <button
                autoFocus
                onClick={() => {
                  setConfirmDiscard(false);
                  setPendingImport(null);
                }}
              >
                Abbrechen
              </button>
              {pendingImport ? (
                <button className="af-danger-solid" onClick={() => runImport(pendingImport)}>
                  Ersetzen
                </button>
              ) : (
                <button className="af-danger-solid" onClick={() => api.discard()}>
                  Verwerfen
                </button>
              )}
            </>
          ) : session.active ? (
            <>
              {listButton}
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
              <button className="af-primary" onClick={() => api.stop()}>
                Fertig
              </button>
              <MoreMenu items={moreActions} />
              <button className="af-icon" title={`Toolbar ausblenden – alles per Tastenkürzel (${HOLD_LABEL}+H)`} onClick={() => api.setHidden(true)}>
                ⌄
              </button>
            </>
          ) : (
            <>
              <button className="af-ghost" title="Weiter kommentieren" onClick={() => api.resume()}>
                Fortsetzen
              </button>
              <button
                className="af-ghost af-danger"
                // Nothing to lose without comments: no question
                onClick={() => (session.comments.length ? setConfirmDiscard(true) : api.discard())}
              >
                Verwerfen
              </button>
              <MoreMenu items={moreActions} className="af-ghost" />
              <span className="af-spacer" />
              {session.comments.length > 0 && <SplitButton actions={api.finishActions} run={runAction} />}
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
      {api.importExport && (
        <input
          ref={(el) => {
            importInput.current = el;
            el?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            if (files.length) onImportPicked(files);
          }}
        />
      )}
    </div>
  );
}

/** Position of the toolbar row (the drawer opens away from the closer screen edge). */
type DockPos = { right: number; top: number };

type MenuItem = { label: string; run: () => void };

/** Fixed-position menu under/over its trigger; the dock clips overflow, so it can't live inside it. */
function useAnchoredMenu() {
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!style) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      setStyle(null);
    };
    // Scrolling/resizing would detach the fixed menu from its trigger.
    window.addEventListener('keydown', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [style]);
  const toggle = () => {
    if (style) return setStyle(null);
    const r = anchor.current!.getBoundingClientRect();
    const up = r.top > window.innerHeight / 2;
    setStyle({
      right: window.innerWidth - r.right,
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
    });
  };
  const render = (items: MenuItem[]) =>
    style && (
      <>
        <div className="af-menu-backdrop" onClick={() => setStyle(null)} />
        <div className="af-menu" role="menu" style={style}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setStyle(null);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </>
    );
  return { anchor, open: !!style, toggle, render };
}

/** "Exportieren | ▾": the main action plus a menu with all variants. */
function SplitButton({ actions, run }: { actions: FinishAction[]; run: (fn: () => Promise<string | void>) => void }) {
  const menu = useAnchoredMenu();
  const [main] = actions;
  if (!main) return null;
  return (
    <span className="af-split">
      <button className="af-primary" onClick={() => run(main.run)}>
        {main.label}
      </button>
      {actions.length > 1 && (
        <button
          ref={menu.anchor}
          className="af-primary af-caret"
          aria-label="Weitere Export-Optionen"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {menu.render(actions.map((a) => ({ label: a.menuLabel ?? a.label, run: () => run(a.run) })))}
    </span>
  );
}

/** "…": rarely needed actions such as importing a previous export. */
function MoreMenu({ items, className = '' }: { items: MenuItem[]; className?: string }) {
  const menu = useAnchoredMenu();
  if (!items.length) return null;
  return (
    <>
      <button ref={menu.anchor} className={`af-icon ${className}`} aria-label="Weitere Aktionen" title="Weitere Aktionen" aria-expanded={menu.open} onClick={menu.toggle}>
        …
      </button>
      {menu.render(items)}
    </>
  );
}

/** Per site, like the page layout it has to make room for. */
const DOCK_KEY = 'nitpick:dock';
function loadDockPos(): DockPos | null {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null');
    return typeof v?.right === 'number' && typeof v?.top === 'number' ? v : null;
  } catch {
    return null;
  }
}
/** Keep the dock fully on screen (also after the window got smaller). */
function clampDock(pos: DockPos, dock: HTMLElement | null): DockPos {
  const w = dock?.offsetWidth ?? 300;
  const h = toolbarHeight(dock);
  return {
    right: Math.round(Math.max(4, Math.min(pos.right, window.innerWidth - w - 4))),
    top: Math.round(Math.max(4, Math.min(pos.top, window.innerHeight - h - 4))),
  };
}
const toolbarHeight = (dock: HTMLElement | null) => (dock?.querySelector('.af-toolbar') as HTMLElement | null)?.offsetHeight ?? 46;
/** Upper half: anchor the toolbar's top, drawer below. Lower half: anchor its bottom, drawer above. */
function dockStyle(pos: DockPos, barHeight: number): React.CSSProperties {
  if (pos.top < window.innerHeight / 2) return { right: pos.right, top: pos.top, bottom: 'auto' };
  // +2: the dock's border around the toolbar row
  return { right: pos.right, bottom: window.innerHeight - pos.top - barHeight - 2 };
}

const GripIcon = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
    {[3, 8, 13].flatMap((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />))}
  </svg>
);

const ListIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
    <circle cx="2.2" cy="4" r="0.6" fill="currentColor" />
    <circle cx="2.2" cy="8" r="0.6" fill="currentColor" />
    <circle cx="2.2" cy="12" r="0.6" fill="currentColor" />
  </svg>
);

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
  // Hovering a marker previews its comment right there; a short delay lets the pointer move into the preview.
  const [hovered, setHovered] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const enter = (id: string) => {
    clearTimeout(leaveTimer.current);
    setHovered(id);
  };
  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHovered(null), 150);
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const placed = comments.flatMap((c) => {
    let target: Rect | undefined;
    if (c.element) {
      let el: Element | null = null;
      try {
        // Selectors of elements inside iframes are relative to the frame's document
        if (!c.element.frames) el = document.querySelector(c.element.selector);
      } catch {
        // selector may be an xpath fallback
      }
      const d = c.element.documentRect;
      target = el ? toRect(el.getBoundingClientRect()) : { ...d, x: d.x - window.scrollX, y: d.y - window.scrollY };
    } else if (c.region) {
      const r = c.region;
      target = { ...r, x: r.x + c.viewport.scrollX - window.scrollX, y: r.y + c.viewport.scrollY - window.scrollY };
    }
    if (!target) return [];
    return [{ c, target, left: Math.max(4, target.x - 11), top: Math.max(4, target.y - 11) }];
  });
  const active = placed.find((p) => p.c.id === hovered);

  return (
    <>
      {active && <div className="af-highlight af-preview-target" style={rectStyle(active.target)} />}
      {placed.map(({ c, left, top }) => (
        <button
          key={c.id}
          className="af-pin"
          style={{ left, top }}
          aria-label={`Kommentar ${c.index}`}
          onMouseEnter={() => enter(c.id)}
          onMouseLeave={leave}
          onFocus={() => enter(c.id)}
          onBlur={leave}
          onClick={onClick}
        >
          {c.index}
        </button>
      ))}
      {active && (
        <div
          className="af-preview"
          role="tooltip"
          style={previewStyle(active.left, active.top)}
          onMouseEnter={() => enter(active.c.id)}
          onMouseLeave={leave}
        >
          <div className="af-item-head">
            <span className="af-badge">{active.c.index}</span>
            <span className="af-muted">{targetLabel(active.c)}</span>
          </div>
          <p className="af-item-text">{active.c.text}</p>
          <div className="af-preview-hint">Klick auf den Marker: in der Liste zeigen</div>
        </div>
      )}
    </>
  );
}

/** Next to the marker (22px), flipped left/up when it would leave the viewport. */
function previewStyle(pinLeft: number, pinTop: number): React.CSSProperties {
  const width = 280;
  const gap = 8;
  const right = pinLeft + 22 + gap;
  const left = right + width > window.innerWidth - 8 ? Math.max(8, pinLeft - gap - width) : right;
  const below = pinTop < window.innerHeight * 0.6;
  return below ? { left, top: pinTop, width } : { left, bottom: window.innerHeight - pinTop - 22, width };
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

/** What a comment is about, e.g. `button "Speichern"`, "Bereich" or "Notiz". */
function targetLabel(c: FeedbackComment): string {
  if (c.kind === 'region') return 'Bereich';
  if (!c.element) return 'Notiz';
  return c.element.name ? `${c.element.role ?? c.element.tag} "${c.element.name}"` : c.element.tag;
}

/** Checkboxes for the current URL's query parameters (plus chosen ones it lacks); route-like ones are marked. */
function PageParamsForm({ href, chosen, onChange }: { href: string; chosen: string[]; onChange: (params: string[]) => void }) {
  const routeLike = routeLikeParams(href);
  const all = [...new Set([...queryParams(href), ...chosen])];
  return (
    <div className="af-drawer-section af-params">
      <p className="af-muted">
        Kommentare gelten für Seiten mit gleichem Pfad. Gewählte Parameter müssen zusätzlich übereinstimmen. Gilt für{' '}
        {location.host}.
      </p>
      {!all.length && <p className="af-muted">Die aktuelle URL hat keine Query-Parameter.</p>}
      {all.map((p) => (
        <label key={p} className="af-param">
          <input
            type="checkbox"
            checked={chosen.includes(p)}
            onChange={(e) => onChange(e.currentTarget.checked ? [...chosen, p] : chosen.filter((x) => x !== p))}
          />
          <code>{p}</code>
          {routeLike.includes(p) && <span className="af-muted">sieht aus wie eine Route</span>}
        </label>
      ))}
    </div>
  );
}

function CommentList(props: { api: FeedbackHost; session: FeedbackSession; href: string; pageParams: string[] }) {
  const { api, session, href, pageParams } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  // The drawer closes as soon as the pointer leaves it: keep an edit in progress instead of dropping it
  const pending = useRef<{ id: string; text: string; original: string } | null>(null);
  pending.current = editing ? { id: editing, text, original: session.comments.find((c) => c.id === editing)?.text ?? '' } : null;
  useEffect(
    () => () => {
      const p = pending.current;
      if (p && p.text.trim() && p.text !== p.original) api.updateComment(p.id, p.text.trim());
    },
    [api],
  );
  return (
    <div className="af-drawer-section af-list">
      {!session.comments.length && <p className="af-muted">Noch keine Kommentare.</p>}
      {session.comments.map((c) => {
        const here = samePage(c.url, href, pageParams);
        return (
        <div key={c.id} className={`af-item${here ? ' af-item-here' : ''}`}>
          <div className="af-item-head">
            <span className="af-badge">{c.index}</span>
            <span className="af-muted">{targetLabel(c)}</span>
            {here && <span className="af-here">Diese Seite</span>}
          </div>
          {here ? (
            <div className="af-item-page" title={c.url}>
              {pageLabel(c.url, pageParams)}
            </div>
          ) : (
            // A plain link: the browser reloads the page (the session survives that); Ctrl/⌘-click opens a tab
            <a className="af-item-page" href={c.url} title={`Zur Seite: ${c.url}`}>
              {pageLabel(c.url, pageParams)}
            </a>
          )}
          {editing === c.id ? (
            <>
              <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} />
              <div className="af-composer-actions">
                <button
                  onClick={() => {
                    pending.current = null;
                    setEditing(null);
                  }}
                >
                  Abbrechen
                </button>
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
        );
      })}
    </div>
  );
}
