import React, { useEffect, useState, useRef } from 'react';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAsync, useIssuesRealtime, fmtDate } from '../api.js';
import { changeDetail, renameChange, updateChangeField, setChangeStatus, deleteChange } from '../board-store.js';
import { BUCKETS } from './ChangesBoard.jsx';
import { useLocalBackend } from '../capabilities.js';
import { useSelection } from '../selection.jsx';
import { useActivity } from '../activity-store.js';
import { Markdown } from './Markdown.jsx';
import { CopyButton } from './CopyButton.jsx';
import { useChatControl } from '../chat-control.jsx';
import { X, Plus, Pencil, Trash } from '../icons.jsx';

// Inline-editable issue title. Looks like the static <h2> (CSS .title-edit),
// gaining a box outline only on hover / focus. Enter or blur saves via
// renameChange (Supabase, works remotely too); Escape reverts. On a failed
// write we restore the prior title rather than leave a phantom edit on screen.
function EditableTitle({ id, title, onSaved, autoFocus }) {
  const [val, setVal] = useState(title);
  const skipBlur = useRef(false);
  const ref = useRef(null);
  // On a fresh create the board navigates here with a focus flag — select the
  // placeholder title so the user can just type the real one. Once only.
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (el) { el.focus(); el.select(); }
  }, [autoFocus]);
  // Grow the textarea to fit its content (no scrollbar, no fixed rows).
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  // Resync if server truth changes under us (background refresh / another tab),
  // and re-fit on every value change (typing, resync, mount).
  useEffect(() => { setVal(title); }, [title]);
  useEffect(() => { fit(); }, [val]);

  const save = async () => {
    const next = val.trim();
    if (!next || next === title) { setVal(title); return; }
    try {
      const r = await renameChange(id, next);
      if (r && r.error) throw new Error(r.error);
      onSaved && onSaved();
    } catch {
      setVal(title);
    }
  };

  return (
    <textarea
      ref={ref}
      className="title-edit"
      value={val}
      rows={1}
      spellCheck={false}
      aria-label="issue title"
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        // Enter saves (titles are single-value — wrapping handles long text);
        // it never inserts a newline. Escape reverts.
        if (e.key === 'Enter') { e.preventDefault(); skipBlur.current = true; save(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); skipBlur.current = true; setVal(title); e.currentTarget.blur(); }
      }}
      onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } save(); }}
    />
  );
}

// A tag pill that reveals a remove-X on its right on hover (over a gradient
// fade matching the pill fill). Clicking removes the tag immediately — tags are
// a cheap, single-click-curated list, so no confirm.
function TagPill({ id, tag, tags, onChanged }) {
  const remove = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const next = tags.filter(t => t !== tag);
    const r = await updateChangeField(id, 'tags', next);
    if (!(r && r.error)) onChanged();
  };
  return (
    <Link to={`/changes?tag=${encodeURIComponent(tag)}`} className="field-pill field-pill--reveal field-pill--tag">
      {tag}
      <button type="button" className="pill-reveal pill-reveal--remove"
        title="Remove tag" aria-label={`Remove tag ${tag}`} onClick={remove}>
        <X size={12} />
      </button>
    </Link>
  );
}

// Inline tag adder: a "+" that swaps to a tiny text input. Enter commits a
// trimmed, non-empty, non-duplicate tag; Escape/blur cancels.
function TagAdd({ id, tags, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const commit = async () => {
    const t = val.trim();
    setEditing(false); setVal('');
    if (!t || tags.includes(t)) return;
    const r = await updateChangeField(id, 'tags', [...tags, t]);
    if (!(r && r.error)) onChanged();
  };
  if (!editing) {
    return (
      <button type="button" className="icon-btn tag-add" title="Add a tag"
        aria-label="Add a tag" onClick={() => setEditing(true)}><Plus size={13} /></button>
    );
  }
  return (
    <input
      ref={ref}
      className="tag-add-input"
      value={val}
      spellCheck={false}
      aria-label="new tag"
      placeholder="tag"
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setVal(''); }
      }}
      onBlur={commit}
    />
  );
}

// A convo pill (opens the chat) whose hover-X is a two-step unlink: first click
// swaps the pill into a remove/cancel confirm (it severs a chat link), mirroring
// Terminal.jsx's ChatSwitcher. Only on confirm do we write the shortened list.
function ConvoPill({ id, convo, conversations, onChanged, onOpen }) {
  const [confirming, setConfirming] = useState(false);
  const remove = async (e) => {
    e.stopPropagation();
    const next = conversations.filter(c => c !== convo);
    const r = await updateChangeField(id, 'conversations', next);
    setConfirming(false);
    if (!(r && r.error)) onChanged();
  };
  return (
    <span className="field-pill field-pill--reveal">
      <button type="button" className="convo-open" title="Open this chat"
        style={{ all: 'unset', cursor: 'pointer' }}
        onClick={() => onOpen?.()}>{String(convo).slice(0, 8)}</button>
      {confirming ? (
        <span className="pill-confirm" onClick={e => e.stopPropagation()}>
          <button type="button" className="issue-chat-confirm-yes" title="Confirm remove"
            onClick={remove}>remove</button>
          <button type="button" className="issue-chat-confirm-no" title="Cancel"
            onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>cancel</button>
        </span>
      ) : (
        <button type="button" className="pill-reveal pill-reveal--remove"
          title="Remove this chat from the issue" aria-label="Remove chat"
          onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

// Clickable status pill: looks like the static bucket pill but opens a menu of
// the six columns. Picking one writes the issue's status directly (setStatus —
// no column reorder, the card just changes lanes) and refreshes. This is the
// detail-view twin of dragging a card between columns on the board. Click-
// outside or Escape closes; the current status is marked and disabled.
function StatusPill({ id, status, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    // Capture phase + stopPropagation so Escape closes the menu WITHOUT also
    // reaching the detail view's bubble-phase "Escape → back to board" listener.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const pick = async (next) => {
    if (next === status) { setOpen(false); return; }
    setBusy(true);
    const r = await setChangeStatus(id, next);
    setBusy(false);
    setOpen(false);
    if (!(r && r.error)) onChanged?.();
  };

  return (
    <span className="status-menu-wrap" ref={wrapRef}>
      <button type="button" className={`pill bucket-${status} status-trigger`}
        aria-haspopup="listbox" aria-expanded={open} disabled={busy}
        title="Change status" onClick={() => setOpen(o => !o)}>
        {status}
      </button>
      {open ? (
        <ul className="status-menu" role="listbox">
          {BUCKETS.map(b => (
            <li key={b.key} className={`status-item${b.key === status ? ' is-current' : ''}`}>
              <button type="button" className={`status-pick pill bucket-${b.key}`}
                role="option" aria-selected={b.key === status}
                disabled={busy || b.key === status} onClick={() => pick(b.key)}>
                {b.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

// Editable issue body. Renders markdown read-only with a reveal-on-hover pencil;
// clicking it swaps to a raw-markdown textarea. ⌘/Ctrl+Enter or Save commits via
// updateChangeField (Supabase, works remotely); Escape or Cancel reverts. The
// empty state is itself the entry point — click "add a description" to start.
function BodyEditor({ id, body, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(body || '');
  const ref = useRef(null);
  useEffect(() => { if (!editing) setVal(body || ''); }, [body, editing]);
  useEffect(() => { if (editing) { const el = ref.current; if (el) { el.focus(); el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } } }, [editing]);

  const save = async () => {
    const next = val;
    if (next === (body || '')) { setEditing(false); return; }
    const r = await updateChangeField(id, 'body', next);
    if (!(r && r.error)) { setEditing(false); onSaved?.(); }
    else setEditing(false);
  };

  if (editing) {
    return (
      <div className="recap-body recap-body--editing">
        <textarea
          ref={ref}
          className="body-edit"
          value={val}
          spellCheck={false}
          aria-label="issue body (markdown)"
          placeholder="Write a description… (markdown)"
          onChange={e => { setVal(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); setVal(body || ''); setEditing(false); }
          }}
        />
        <div className="body-edit-actions">
          <button type="button" className="body-edit-save" onClick={save}>Save</button>
          <button type="button" className="body-edit-cancel" onClick={() => { setVal(body || ''); setEditing(false); }}>Cancel</button>
          <span className="body-edit-hint">⌘↵ to save · esc to cancel</span>
        </div>
      </div>
    );
  }

  if (!body) {
    return (
      <button type="button" className="empty body-empty-add" onClick={() => setEditing(true)}>
        <Pencil size={12} /> add a description
      </button>
    );
  }

  return (
    <div className="recap-body recap-body--editable">
      <button type="button" className="body-edit-btn" title="Edit description"
        aria-label="Edit description" onClick={() => setEditing(true)}><Pencil size={13} /></button>
      <Markdown text={body} />
    </div>
  );
}

// Destructive delete for the whole issue, top-right of the detail head. Double
// opt-in (the issue body's requirement): a resting trash icon, first click
// reveals a "delete / cancel" confirm, only the second click drops the Supabase
// row — then we leave the now-dead detail route and return to the board. Mirrors
// ConvoPill's two-step pattern, escalated to red because this can't be undone.
function DeleteIssue({ id, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const del = async () => {
    setBusy(true); setErr(null);
    const r = await deleteChange(id);
    if (r && r.error) { setErr(r.error); setBusy(false); setConfirming(false); return; }
    onDeleted?.();
  };
  if (confirming) {
    return (
      <span className="issue-delete-confirm">
        <button type="button" className="issue-delete-yes" disabled={busy}
          title="Permanently delete this issue" onClick={del}>
          {busy ? 'deleting…' : 'delete'}
        </button>
        <button type="button" className="issue-delete-no" disabled={busy}
          title="Cancel" onClick={() => { setConfirming(false); setErr(null); }}>cancel</button>
        {err ? <span className="error">{err}</span> : null}
      </span>
    );
  }
  return (
    <button type="button" className="icon-btn issue-delete-btn" title="Delete this issue"
      aria-label="Delete this issue" onClick={() => setConfirming(true)}><Trash size={15} /></button>
  );
}

// Unified detail for a single change. Reads the issue straight from Supabase
// (board-store), so it works remotely. The live-branch (kind 'branch') variant
// only ever appears via the local backend's listing; remotely every card is an
// issue. The worktree-app link is gated on a local backend below.
export function ChangeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const focusTitle = location.state?.focusTitle === true;
  const local = useLocalBackend();
  const { setSelectedId } = useSelection();
  const requestChat = useChatControl();
  const activity = useActivity();
  // Read the issue straight from Supabase (board-store) so detail works remotely.
  const { data, err, loading, refresh } = useAsync(`change:${id}`, () => changeDetail(id));
  // Live updates everywhere: any issue row change arrives over the browser-side
  // Supabase Realtime subscription the board uses (realtime.js), so convos /
  // branches refresh without a poll wait — local and remote alike.
  useIssuesRealtime(refresh);

  // Record which card we came in on, so ⌘← / Esc returns the board cursor here.
  useEffect(() => { setSelectedId(id); }, [id, setSelectedId]);
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // ⌘← (not bare ←, which collides with text-cursor / nav) or Esc → board.
      if ((e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) || e.key === 'Escape') {
        e.preventDefault();
        navigate('/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  if (loading && !data) return <div className="spin">loading…</div>;
  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="error">not found</div>;

  const isIssue = data.kind === 'issue';
  const status = data.status || (data.live ? 'next' : 'next');
  // Same idle-chat marker as the board card, with the same gate: only an
  // in-progress issue's idle chat flags. Off that column, no flag.
  const idle = status === 'in-progress' && activity[data.id] === 'idle';
  const body = data.body ?? data.recap_text ?? null;

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="title-block">
          <div className="detail-title-row">
            {idle ? <span className="kcard-idle-dot" title="chat idle — needs your input" /> : null}
            {isIssue
              ? <EditableTitle id={data.id} title={data.title || data.id} onSaved={refresh} autoFocus={focusTitle} />
              : <h2>{data.title || data.id}</h2>}
          </div>
          <div className="detail-sub">
            {data.live
              ? <span className="pill live-tag">● live</span>
              : isIssue
                ? <StatusPill id={data.id} status={status} onChanged={refresh} />
                : <span className={`pill bucket-${status}`}>{status}</span>}
            {!isIssue ? <span className="itag" style={{ marginLeft: 8 }}>branch</span> : null}
            {data.created ? <span className="dim" style={{ marginLeft: 8 }}>created {fmtDate(data.created)}</span> : null}
          </div>
        </div>
        {isIssue ? <DeleteIssue id={data.id} onDeleted={() => navigate('/')} /> : null}
      </div>

      <div className="issue-fields">
        {data.owner ? (
          <div className="field-row">
            <span className="k">owner</span>
            <span className="v"><span className="field-pill">@{data.owner}</span></span>
          </div>
        ) : null}
        {data.branch || data.branches?.length ? (
          <div className="field-row">
            <span className="k">branch</span>
            <span className="v">{(data.branches?.length ? data.branches : [data.branch]).filter(Boolean).map(b => <span key={b} className="field-pill">{b}</span>)}</span>
          </div>
        ) : null}
        {data.commits?.length ? (
          <div className="field-row">
            <span className="k">commits</span>
            <span className="v">{data.commits.map(c => <span key={c} className="field-pill">{String(c).slice(0, 9)}</span>)}</span>
          </div>
        ) : null}
        {data.sessions?.length ? (
          <div className="field-row">
            <span className="k">sessions</span>
            <span className="v">{data.sessions.map(s => <span key={s} className="field-pill">{s}</span>)}</span>
          </div>
        ) : null}
        {isIssue ? (
          <div className="field-row">
            <span className="k">tags</span>
            <span className="v">
              {(data.tags || []).map(t => (
                <TagPill key={t} id={data.id} tag={t} tags={data.tags || []} onChanged={refresh} />
              ))}
              <TagAdd id={data.id} tags={data.tags || []} onChanged={refresh} />
            </span>
          </div>
        ) : null}
        {data.conversations?.length ? (
          <div className="field-row">
            <span className="k">convos</span>
            <span className="v">{data.conversations.map(c => (
              <ConvoPill key={c} id={data.id} convo={c} conversations={data.conversations}
                onChanged={refresh} onOpen={() => requestChat?.(data.id, c)} />
            ))}</span>
          </div>
        ) : null}
        {data.live_pid ? (
          <div className="field-row"><span className="k">live pid</span><span className="v"><span className="field-pill">{data.live_pid}</span></span></div>
        ) : null}
      </div>

      {isIssue ? (
        <BodyEditor id={data.id} body={body} onSaved={refresh} />
      ) : body ? (
        <div className="recap-body"><Markdown text={body} /></div>
      ) : (
        <div className="empty">no recap for this branch yet</div>
      )}
    </div>
  );
}
