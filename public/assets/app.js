// job-boards.io client. Vanilla ES modules, no build step.
//
// Everything user-supplied reaches the DOM through textContent or via the `h`
// helper, never innerHTML - the one exception is the QR SVG, which the Worker
// generates from our own encoder.

import { readResumeFile } from './docparse.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript. Props starting with "on" bind listeners; everything else
 *  is set as an attribute, except `class`, `text`, and `html`. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/**
 * Only ever put an http(s) URL in an href.
 *
 * Job links originate in third-party feeds. They are sanitised on the way into
 * the database, but this is the last gate before one becomes a clickable link,
 * and a `javascript:` URL reaching an anchor is a script execution rather than
 * a broken link. Cheap to check, and it does not rely on the server having got
 * it right.
 */
function safeHref(url) {
  try {
    const parsed = new URL(String(url), location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

// --- api -------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload || {};
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    // Content-Type is load-bearing: the Worker rejects state-changing requests
    // that are not declared JSON, which is half the CSRF defence.
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* empty body is fine */
  }
  if (!res.ok) throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, payload);
  return payload;
}

// --- state -----------------------------------------------------------------

const state = {
  user: null,
  boards: [],
  boardId: null,
  board: null,
  jobs: [],
  view: 'list',
  statusFilter: '',
  minScore: 0,
  maxAgeDays: 0,
  sort: 'score',
  query: '',
  lastSync: null,
  pollTimer: null,
  provisionTimer: null,
  maxBoards: 3,
  maxActive: 50,
  addBatchSize: 10,
  mfaRecoveryMode: false,
};

const STATUSES = [
  { key: 'new', label: 'New', color: '#c3f53c' },
  { key: 'saved', label: 'Saved', color: '#9aa08a' },
  { key: 'applied', label: 'Applied', color: '#7fc8f5' },
  { key: 'interview', label: 'Interview', color: '#f0b44a' },
  { key: 'offer', label: 'Offer', color: '#86d97f' },
  { key: 'rejected', label: 'Rejected', color: '#f26d61' },
  // Set by the refresh, not chosen. Listed here so it gets a chip, a kanban
  // column and a place in the status dropdown like any other state.
  { key: 'delisted', label: 'No Longer Listed', color: '#f26d61' },
];

/**
 * Two different situations, deliberately shown differently.
 *
 * A job nobody acted on that the employer pulled is a dead end - red, because
 * there is nothing left to do with it. A job you already applied to or are
 * interviewing for is *not* a dead end just because the public listing came
 * down; that is normal once a role is filled internally or the posting closes,
 * and your conversation is still live. It keeps its own status and gets a
 * quiet note, with no alarm colour.
 */
const isDelisted = (job) => job.status === 'delisted';
const isClosedButTracked = (job) => Boolean(job.closedAt) && job.status !== 'delisted';

const statusLabel = (key) => (STATUSES.find((s) => s.key === key) || { label: 'Archived' }).label;
const scoreBand = (score) => (score >= 75 ? 'high' : score >= 50 ? 'mid' : 'low');

function relativeTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return 'never';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** Age of a posting, in the compact form the list column uses. */
function postedAge(job) {
  if (!job.postedAt) return { label: 'undated', band: 'unknown', days: null };
  const days = (Date.now() - new Date(job.postedAt).getTime()) / 86400000;
  if (!Number.isFinite(days) || days < 0) return { label: 'undated', band: 'unknown', days: null };
  if (days < 1) return { label: 'today', band: 'fresh', days };
  if (days < 2) return { label: '1d', band: 'fresh', days };
  if (days < 7) return { label: `${Math.round(days)}d`, band: 'fresh', days };
  if (days < 30) return { label: `${Math.round(days / 7)}w`, band: 'recent', days };
  if (days < 365) return { label: `${Math.round(days / 30)}mo`, band: 'stale', days };
  return { label: '1y+', band: 'stale', days };
}

const AGE_PRESETS = [
  [0, 'Any age'],
  [1, 'Today'],
  [3, 'Last 3 days'],
  [7, 'Last week'],
  [14, 'Last 2 weeks'],
  [30, 'Last month'],
];

function salaryText(job) {
  if (job.salaryRaw) return job.salaryRaw;
  const fmt = (n) => `$${Math.round(n / 1000)}k`;
  if (job.salaryMin && job.salaryMax) return `${fmt(job.salaryMin)}–${fmt(job.salaryMax)}`;
  if (job.salaryMin) return `from ${fmt(job.salaryMin)}`;
  return '';
}

// --- chrome ----------------------------------------------------------------

let toastTimer;
function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast${kind ? ` toast--${kind}` : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3800);
}

function banner(message, kind = '') {
  const node = $('#banner');
  if (!message) {
    node.hidden = true;
    return;
  }
  clear(node);
  node.className = `banner${kind ? ` banner--${kind}` : ''}`;
  node.append(
    h('span', { text: message }),
    h('button', {
      class: 'btn btn--ghost btn--sm',
      text: 'Dismiss',
      onclick: () => {
        node.hidden = true;
      },
    })
  );
  node.hidden = false;
}

function showModal(title, bodyNode, { wide = false } = {}) {
  $('#modal-title').textContent = title;
  clear($('#modal-body')).append(bodyNode);
  $('.modal__panel').classList.toggle('modal__panel--wide', wide);
  $('#modal').hidden = false;
  const focusable = $('input, select, textarea, button', $('#modal-body'));
  if (focusable) focusable.focus();
}

function closeModal() {
  $('#modal').hidden = true;
  clear($('#modal-body'));
}

/** Wraps a submit handler with a busy state, so a slow request cannot be
 *  double-submitted and the button always says what is happening. */
function busy(button, label, fn) {
  return async (event) => {
    if (event) event.preventDefault();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      await fn();
    } catch (err) {
      toast(err.message || 'Something went wrong', 'error');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };
}

// ===========================================================================
// AUTH
// ===========================================================================

const AUTH_FORMS = ['signin', 'signup', 'mfa', 'forgot', 'reset'];

function showAuth(which) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#auth').hidden = false;
  for (const name of AUTH_FORMS) $(`#form-${name}`).hidden = name !== which;
  authNotice('');
  const first = $(`#form-${which} input`);
  if (first) first.focus();
}

function authNotice(message, kind = 'error') {
  const node = $('#auth-notice');
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.className = `notice notice--${kind}`;
  node.hidden = false;
}

function wireAuth() {
  $$('[data-go]').forEach((btn) => btn.addEventListener('click', () => showAuth(btn.dataset.go)));

  $('#form-signin').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = $('button[type=submit]', form);
    await busy(button, 'Signing in…', async () => {
      try {
        const result = await api('/api/auth/login', {
          method: 'POST',
          body: { email: form.email.value, password: form.password.value },
        });
        if (result.mfaRequired) {
          state.mfaRecoveryMode = false;
          showAuth('mfa');
          return;
        }
        await enterApp(result.user);
      } catch (err) {
        authNotice(err.message);
      }
    })();
  });

  $('#form-signup').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = $('button[type=submit]', form);
    await busy(button, 'Creating…', async () => {
      try {
        const result = await api('/api/auth/signup', {
          method: 'POST',
          body: {
            email: form.email.value,
            password: form.password.value,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          },
        });
        if (!result.user) {
          // Address already registered. The server answers identically either
          // way, so the wording stays neutral - but it must not promise an
          // email that cannot be sent, which left someone watching an inbox
          // for a message that was never going to arrive.
          authNotice(
            result.emailDelivery
              ? 'Check your inbox to continue.'
              : 'That address cannot be signed up right now. If the account is yours, sign in instead.',
            'ok'
          );
          return;
        }
        await enterApp(result.user);
        toast(
          result.emailDelivery
            ? 'Account created. Check your email to confirm the address.'
            : 'Account created. Email confirmation is not set up yet, so nothing to check — everything works except alerts.'
        );
      } catch (err) {
        authNotice(err.message);
      }
    })();
  });

  $('#toggle-recovery').addEventListener('click', () => {
    state.mfaRecoveryMode = !state.mfaRecoveryMode;
    const input = $('#form-mfa input[name=code]');
    $('#mfa-label').textContent = state.mfaRecoveryMode ? 'Recovery code' : 'Six-digit code';
    $('#toggle-recovery').textContent = state.mfaRecoveryMode
      ? 'Use your authenticator app instead'
      : 'Use a recovery code instead';
    input.classList.toggle('input--code', !state.mfaRecoveryMode);
    input.value = '';
    input.focus();
  });

  $('#form-mfa').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = $('button[type=submit]', form);
    await busy(button, 'Verifying…', async () => {
      try {
        const result = await api('/api/auth/mfa', {
          method: 'POST',
          body: { code: form.code.value, useRecoveryCode: state.mfaRecoveryMode },
        });
        await enterApp(result.user);
      } catch (err) {
        authNotice(err.message);
        form.code.value = '';
        form.code.focus();
      }
    })();
  });

  $('#form-forgot').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = $('button[type=submit]', form);
    await busy(button, 'Sending…', async () => {
      await api('/api/auth/password/forgot', { method: 'POST', body: { email: form.email.value } });
      authNotice('If that address has an account, a reset link is on its way.', 'ok');
    })();
  });

  $('#form-reset').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = $('button[type=submit]', form);
    const token = new URLSearchParams(location.search).get('token') || '';
    await busy(button, 'Saving…', async () => {
      try {
        await api('/api/auth/password/reset', {
          method: 'POST',
          body: { token, password: form.password.value },
        });
        history.replaceState({}, '', '/app');
        showAuth('signin');
        authNotice('Password updated. Sign in with your new password.', 'ok');
      } catch (err) {
        authNotice(err.message);
      }
    })();
  });
}

// ===========================================================================
// APP
// ===========================================================================

async function enterApp(user) {
  state.user = user;
  $('#auth').hidden = true;
  $('#boot').hidden = true;
  $('#app').hidden = false;

  $('#sidebar-email').textContent = user.email;
  $('#avatar').textContent = (user.email[0] || '?').toUpperCase();

  if (!user.emailVerified) {
    banner('Confirm your email address to start receiving alerts.', 'warn');
  }

  await loadBoards();
  startPolling();
}

async function loadBoards({ keepSelection = true } = {}) {
  const { boards, maxBoards, maxActive, addBatchSize } = await api('/api/boards');
  state.boards = boards;
  if (maxBoards) state.maxBoards = maxBoards;
  if (maxActive) state.maxActive = maxActive;
  if (addBatchSize) state.addBatchSize = addBatchSize;

  if (boards.length === 0) {
    state.boardId = null;
    state.board = null;
    renderBoardList();
    renderEmptyShell();
    return;
  }

  const stored = localStorage.getItem('jb.board');
  const wanted = keepSelection ? state.boardId || stored : null;
  const found = boards.find((b) => b.id === wanted);
  state.boardId = (found || boards[0]).id;
  localStorage.setItem('jb.board', state.boardId);

  renderBoardList();
  await loadJobs();
}

function renderBoardList() {
  // Reflect the ceiling in the button rather than letting someone fill in a
  // form that the server is going to reject.
  const atLimit = state.boards.length >= state.maxBoards;
  const newBtn = $('#new-board');
  newBtn.disabled = atLimit;
  newBtn.textContent = atLimit ? `${state.maxBoards} of ${state.maxBoards} boards used` : '+ New board';
  newBtn.title = atLimit ? 'Delete a board to make room for another.' : '';

  const list = clear($('#board-list'));
  for (const board of state.boards) {
    const total = Object.entries(board.counts || {})
      .filter(([status]) => status !== 'archived')
      .reduce((sum, [, n]) => sum + n, 0);
    list.append(
      h(
        'li',
        {},
        h(
          'button',
          {
            class: `board-item${board.id === state.boardId ? ' is-on' : ''}`,
            onclick: () => selectBoard(board.id),
          },
          h('span', { class: 'board-item__name', text: board.name }),
          h('span', { class: 'board-item__count', text: String(total) })
        )
      )
    );
  }
}

async function selectBoard(id) {
  state.boardId = id;
  state.lastSync = null;
  localStorage.setItem('jb.board', id);
  $('#app').classList.remove('sidebar-open');
  renderBoardList();
  await loadJobs();
}

async function loadJobs() {
  if (!state.boardId) return;
  const params = new URLSearchParams({ boardId: state.boardId });
  if (state.statusFilter) params.set('status', state.statusFilter);
  if (state.minScore > 0) params.set('minScore', String(state.minScore));
  if (state.query) params.set('q', state.query);
  if (state.maxAgeDays > 0) params.set('maxAgeDays', String(state.maxAgeDays));
  if (state.sort === 'newest') params.set('sort', 'newest');

  const { jobs, board } = await api(`/api/jobs?${params}`);
  state.jobs = jobs;
  state.board = board;
  state.lastSync = new Date().toISOString();
  render();
}

function render() {
  const board = state.board;
  if (!board) return renderEmptyShell();

  $('#board-name').textContent = board.name;

  // Capacity is part of the model now, so it belongs next to the board name
  // rather than being something you infer from a failed action.
  const listed = state.boards.find((b) => b.id === state.boardId);
  const active = listed ? listed.active : state.jobs.filter((j) => j.status !== 'rejected' && j.status !== 'archived').length;
  const stamp = board.lastRefresh ? `synced ${relativeTime(board.lastRefresh)}` : 'never synced';
  $('#board-stamp').textContent = `${active} of ${state.maxActive} jobs · ${stamp}`;

  renderAddJobs(active);

  if (board.lastError) banner(board.lastError, 'warn');

  renderStatusChips();
  if (state.view === 'list') renderList();
  else renderKanban();
}

function renderEmptyShell() {
  $('#board-name').textContent = 'No boards yet';
  $('#board-stamp').textContent = '';
  $('#view-list').hidden = true;
  $('#view-board').hidden = true;
  const empty = clear($('#empty'));
  empty.hidden = false;
  empty.append(
    h('h3', { text: 'Create your first board' }),
    h('p', {
      text: 'Describe the job you want in plain English. We find the employers worth watching, connect to their job boards, and start ranking — you do not have to look anything up.',
    }),
    h('button', { class: 'btn btn--primary', text: 'New board', onclick: openBoardEditor })
  );
}

function renderStatusChips() {
  const wrap = clear($('#status-chips'));
  const counts = {};
  for (const job of state.jobs) counts[job.status] = (counts[job.status] || 0) + 1;

  const chip = (key, label) =>
    h(
      'button',
      {
        class: `chip${state.statusFilter === key ? ' is-on' : ''}`,
        onclick: async () => {
          state.statusFilter = key;
          await loadJobs();
        },
      },
      label,
      key ? h('span', { class: 'chip__n', text: String(counts[key] || 0) }) : null
    );

  wrap.append(chip('', 'All'));
  for (const status of STATUSES) wrap.append(chip(status.key, status.label));

  // Recency controls sit beside the status chips: how fresh, and whether to
  // order by freshness instead of fit.
  const controls = clear($('#recency-controls'));
  controls.append(
    h(
      'select',
      {
        class: 'select',
        style: 'width:auto;padding:.32rem 1.9rem .32rem .7rem;font-size:.8125rem',
        onchange: async (event) => {
          state.maxAgeDays = Number(event.target.value);
          await loadJobs();
        },
      },
      ...AGE_PRESETS.map(([days, label]) =>
        h('option', { value: String(days), selected: state.maxAgeDays === days }, label)
      )
    ),
    h(
      'div',
      { class: 'segmented' },
      ...[
        ['score', 'Best fit'],
        ['newest', 'Newest'],
      ].map(([key, label]) =>
        h('button', {
          class: `segmented__btn${state.sort === key ? ' is-on' : ''}`,
          text: label,
          onclick: async () => {
            state.sort = key;
            await loadJobs();
          },
        })
      )
    )
  );
}

// --- list view -------------------------------------------------------------

function scoreNode(job) {
  return h(
    'div',
    { class: `score score--${scoreBand(job.score)}` },
    h('span', { class: 'score__num mono', text: String(job.score) }),
    h('span', { class: 'score__bar' }, h('i', { style: `width:${Math.max(2, job.score)}%` }))
  );
}

function statusSelect(job) {
  const select = h(
    'select',
    {
      class: 'select status-select',
      onclick: (event) => event.stopPropagation(),
      onchange: async (event) => {
        await updateJob(job.id, { status: event.target.value });
      },
    },
    ...[...STATUSES, { key: 'archived', label: 'Archived' }].map((status) =>
      h('option', { value: status.key, selected: status.key === job.status }, status.label)
    )
  );
  return select;
}

function renderList() {
  $('#view-list').hidden = false;
  $('#view-board').hidden = true;

  const body = clear($('#jobs-body'));

  if (state.jobs.length === 0) {
    $('#empty').hidden = false;
    renderNoResults();
    return;
  }
  $('#empty').hidden = true;

  for (const job of state.jobs) {
    const age = postedAge(job);
    // Remote is a property of the role, not a place, so it reads as a badge
    // beside the location rather than replacing it - plenty of remote roles
    // still carry a region.
    const place = job.remote
      ? h('span', {}, h('span', { class: 'chip-remote', text: 'Remote' }), job.location ? ` ${job.location}` : '')
      : h('span', { text: job.location || '—' });

    body.append(
      h(
        'tr',
        {
          class: [job.status === 'archived' ? 'is-archived' : '', isDelisted(job) ? 'is-delisted' : '']
            .filter(Boolean)
            .join(' '),
          onclick: () => openDrawer(job.id),
        },
        h('td', {}, scoreNode(job)),
        h(
          'td',
          {},
          h('span', {
            class: `age age--${age.band}`,
            title: job.postedAt ? `Posted ${new Date(job.postedAt).toLocaleDateString()}` : 'No date published',
            text: age.label,
          })
        ),
        h(
          'td',
          {},
          h(
            'span',
            { class: 'job__title' },
            job.title,
            // Shown on both, but only the untouched ones colour the row. On a
            // job you are already in process for this is a note, not an alarm.
            isDelisted(job)
              ? h('span', { class: 'tag tag--closed', text: 'no longer listed' })
              : isClosedButTracked(job)
                ? h('span', {
                    class: 'tag tag--noted',
                    title: 'The public listing has come down. Your application is unaffected.',
                    text: 'no longer listed',
                  })
                : null
          ),
          job.scoreReason ? h('span', { class: 'job__why', text: job.scoreReason }) : null
        ),
        h(
          'td',
          {},
          h('span', { class: 'job__company', text: job.company || '—' }),
          job.linkDirect ? null : h('span', { class: 'job__via', text: 'via aggregator' })
        ),
        h('td', { class: 'job__place' }, place),
        h('td', { class: 'job__pay' }, salaryText(job) || '—'),
        h('td', {}, statusSelect(job)),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'row-actions' },
            job.url
              ? h('a', {
                  class: 'btn btn--ghost btn--sm',
                  href: safeHref(job.url),
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  text: 'Open',
                  onclick: (event) => event.stopPropagation(),
                })
              : null
          )
        )
      )
    );
  }
}

function renderNoResults() {
  const empty = clear($('#empty'));
  const hasFilters = state.statusFilter || state.minScore > 0 || state.query;
  const hasSources = state.board && state.board.lastRefresh;

  if (hasFilters) {
    empty.append(
      h('h3', { text: 'Nothing matches those filters' }),
      h('p', { text: 'Widen the score range or clear the search to see the rest of the board.' }),
      h('button', {
        class: 'btn btn--ghost',
        text: 'Clear filters',
        onclick: async () => {
          state.statusFilter = '';
          state.minScore = 0;
          state.query = '';
          $('#search').value = '';
          $('#min-score').value = '0';
          $('#min-score-out').textContent = '0';
          await loadJobs();
        },
      })
    );
    return;
  }

  // A board with no refresh yet is still being provisioned - discovery runs
  // server-side on creation. Showing a setup task here would be asking the user
  // to do work the system is already doing.
  if (!hasSources) {
    empty.append(
      h('h3', { text: 'Finding sources for this board' }),
      h('p', {
        text: 'We are reading your criteria, picking employers worth watching, and checking each one has a live job board. Jobs appear here as they land — usually within a minute.',
      }),
      h('span', { class: 'spinner' })
    );
    watchProvisioning();
    return;
  }

  empty.append(
    h('h3', { text: 'No jobs matched yet' }),
    h('p', {
      text: 'The connected sources returned nothing matching your filters. Loosening the minimum level or salary usually opens it up, or re-run source discovery to widen the net.',
    }),
    h(
      'div',
      { style: 'display:flex;gap:.5rem' },
      h('button', {
        class: 'btn btn--primary',
        text: 'Find more sources',
        onclick: async (event) => {
          await busy(event.target, 'Searching…', runCuration)(event);
        },
      }),
      h('button', { class: 'btn btn--ghost', text: 'Edit criteria', onclick: () => {
        const board = state.boards.find((b) => b.id === state.boardId);
        if (board) openBoardEditor(board);
      } })
    )
  );
}

/**
 * The "Add N jobs" control, alongside the capacity readout.
 *
 * Disabled at the ceiling rather than hidden, with the reason on the button -
 * a control that vanishes leaves someone wondering where it went, and the way
 * to get it back (reject or archive something) is not obvious otherwise.
 */
function renderAddJobs(active) {
  const host = $('#add-jobs-host');
  if (!host) return;
  clear(host);

  const full = active >= state.maxActive;
  const btn = h('button', {
    class: `btn btn--sm ${full ? 'btn--ghost' : 'btn--primary'}`,
    text: full ? 'Board full' : `Add ${state.addBatchSize} jobs`,
    title: full
      ? `This board holds ${state.maxActive} jobs. Reject or archive a few to make room — those do not count toward the limit.`
      : `Pull the next ${state.addBatchSize}, ranked against everything already here.`,
    disabled: full,
  });

  btn.addEventListener(
    'click',
    busy(btn, 'Finding…', async () => {
      const res = await api('/api/boards/add-jobs', { method: 'POST', body: { id: state.boardId } });
      if (!res.ok) {
        toast(res.message || 'Could not add jobs', 'error');
        return;
      }
      await loadJobs();
      await loadBoards();
      if (res.added > 0) {
        const passed = res.passedOver ? `, ${res.passedOver} ranked lower` : '';
        toast(`Added ${res.added}${passed}`);
      } else {
        toast('Nothing new cleared your criteria this time');
      }
    })
  );

  host.append(btn);
}

/**
 * Delay before the nth check while a new board provisions.
 *
 * Starts almost immediately, then backs off. A flat ten seconds meant the first
 * look happened after provisioning had usually already finished, so the user
 * watched a spinner do nothing on a board that was ready - which reads as
 * stuck, and teaches people to refresh by hand.
 */
const PROVISION_DELAYS = [1200, 1800, 2500, 3500, 5000, 7000, 10000];
const PROVISION_MAX_ATTEMPTS = 24;

/** Poll while a freshly created board is being provisioned server-side. */
function watchProvisioning(attempt = 0) {
  if (state.provisionTimer) clearTimeout(state.provisionTimer);

  if (attempt >= PROVISION_MAX_ATTEMPTS) {
    // Never leave the spinner turning. Giving up silently is what made a slow
    // board indistinguishable from a broken one.
    renderProvisionGaveUp();
    return;
  }

  const delay = PROVISION_DELAYS[Math.min(attempt, PROVISION_DELAYS.length - 1)];
  state.provisionTimer = setTimeout(async () => {
    try {
      const before = state.jobs.length;
      await loadJobs();
      await loadBoards();

      if (state.jobs.length > before) {
        toast(`${state.jobs.length} jobs found`);
        return;
      }

      // A board can finish provisioning with nothing to show - the criteria may
      // genuinely match nothing today. Stop as soon as the server reports the
      // refresh has run, rather than spinning out the whole window on a board
      // that has already given its answer.
      const board = state.boards.find((b) => b.id === state.boardId);
      if (board && board.lastRefresh) {
        render();
        return;
      }

      watchProvisioning(attempt + 1);
    } catch {
      watchProvisioning(attempt + 1);
    }
  }, delay);
}

function renderProvisionGaveUp() {
  const empty = $('#empty');
  if (!empty) return;
  clear(empty).append(
    h('h3', { text: 'This is taking longer than usual' }),
    h('p', {
      text: 'The board is still being set up in the background and will fill in on its own. Checking now is safe.',
    }),
    h('button', {
      class: 'btn btn--primary',
      text: 'Check now',
      onclick: async (event) => {
        await busy(event.target, 'Checking…', async () => {
          await loadJobs();
          await loadBoards();
          render();
        })(event);
      },
    })
  );
}

async function runCuration() {
  const result = await api('/api/boards/curate', { method: 'POST', body: { id: state.boardId } });
  await loadJobs();
  await loadBoards();
  toast(result.note || 'Sources checked');
}

// --- kanban ----------------------------------------------------------------

function renderKanban() {
  $('#view-list').hidden = true;
  $('#view-board').hidden = false;
  $('#empty').hidden = true;

  const board = clear($('#kanban'));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s.key, []]));
  for (const job of state.jobs) {
    if (byStatus[job.status]) byStatus[job.status].push(job);
  }

  for (const status of STATUSES) {
    const jobs = byStatus[status.key];
    const column = h(
      'section',
      {
        class: 'column',
        dataset: { status: status.key },
        ondragover: (event) => {
          event.preventDefault();
          column.classList.add('is-target');
        },
        ondragleave: () => column.classList.remove('is-target'),
        ondrop: async (event) => {
          event.preventDefault();
          column.classList.remove('is-target');
          const id = event.dataTransfer.getData('text/plain');
          if (id) await updateJob(id, { status: status.key });
        },
      },
      h(
        'header',
        { class: 'column__head' },
        h('span', { class: 'column__dot', style: `--col:${status.color}` }),
        h('span', { class: 'column__name', text: status.label }),
        h('span', { class: 'column__n', text: String(jobs.length) })
      ),
      h('div', { class: 'column__body' }, ...jobs.map((job) => kanbanCard(job, status.key)))
    );
    board.append(column);
  }
}

function kanbanCard(job, statusKey) {
  const index = STATUSES.findIndex((s) => s.key === statusKey);
  const move = async (delta) => {
    const next = STATUSES[index + delta];
    if (next) await updateJob(job.id, { status: next.key });
  };

  const card = h(
    'article',
    {
      class: `kcard${isDelisted(job) ? ' is-delisted' : ''}`,
      draggable: 'true',
      tabindex: '0',
      ondragstart: (event) => {
        event.dataTransfer.setData('text/plain', job.id);
        event.dataTransfer.effectAllowed = 'move';
        card.classList.add('is-dragging');
      },
      ondragend: () => card.classList.remove('is-dragging'),
      onclick: () => openDrawer(job.id),
      onkeydown: async (event) => {
        // Keyboard equivalent of the drag: the board must be usable without a
        // pointer.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDrawer(job.id);
        } else if (event.key === 'ArrowRight' && event.shiftKey) {
          event.preventDefault();
          await move(1);
        } else if (event.key === 'ArrowLeft' && event.shiftKey) {
          event.preventDefault();
          await move(-1);
        }
      },
    },
    h(
      'div',
      { class: 'kcard__top' },
      scoreNode(job),
      h(
        'div',
        { style: 'flex:1;min-width:0' },
        // Company first and loudest. On a card this small the employer is what
        // someone scans for - two identical titles at different companies are
        // completely different prospects.
        h('span', { class: 'kcard__company', text: job.company || '—' }),
        h('span', { class: 'kcard__title', text: job.title })
      )
    ),
    h(
      'span',
      { class: 'kcard__meta' },
      job.remote ? h('span', { class: 'chip-remote', text: 'Remote' }) : null,
      [job.location, salaryText(job)].filter(Boolean).join(' · ') || (job.remote ? '' : '—')
    ),
    h(
      'div',
      { class: 'kcard__move' },
      index > 0
        ? h('button', {
            text: '←',
            title: `Move to ${STATUSES[index - 1].label}`,
            'aria-label': `Move to ${STATUSES[index - 1].label}`,
            onclick: (event) => {
              event.stopPropagation();
              move(-1);
            },
          })
        : null,
      index < STATUSES.length - 1
        ? h('button', {
            text: '→',
            title: `Move to ${STATUSES[index + 1].label}`,
            'aria-label': `Move to ${STATUSES[index + 1].label}`,
            onclick: (event) => {
              event.stopPropagation();
              move(1);
            },
          })
        : null
    )
  );
  return card;
}

// --- job mutations ---------------------------------------------------------

async function updateJob(id, patch) {
  try {
    const { job } = await api('/api/jobs/update', { method: 'POST', body: { id, ...patch } });
    const index = state.jobs.findIndex((j) => j.id === id);
    if (index >= 0) state.jobs[index] = job;
    // Re-render rather than patching one node: status changes move a card
    // between columns and can drop a row out of the active filter.
    if (state.statusFilter && job.status !== state.statusFilter) await loadJobs();
    else render();
    if (patch.status) toast(`Moved to ${statusLabel(patch.status)}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --- drawer ----------------------------------------------------------------

function openDrawer(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  const inner = clear($('#drawer-inner'));
  let notesValue = job.notes || '';

  inner.append(
    h(
      'div',
      { class: 'drawer__head' },
      h(
        'div',
        { style: 'flex:1;min-width:0' },
        h('p', { class: 'eyebrow', text: `${job.score} / 100` }),
        h('h2', { class: 'drawer__title', text: job.title }),
        h('p', {
          class: 'muted',
          style: 'font-size:.875rem;margin-top:.35rem',
          text: [job.company, job.remote ? 'Remote' : job.location].filter(Boolean).join(' · '),
        })
      ),
      h('button', { class: 'icon-btn', text: '×', 'aria-label': 'Close', onclick: closeDrawer })
    ),

    h(
      'div',
      { class: 'drawer__meta' },
      salaryText(job) ? h('span', { class: 'tag', text: salaryText(job) }) : null,
      job.employment ? h('span', { class: 'tag', text: job.employment }) : null,
      job.postedAt ? h('span', { class: 'tag', text: `posted ${relativeTime(job.postedAt)}` }) : null,
      h('span', { class: 'tag', text: `found ${relativeTime(job.discoveredAt)}` }),
      job.closedAt
        ? h('span', {
            class: isDelisted(job) ? 'tag tag--closed' : 'tag tag--noted',
            text: `no longer listed ${relativeTime(job.closedAt)}`,
          })
        : null,
      // Where Open actually goes, and how strong the liveness evidence is.
      // A company board listing the role is proof; an aggregator page loading
      // is not, and the wording says so.
      job.linkDirect
        ? h('span', {
            class: 'tag tag--live',
            title: `Confirmed in the employer's own listing when we last checked, ${relativeTime(job.linkCheckedAt)}.`,
            text: 'on the company careers site',
          })
        : h('span', {
            class: 'tag',
            title: 'Found through a job aggregator. We could not confirm it against the employer’s own careers page.',
            text: 'via aggregator — unconfirmed',
          }),
      job.appliedAt ? h('span', { class: 'tag', text: `applied ${relativeTime(job.appliedAt)}` }) : null
    ),

    job.scoreReason
      ? h(
          'div',
          { class: 'drawer__why' },
          h('div', { class: 'label', text: `Why ${job.score}` }),
          h('div', { text: job.scoreReason }),
          h('div', {
            class: 'faint',
            style: 'font-size:.75rem;margin-top:.5rem',
            text: job.scoredBy === 'heuristic' ? 'Ranked by the built-in scorer' : `Ranked by ${job.scoredBy}`,
          })
        )
      : null,

    h(
      'div',
      { class: 'drawer__actions' },
      job.url
        ? h('a', {
            class: 'btn btn--primary',
            href: safeHref(job.url),
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'Open posting',
          })
        : null,
      h(
        'select',
        {
          class: 'select',
          style: 'width:auto',
          onchange: async (event) => {
            await updateJob(job.id, { status: event.target.value });
            closeDrawer();
          },
        },
        ...[...STATUSES, { key: 'archived', label: 'Archived' }].map((status) =>
          h('option', { value: status.key, selected: status.key === job.status }, status.label)
        )
      )
    ),

    h(
      'div',
      {},
      h('div', { class: 'label', text: 'Your notes' }),
      h('textarea', {
        class: 'textarea',
        placeholder: 'Recruiter name, referral, where you left off…',
        text: notesValue,
        oninput: (event) => {
          notesValue = event.target.value;
        },
      }),
      h('button', {
        class: 'btn btn--ghost btn--sm',
        style: 'margin-top:.5rem',
        text: 'Save notes',
        onclick: async (event) => {
          await busy(event.target, 'Saving…', async () => {
            await updateJob(job.id, { notes: notesValue });
            toast('Notes saved');
          })(event);
        },
      })
    ),

    job.description
      ? h(
          'div',
          {},
          h('div', { class: 'label', text: 'Description' }),
          h('div', { class: 'drawer__desc', text: job.description })
        )
      : null
  );

  $('#drawer').hidden = false;
  $('#drawer-scrim').hidden = false;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-scrim').hidden = true;
}

// ===========================================================================
// MODALS
// ===========================================================================

function fieldRow(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
}

/** A field the form will not submit without. The marker is on the label rather
 *  than only enforced on submit, so the requirement is visible up front. */
function requiredRow(label, input, hint) {
  return h(
    'label',
    { class: 'field' },
    h('span', {}, label, h('span', { class: 'req', text: 'required' })),
    input,
    hint ? h('span', { class: 'hint', text: hint }) : null
  );
}

/** Flags a field as the reason a submit failed, and clears on next input. */
function flagInvalid(input, message) {
  input.classList.add('is-invalid');
  input.focus();
  const clearFlag = () => {
    input.classList.remove('is-invalid');
    input.removeEventListener('input', clearFlag);
  };
  input.addEventListener('input', clearFlag);
  toast(message, 'error');
}

// --- board editor ----------------------------------------------------------

// Small and static, so the labels live here rather than costing a round trip
// just to render a select.
const CATEGORIES = [
  ['', 'Work it out from what I wrote'],
  ['creative', 'Photo, video and creative'],
  ['software', 'Software and data'],
  ['support', 'Customer service and support'],
  ['marketing', 'Marketing and writing'],
  ['sales', 'Sales and business development'],
  ['product', 'Product and programme'],
  ['teaching', 'Teaching and coaching'],
  ['trades', 'Trades and field work'],
  ['care', 'Health and care'],
  ['other', 'Something else — search everything'],
];

function openBoardEditor(existing) {
  const board = existing && existing.id ? existing : null;
  const filters = (board && board.filters) || {};

  const name = h('input', { class: 'input', value: board ? board.name : '', placeholder: 'Backend roles' });
  const prompt = h('textarea', {
    class: 'textarea',
    placeholder:
      'Senior backend roles at small companies. Remote or NYC. Go, Rust, or TypeScript. At least $180k. Not interested in crypto or adtech.',
    text: board ? board.prompt : '',
  });
  const keywords = h('input', { class: 'input', value: filters.keywords || '', placeholder: 'backend, platform' });
  const exclude = h('input', { class: 'input', value: filters.exclude || '', placeholder: 'crypto, sales' });
  const locations = h('input', { class: 'input', value: filters.locations || '', placeholder: 'new york, london' });
  const minSalary = h('input', { class: 'input', type: 'number', min: '0', step: '5000', value: String(filters.minSalary || 0) });
  const remoteOnly = h('input', { type: 'checkbox', checked: Boolean(filters.remoteOnly) });
  const scoutToggle = h('input', { type: 'checkbox', checked: true });
  const category = h(
    'select',
    { class: 'input' },
    ...CATEGORIES.map(([value, label]) =>
      h('option', { value, text: label, selected: (filters.category || '') === value })
    )
  );
  const LEVELS = [
    ['0', 'Internship'],
    ['1', 'Junior'],
    ['2', 'Mid'],
    ['3', 'Senior / Staff'],
    ['4', 'Principal'],
    ['5', 'Director+'],
  ];

  const seniority = h(
    'select',
    { class: 'select' },
    ...[['', 'No preference'], ...LEVELS].map(([value, label]) =>
      h('option', { value, selected: String(filters.seniority ?? '') === value }, label)
    )
  );

  const minSeniority = h(
    'select',
    { class: 'select' },
    ...[['', 'No minimum'], ...LEVELS].map(([value, label]) =>
      h('option', { value, selected: String(filters.minSeniority ?? '') === value }, label)
    )
  );

  const companies = h('textarea', {
    class: 'textarea',
    style: 'min-height:5rem',
    placeholder: 'Stripe, Linear, Vercel, Ramp',
    text: filters.companies || '',
  });
  const companyMode = h(
    'select',
    { class: 'select' },
    h('option', { value: 'prioritize', selected: filters.companyMode !== 'limit' }, 'Prioritize these'),
    h('option', { value: 'limit', selected: filters.companyMode === 'limit' }, 'Only these companies')
  );

  const maxAge = h(
    'select',
    { class: 'select' },
    ...[
      ['', 'No limit'],
      ['7', 'A week'],
      ['14', 'Two weeks'],
      ['30', 'A month'],
      ['60', 'Two months'],
      ['90', 'Three months'],
    ].map(([value, label]) =>
      h('option', { value, selected: String(filters.maxAgeDays ?? '') === value }, label)
    )
  );
  // Capped at one scheduled refresh a day. Each refresh can spend up to four
  // model batches, and postings do not appear fast enough for hourly to be
  // worth 24x the cost. The Refresh button is there for "now".
  const refreshEvery = h(
    'select',
    { class: 'select' },
    ...[
      [1440, 'Once a day'],
      [2880, 'Every 2 days'],
      [10080, 'Weekly'],
    ].map(([value, label]) =>
      h('option', { value: String(value), selected: (board ? board.refreshEvery : 1440) === value }, label)
    )
  );
  const refreshMode = h(
    'select',
    { class: 'select' },
    h('option', { value: 'schedule', selected: !board || board.refreshMode === 'schedule' }, 'On a schedule'),
    h('option', { value: 'manual', selected: board && board.refreshMode === 'manual' }, 'Only when I refresh')
  );

  const save = h('button', { class: 'btn btn--primary', text: board ? 'Save board' : 'Create board' });
  save.addEventListener(
    'click',
    busy(save, 'Saving…', async () => {
      if (!name.value.trim()) {
        flagInvalid(name, 'Give the board a name.');
        return;
      }
      // Not arbitrary strictness: with no criteria there is nothing to derive a
      // source query from, and the aggregators would pull unfiltered noise.
      if (prompt.value.trim().length < 10 && !keywords.value.trim()) {
        flagInvalid(prompt, 'Describe what you are looking for — a sentence is enough.');
        return;
      }

      const body = {
        id: board ? board.id : undefined,
        name: name.value.trim(),
        prompt: prompt.value,
        refreshMode: refreshMode.value,
        refreshEvery: Number(refreshEvery.value),
        filters: {
          keywords: keywords.value,
          exclude: exclude.value,
          locations: locations.value,
          minSalary: Number(minSalary.value) || 0,
          remoteOnly: remoteOnly.checked,
          seniority: seniority.value === '' ? undefined : Number(seniority.value),
          minSeniority: minSeniority.value === '' ? undefined : Number(minSeniority.value),
          maxAgeDays: maxAge.value === '' ? undefined : Number(maxAge.value),
          companies: companies.value,
          companyMode: companyMode.value,
          category: category.value || undefined,
        },
        scout: scoutToggle.checked,
      };
      const result = await api(board ? '/api/boards/update' : '/api/boards/create', {
        method: 'POST',
        body,
      });
      closeModal();
      if (!board && result.board) state.boardId = result.board.id;
      await loadBoards();
      if (board) {
        toast('Board saved');
      } else {
        // Sources are found server-side; the board fills itself in.
        toast('Board created — finding sources now');
        watchProvisioning();
      }
    })
  );

  // Two required fields, everything else behind a disclosure. The defaults are
  // deliberately good enough to skip: sources are found automatically, recency
  // already dominates the ranking, and an unset filter is a filter that cannot
  // accidentally hide the job someone wanted.
  const body = h(
    'div',
    {},
    requiredRow('Board name', name),
    requiredRow(
      'What are you looking for?',
      prompt,
      'Plain English, the way you would tell a friend. This is what finds your sources and ranks every job — it is the only part that really matters.'
    ),

    h(
      'details',
      { class: 'advanced', open: Boolean(board) },
      h(
        'summary',
        { class: 'advanced__summary' },
        h('span', { text: 'Advanced options' }),
        h('span', { class: 'advanced__hint mono', text: 'all optional' })
      ),

      h('div', { class: 'advanced__body' }, [
        h('p', {
          class: 'hint',
          style: 'margin:0 0 1.25rem',
          text: 'Sensible defaults are already applied. Everything here narrows what you see, so leaving it alone casts the widest net.',
        }),

        h('div', { class: 'label', text: 'How the search runs' }),

        // Left blank, the field is worked out from what they wrote, which is
        // the case that needs no thought at all - so it sits here rather than
        // beside the sentence it is inferred from.
        fieldRow(
          'Kind of work',
          category,
          'Decides which job sources are searched and what counts as the wrong field. Leave it alone unless the results look like the wrong line of work.'
        ),

        // Still says what it costs, since it is the one control in here that
        // spends money rather than narrowing what is already found.
        board
          ? null
          : h(
              'div',
              { class: 'field' },
              h(
                'label',
                { class: 'checkbox' },
                scoutToggle,
                h('span', { text: 'Also search the open web' })
              ),
              h('span', {
                class: 'hint',
                text: 'Finds organisations to approach directly — retreats, studios, venues, local businesses — and how to approach them. Job boards do not carry that work. Costs a few cents from your daily AI budget.',
              })
            ),

        h('div', { class: 'label', style: 'margin-top:1.5rem', text: 'Companies' }),
        fieldRow(
          'Company list',
          companies,
          'Comma separated. We find each one’s job board for you — no need to look anything up.'
        ),
        fieldRow(
          'How to use it',
          companyMode,
          'Prioritize ranks these above everything else. Only these makes it an allowlist and drops the rest.'
        ),

        h('div', { class: 'label', style: 'margin-top:1.5rem', text: 'Filters (applied before ranking)' }),
        h('div', { class: 'row' }, fieldRow('Must mention', keywords, 'Comma separated. Any one is enough.'), fieldRow('Rule out', exclude, 'Comma separated.')),
        h('div', { class: 'row' }, fieldRow('Locations', locations, 'Remote jobs always pass.'), fieldRow('Minimum salary', minSalary, 'Jobs with no published range are kept.')),
        h(
          'div',
          { class: 'row' },
          fieldRow('Minimum level', minSeniority, 'Drops anything below it. Titles that state no level are kept.'),
          fieldRow('Preferred level', seniority, 'Ranking nudge, not a filter.')
        ),
        fieldRow(
          'Ignore postings older than',
          maxAge,
          'Recency is already the heaviest ranking signal — this drops old postings entirely. Undated ones are kept.'
        ),
        h('label', { class: 'checkbox' }, remoteOnly, h('span', { text: 'Remote roles only' })),

        h('div', { class: 'label', style: 'margin-top:1.5rem', text: 'Schedule' }),
        h('div', { class: 'row' }, fieldRow('Refresh', refreshEvery), fieldRow('Refresh mode', refreshMode)),
      ])
    ),

    h(
      'div',
      { class: 'modal__foot' },
      board
        ? h('button', {
            class: 'btn btn--danger',
            text: 'Delete board',
            onclick: async () => {
              if (!confirm(`Delete "${board.name}" and everything on it? This cannot be undone.`)) return;
              await api('/api/boards/delete', { method: 'POST', body: { id: board.id } });
              closeModal();
              state.boardId = null;
              await loadBoards({ keepSelection: false });
              toast('Board deleted');
            },
          })
        : null,
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn btn--ghost', text: 'Cancel', onclick: closeModal }),
      save
    )
  );

  showModal(board ? 'Board settings' : 'New board', body, { wide: true });
}

// --- sources ---------------------------------------------------------------

async function openSources() {
  if (!state.boardId) return;
  const body = h('div', {});
  showModal('Sources', body, { wide: true });
  await renderSources(body);
}

async function renderSources(container) {
  clear(container);
  const { sources, board } = await api(`/api/sources?boardId=${encodeURIComponent(state.boardId)}`);

  const rows = h('div', { class: 'list-rows' });
  if (sources.length === 0) {
    rows.append(
      h('p', {
        class: 'muted',
        style: 'font-size:.875rem',
        text: 'None connected yet — discovery runs automatically after a board is created.',
      })
    );
  }
  for (const source of sources) {
    rows.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: `dot${source.lastStatus ? ` dot--${source.lastStatus}` : ''}` }),
        h(
          'div',
          { class: 'list-row__main' },
          h(
            'span',
            { class: 'list-row__title' },
            source.label || source.identifier,
            source.auto ? h('span', { class: 'tag', style: 'margin-left:.5rem', text: 'auto' }) : null
          ),
          h('span', {
            class: 'list-row__sub',
            text: source.lastError
              ? `${source.kind} · ${source.lastError}`
              : `${source.kind} · ${source.identifier} · ${source.foundCount} matching`,
          })
        ),
        h('button', {
          class: 'btn btn--ghost btn--sm',
          text: source.enabled ? 'Pause' : 'Resume',
          onclick: async () => {
            await api('/api/sources/update', {
              method: 'POST',
              body: { id: source.id, enabled: !source.enabled },
            });
            await renderSources(container);
          },
        }),
        h('button', {
          class: 'btn btn--danger btn--sm',
          text: 'Remove',
          onclick: async () => {
            await api('/api/sources/delete', { method: 'POST', body: { id: source.id } });
            await renderSources(container);
          },
        })
      )
    );
  }

  const kind = h(
    'select',
    { class: 'select' },
    h('option', { value: 'greenhouse' }, 'Greenhouse'),
    h('option', { value: 'lever' }, 'Lever'),
    h('option', { value: 'ashby' }, 'Ashby'),
    h('option', { value: 'rss' }, 'RSS / Atom feed')
  );
  const identifier = h('input', { class: 'input', placeholder: 'stripe' });
  const label = h('input', { class: 'input', placeholder: 'Stripe (optional)' });
  const result = h('div', { class: 'notice', hidden: true });

  kind.addEventListener('change', () => {
    identifier.placeholder = kind.value === 'rss' ? 'https://example.com/jobs.rss' : 'stripe';
  });

  const test = h('button', { class: 'btn btn--ghost', text: 'Test' });
  test.addEventListener(
    'click',
    busy(test, 'Testing…', async () => {
      const res = await api('/api/sources/test', {
        method: 'POST',
        body: { kind: kind.value, identifier: identifier.value.trim() },
      });
      result.hidden = false;
      if (res.ok) {
        result.className = 'notice notice--ok';
        result.textContent =
          res.count === 0
            ? 'Reached it, but it lists no open roles right now.'
            : `Found ${res.count} open roles, e.g. ${res.sample.map((j) => j.title).join(', ')}`;
      } else {
        result.className = 'notice notice--error';
        result.textContent = res.error;
      }
    })
  );

  const add = h('button', { class: 'btn btn--primary', text: 'Add source' });
  add.addEventListener(
    'click',
    busy(add, 'Adding…', async () => {
      await api('/api/sources/create', {
        method: 'POST',
        body: {
          boardId: state.boardId,
          kind: kind.value,
          identifier: identifier.value.trim(),
          label: label.value.trim(),
        },
      });
      identifier.value = '';
      label.value = '';
      result.hidden = true;
      await renderSources(container);
      toast('Source added — hit Refresh to pull it in');
    })
  );

  // --- discovery ---
  const curate = h('button', { class: 'btn btn--primary', text: 'Find sources now' });
  curate.addEventListener(
    'click',
    busy(curate, 'Searching…', async () => {
      await runCuration();
      await renderSources(container);
    })
  );

  const suggestOut = h('div', { class: 'list-rows', style: 'margin-top:.75rem' });
  const suggest = h('button', { class: 'btn btn--ghost', text: 'Suggest similar companies' });
  suggest.addEventListener(
    'click',
    busy(suggest, 'Thinking…', async () => {
      clear(suggestOut);
      const res = await api('/api/sources/suggest', {
        method: 'POST',
        body: { boardId: state.boardId },
      });
      if (!res.ok) {
        suggestOut.append(h('div', { class: 'notice notice--warn', text: res.error }));
        return;
      }
      if (res.companies.length === 0) {
        suggestOut.append(
          h('div', {
            class: 'notice',
            text: `Checked ${res.checked} candidates but none had a reachable job board right now.`,
          })
        );
        return;
      }
      for (const company of res.companies) {
        suggestOut.append(
          h(
            'div',
            { class: 'list-row' },
            h('span', { class: 'dot dot--ok' }),
            h(
              'div',
              { class: 'list-row__main' },
              h('span', { class: 'list-row__title', text: `${company.name} · ${company.count} open` }),
              h('span', { class: 'list-row__sub', text: `${company.kind} · ${company.reason}` })
            ),
            h('button', {
              class: 'btn btn--primary btn--sm',
              text: 'Add',
              onclick: async (event) => {
                await busy(event.target, 'Adding…', async () => {
                  await api('/api/sources/create', {
                    method: 'POST',
                    body: {
                      boardId: state.boardId,
                      kind: company.kind,
                      identifier: company.identifier,
                      label: company.name,
                    },
                  });
                  toast(`${company.name} connected`);
                  await renderSources(container);
                })(event);
              },
            })
          )
        );
      }
    })
  );

  // Definitive answer on whether the model is reachable. The failure modes all
  // look the same from the outside, so this reports the actual reason.
  const aiOut = h('div', { style: 'margin-top:.75rem' });
  const aiBtn = h('button', { class: 'btn btn--ghost btn--sm', text: 'Check AI connection' });
  aiBtn.addEventListener(
    'click',
    busy(aiBtn, 'Checking…', async () => {
      const res = await api('/api/account/ai-check', { method: 'POST', body: {} });
      clear(aiOut).append(
        h('div', {
          class: `notice notice--${res.ok ? 'ok' : res.state === 'missing' ? 'warn' : 'error'}`,
          text: res.message,
        })
      );

      // When it cannot see the key, show what it *can* see. "The secret exists
      // in the dashboard" and "the Worker can read it" are different claims,
      // and this is the only thing that tells them apart.
      if (res.bindings) {
        const { present, allNames } = res.bindings;
        const rows = Object.entries(present).map(([name, ok]) =>
          h(
            'div',
            { class: 'list-row' },
            h('span', { class: `dot${ok ? ' dot--ok' : ' dot--error'}` }),
            h(
              'div',
              { class: 'list-row__main' },
              h('span', { class: 'list-row__title', text: name }),
              h('span', { class: 'list-row__sub', text: ok ? 'visible to this Worker' : 'not set' })
            )
          )
        );
        aiOut.append(
          h('p', {
            class: 'label',
            style: 'margin-top:1rem',
            text: `What Worker "${res.bindings.worker}" can see`,
          }),
          h('div', { class: 'list-rows' }, ...rows),
          h('p', {
            class: 'hint',
            text: `All bindings: ${allNames.join(', ')}`,
          }),
          h('p', {
            class: 'hint',
            text: `If the Worker you are editing in the Cloudflare dashboard is not called "${res.bindings.worker}", the secrets are going somewhere this code never reads.`,
          })
        );
      }
    })
  );

  container.append(
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'AI features' }),
      h('p', {
        text: 'Source discovery and criteria-aware ranking both need an Anthropic API key on the Worker. Without one the board still runs on the built-in ranking.',
      }),
      aiBtn,
      aiOut
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Where these jobs come from' }),
      h('p', {
        text: board && board.curateNote
          ? board.curateNote
          : 'Sources are chosen for you from your criteria, verified against a live job board, and re-checked weekly. Ones that go quiet or start failing are retired automatically.',
      }),
      rows,
      h('div', { style: 'display:flex;gap:.5rem;margin-top:1rem' }, curate, suggest),
      suggestOut
    ),
    h(
      'details',
      { class: 'panel' },
      h('summary', { style: 'cursor:pointer;font-weight:600;font-size:.9375rem', text: 'Add one by hand' }),
      h('p', {
        style: 'margin-top:.75rem',
        text: 'Rarely needed. For an ATS, use the identifier from the careers URL — boards.greenhouse.io/stripe means "stripe".',
      }),
      h('div', { class: 'row' }, fieldRow('Type', kind), fieldRow('Identifier', identifier)),
      fieldRow('Label', label, 'Optional. Shown instead of the identifier.'),
      result,
      h('div', { style: 'display:flex;gap:.5rem;justify-content:flex-end' }, test, add)
    )
  );
}

// --- alerts ----------------------------------------------------------------

async function openAlerts() {
  const body = h('div', {});
  showModal('Alerts', body, { wide: true });
  await renderAlerts(body);
}

async function renderAlerts(container) {
  clear(container);
  const [{ rules, emailVerified }, { notifications }] = await Promise.all([
    api('/api/rules'),
    api('/api/notifications'),
  ]);

  if (!emailVerified) {
    container.append(
      h(
        'div',
        { class: 'notice notice--warn' },
        'Confirm your email address before alerts can be delivered. ',
        h('button', {
          class: 'linkish',
          text: 'Resend the confirmation',
          onclick: async () => {
            await api('/api/auth/verify/resend', { method: 'POST', body: {} });
            toast('Confirmation email sent');
          },
        })
      )
    );
  }

  const rows = h('div', { class: 'list-rows' });
  if (rules.length === 0) {
    rows.append(h('p', { class: 'muted', style: 'font-size:.875rem', text: 'No alerts yet.' }));
  }
  for (const rule of rules) {
    const boardName = rule.boardId
      ? (state.boards.find((b) => b.id === rule.boardId) || {}).name || 'a deleted board'
      : 'All boards';
    const cadence =
      rule.trigger === 'instant'
        ? 'as soon as it lands'
        : rule.trigger === 'digest_daily'
          ? `daily at ${String(rule.sendHour).padStart(2, '0')}:00`
          : `weekly at ${String(rule.sendHour).padStart(2, '0')}:00`;

    rows.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: `dot${rule.enabled ? ' dot--ok' : ''}` }),
        h(
          'div',
          { class: 'list-row__main' },
          h('span', { class: 'list-row__title', text: `${boardName} · score ${rule.minScore}+` }),
          h('span', {
            class: 'list-row__sub',
            text: `email ${cadence}${rule.keywords ? ` · ${rule.keywords}` : ''}`,
          })
        ),
        h('button', {
          class: 'btn btn--ghost btn--sm',
          text: rule.enabled ? 'Pause' : 'Resume',
          onclick: async () => {
            await api('/api/rules/update', {
              method: 'POST',
              body: { id: rule.id, enabled: !rule.enabled },
            });
            await renderAlerts(container);
          },
        }),
        h('button', {
          class: 'btn btn--danger btn--sm',
          text: 'Delete',
          onclick: async () => {
            await api('/api/rules/delete', { method: 'POST', body: { id: rule.id } });
            await renderAlerts(container);
          },
        })
      )
    );
  }

  const boardSelect = h(
    'select',
    { class: 'select' },
    h('option', { value: '' }, 'All boards'),
    ...state.boards.map((b) => h('option', { value: b.id }, b.name))
  );
  const trigger = h(
    'select',
    { class: 'select' },
    h('option', { value: 'instant' }, 'As soon as it lands'),
    h('option', { value: 'digest_daily' }, 'Daily digest'),
    h('option', { value: 'digest_weekly' }, 'Weekly digest')
  );
  const minScore = h('input', { class: 'input', type: 'number', min: '0', max: '100', step: '5', value: '75' });
  const keywords = h('input', { class: 'input', placeholder: 'staff, principal (optional)' });
  const sendHour = h('input', { class: 'input', type: 'number', min: '0', max: '23', value: '8' });

  const create = h('button', { class: 'btn btn--primary', text: 'Create alert' });
  create.addEventListener(
    'click',
    busy(create, 'Creating…', async () => {
      await api('/api/rules/create', {
        method: 'POST',
        body: {
          boardId: boardSelect.value,
          trigger: trigger.value,
          minScore: Number(minScore.value),
          keywords: keywords.value,
          sendHour: Number(sendHour.value),
        },
      });
      await renderAlerts(container);
      toast('Alert created');
    })
  );

  const history = h('div', { class: 'list-rows' });
  if (notifications.length === 0) {
    history.append(h('p', { class: 'muted', style: 'font-size:.875rem', text: 'Nothing sent yet.' }));
  }
  for (const item of notifications.slice(0, 10)) {
    const explain =
      item.status === 'skipped_no_provider'
        ? 'not sent — no email provider configured'
        : item.status === 'failed'
          ? `failed — ${item.error}`
          : `sent ${relativeTime(item.sentAt || item.createdAt)}`;
    history.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: `dot${item.status === 'sent' ? ' dot--ok' : item.status === 'failed' ? ' dot--error' : ''}` }),
        h(
          'div',
          { class: 'list-row__main' },
          h('span', { class: 'list-row__title', text: item.subject }),
          h('span', { class: 'list-row__sub', text: explain })
        )
      )
    );
  }

  container.append(
    h('div', { class: 'panel' }, h('h3', { text: 'Your alerts' }), h('p', { text: 'Each alert emails you when a job clears its score threshold. The same job is never sent twice.' }), rows),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'New alert' }),
      h('div', { class: 'row' }, fieldRow('Board', boardSelect), fieldRow('When', trigger)),
      h('div', { class: 'row' }, fieldRow('Minimum score', minScore), fieldRow('Digest hour (your time)', sendHour, '24-hour clock. Ignored for instant alerts.')),
      fieldRow('Must mention', keywords, 'Optional. Comma separated.'),
      h('div', { style: 'display:flex;justify-content:flex-end' }, create)
    ),
    h('div', { class: 'panel' }, h('h3', { text: 'Recent sends' }), history)
  );
}

// --- insights --------------------------------------------------------------



async function openApplications() {
  const body = h('div', {});
  showModal('Applications', body, { wide: true });
  const { applications } = await api('/api/applications');

  clear(body);
  if (applications.length === 0) {
    body.append(
      h('div', {
        class: 'notice',
        text: 'Nothing archived yet. Anything you move to Applied is recorded here, along with a copy of the posting as it read at the time.',
      })
    );
    return;
  }

  body.append(
    h('p', {
      class: 'hint',
      style: 'margin-bottom:1rem',
      text: 'Read from the archive rather than the board, so these survive a posting being taken down or a board being deleted.',
    })
  );

  for (const app of applications) {
    const detail = h('div', { hidden: true, style: 'margin-top:.75rem' });
    let loaded = false;

    body.append(
      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { style: 'display:flex;align-items:flex-start;gap:1rem' },
          h(
            'div',
            { style: 'flex:1;min-width:0' },
            h('h3', { text: app.title || '(untitled)' }),
            h('p', {
              style: 'margin:0',
              text: [app.company, app.salary].filter(Boolean).join(' · '),
            }),
            h('span', {
              class: 'list-row__sub',
              text: `applied ${relativeTime(app.appliedAt)} · now ${statusLabel(app.outcome)}`,
            })
          ),
          h('span', { class: `pill pill--${app.outcome}`, text: statusLabel(app.outcome) }),
          h('button', {
            class: 'btn btn--ghost btn--sm',
            text: 'What I applied to',
            onclick: async (event) => {
              detail.hidden = !detail.hidden;
              if (loaded || detail.hidden) return;
              loaded = true;
              const { history } = await api(`/api/jobs/history?id=${encodeURIComponent(app.jobId)}`);
              const snap = app.snapshot || {};
              clear(detail).append(
                snap.description
                  ? h(
                      'div',
                      {},
                      h('div', { class: 'label', text: 'The posting, as it read when you applied' }),
                      h('div', { class: 'drawer__desc', style: 'max-height:16rem', text: snap.description }),
                      snap.profileHeadline
                        ? h('p', {
                            class: 'hint',
                            text: `Your profile then: ${snap.profileHeadline}${(snap.profileSkills || []).length ? ` — ${snap.profileSkills.slice(0, 8).join(', ')}` : ''}`,
                          })
                        : null
                    )
                  : h('p', { class: 'hint', text: 'No copy of the posting was captured for this one.' }),
                h('div', { class: 'label', style: 'margin-top:1rem', text: 'Timeline' }),
                h(
                  'div',
                  { class: 'list-rows' },
                  ...history.map((e) =>
                    h(
                      'div',
                      { class: 'list-row' },
                      h('span', { class: 'dot' }),
                      h(
                        'div',
                        { class: 'list-row__main' },
                        h('span', {
                          class: 'list-row__title',
                          text: `${e.from ? statusLabel(e.from) + ' → ' : ''}${statusLabel(e.to)}`,
                        }),
                        h('span', {
                          class: 'list-row__sub',
                          text: `${new Date(e.at).toLocaleString()}${e.note ? ` · ${e.note}` : ''}`,
                        })
                      )
                    )
                  )
                )
              );
            },
          })
        ),
        detail
      )
    );
  }
}

async function openInsights() {
  const body = h('div', {});
  showModal('Insights', body, { wide: true });
  await renderInsights(body);
}

async function renderInsights(container, afterDays) {
  clear(container);
  const query = afterDays === undefined ? '' : `?afterDays=${afterDays}`;
  const { followUps, skillGaps, followUpAfterDays } = await api(`/api/insights${query}`);

  // --- applications that have gone quiet ---
  const quiet = h('div', { class: 'list-rows' });
  if (followUps.length === 0) {
    quiet.append(
      h('p', {
        class: 'muted',
        style: 'font-size:.875rem',
        text: 'Nothing has gone quiet. Applications appear here once they have sat unchanged for a while.',
      })
    );
  }
  for (const item of followUps) {
    quiet.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: 'dot dot--error' }),
        h(
          'div',
          { class: 'list-row__main' },
          h('span', { class: 'list-row__title', text: `${item.title} · ${item.company}` }),
          h('span', {
            class: 'list-row__sub',
            text: `${item.status} · quiet ${item.quietForDays} days${item.delisted ? ' · listing has come down' : ''}`,
          })
        ),
        item.url
          ? h('a', {
              class: 'btn btn--ghost btn--sm',
              href: safeHref(item.url),
              target: '_blank',
              rel: 'noopener noreferrer',
              text: 'Open',
            })
          : null,
        h('button', {
          class: 'btn btn--ghost btn--sm',
          text: 'Followed up',
          title: 'Stop reminding me about this one.',
          onclick: async (event) => {
            await busy(event.target, 'Saving…', async () => {
              await api('/api/jobs/followed-up', { method: 'POST', body: { id: item.id } });
              await renderInsights(container);
            })(event);
          },
        })
      )
    );
  }

  // --- recurring skill gaps ---
  const gapsBox = h('div', {});
  if (!skillGaps.ready) {
    gapsBox.append(
      h('div', {
        class: 'notice notice--warn',
        text:
          skillGaps.reason === 'no-profile'
            ? 'Turn on your profile to see which skills keep coming up in jobs you are not quite matching.'
            : 'Not enough scored jobs yet. Add some to a board and check back.',
      })
    );
  } else if (skillGaps.gaps.length === 0) {
    gapsBox.append(
      h('div', {
        class: 'notice notice--ok',
        text: `Nothing recurring across ${skillGaps.scanned} jobs — your profile covers what they are asking for.`,
      })
    );
  } else {
    const max = skillGaps.gaps[0].jobs || 1;
    gapsBox.append(
      h('p', {
        class: 'hint',
        style: 'margin-bottom:1rem',
        text: `Across ${skillGaps.scanned} scored jobs, weighted so gaps on roles you match well count for more.`,
      }),
      ...skillGaps.gaps.map((gap) =>
        h(
          'div',
          { class: 'gap-row', title: gap.examples.join(' · ') },
          h('span', { class: 'gap-row__name', text: gap.skill }),
          h('span', { class: 'gap-row__bar' }, h('i', { style: `width:${Math.round((gap.jobs / max) * 100)}%` })),
          h('span', { class: 'gap-row__n mono', text: `${gap.jobs} jobs · ${gap.share}%` })
        )
      )
    );
  }

  container.append(
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Gone quiet' }),
      h('p', {
        text: `Applications with no movement for ${followUpAfterDays} days or more. Long enough not to look impatient, short enough that they still remember reading your name.`,
      }),
      h(
        'label',
        { class: 'field', style: 'max-width:16rem' },
        h('span', { text: 'Quiet after' }),
        h(
          'select',
          {
            class: 'select',
            onchange: (event) => renderInsights(container, Number(event.target.value)),
          },
          ...[3, 7, 10, 14, 21, 30].map((d) =>
            h('option', { value: String(d), selected: d === followUpAfterDays }, `${d} days`)
          )
        )
      ),
      quiet
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Skills that keep coming up' }),
      h('p', { text: 'What the jobs you are chasing ask for that your profile does not mention.' }),
      gapsBox
    )
  );
}

// --- candidate profile (optional) ------------------------------------------

async function openProfile() {
  const body = h('div', {});
  showModal('Your profile', body, { wide: true });
  await renderProfile(body);
}

async function renderProfile(container) {
  clear(container);
  const { profile, canParseWithModel } = await api('/api/profile');
  const p = profile || {
    headline: '', skills: [], titles: [], yearsExperience: 0,
    mustHave: [], dealBreakers: [], enabled: false, summary: '',
  };

  const enabled = h('input', { type: 'checkbox', checked: p.enabled });
  const headline = h('input', { class: 'input', value: p.headline, placeholder: 'Senior TPM, 8 years, infrastructure' });
  const skills = h('input', { class: 'input', value: (p.skills || []).join(', '), placeholder: 'kubernetes, terraform, python' });
  const mustHave = h('input', { class: 'input', value: (p.mustHave || []).join(', '), placeholder: 'kubernetes' });
  const dealBreakers = h('input', { class: 'input', value: (p.dealBreakers || []).join(', '), placeholder: 'crypto, on-call, relocation' });
  const years = h('input', { class: 'input', type: 'number', min: '0', max: '60', value: String(p.yearsExperience || 0) });
  const cv = h('textarea', { class: 'textarea', style: 'min-height:9rem', placeholder: 'Paste your CV here…', text: p.summary || '' });
  const parseOut = h('div', {});
  const fileOut = h('div', {});

  /**
   * Read a dropped or chosen file into the box.
   *
   * Parsing happens here in the browser, so the file itself is never uploaded -
   * only the text, and only when the user presses save. Failures name the cause
   * and the fix rather than just refusing.
   */
  const fileInput = h('input', {
    type: 'file',
    class: 'visually-hidden',
    accept:
      '.txt,.md,.docx,.pdf,text/plain,text/markdown,application/pdf,' +
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    onchange: async (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) await takeFile(file);
      // Cleared so picking the same file twice still fires a change event.
      event.target.value = '';
    },
  });

  const takeFile = async (file) => {
    clear(fileOut);
    try {
      const { text, kind } = await readResumeFile(file);
      if (!text || text.trim().length < 40) {
        throw new Error('That file came out almost empty. Paste the text below instead.');
      }
      cv.value = text;
      fileOut.append(
        h('div', {
          class: 'notice notice--ok',
          text: `Read ${file.name} (${kind}, ${text.length.toLocaleString()} characters). Check it below, then press "Read my CV".`,
        })
      );
    } catch (err) {
      fileOut.append(h('div', { class: 'notice notice--warn', text: err.message }));
    }
  };

  const parse = h('button', { class: 'btn btn--ghost', text: 'Read my CV' });
  parse.addEventListener(
    'click',
    busy(parse, 'Reading…', async () => {
      const res = await api('/api/profile/parse', { method: 'POST', body: { text: cv.value } });
      // Filled in for review rather than saved: a profile quietly populated
      // with things you did not write is worse than an empty one.
      headline.value = res.profile.headline || headline.value;
      if ((res.profile.skills || []).length) skills.value = res.profile.skills.join(', ');
      if (res.profile.yearsExperience) years.value = String(res.profile.yearsExperience);
      clear(parseOut).append(
        h('div', {
          class: `notice notice--${res.warning ? 'warn' : 'ok'}`,
          text:
            res.warning ||
            `Read with the ${res.parsedBy === 'heuristic' ? 'built-in reader' : res.parsedBy}. Check it below, then save.`,
        })
      );
    })
  );

  const save = h('button', { class: 'btn btn--primary', text: 'Save profile' });
  save.addEventListener(
    'click',
    busy(save, 'Saving…', async () => {
      await api('/api/profile', {
        method: 'POST',
        body: {
          enabled: enabled.checked,
          headline: headline.value,
          summary: cv.value,
          skills: skills.value,
          titles: p.titles || [],
          yearsExperience: Number(years.value) || 0,
          mustHave: mustHave.value,
          dealBreakers: dealBreakers.value,
        },
      });
      toast(enabled.checked ? 'Profile saved and in use' : 'Profile saved, currently off');
      await renderProfile(container);
    })
  );

  container.append(
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Use my profile when ranking' }),
      h('p', {
        text: 'Optional. With this off, nothing here affects your boards and ranking works exactly as it does today. With it on, every board is scored against what you have actually done as well as what you typed.',
      }),
      h('label', { class: 'checkbox' }, enabled, h('span', { text: 'Rank jobs against my profile' }))
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'From your CV' }),
      h('p', {
        text: canParseWithModel
          ? 'Upload it or paste it, and we will pull out your skills and experience for you to check.'
          : 'Upload it or paste it, and we will pull out what we can. Adding an Anthropic API key makes this noticeably better.',
      }),
      h(
        'div',
        {
          class: 'dropzone',
          ondragover: (event) => {
            event.preventDefault();
            event.currentTarget.classList.add('is-over');
          },
          ondragleave: (event) => event.currentTarget.classList.remove('is-over'),
          ondrop: async (event) => {
            event.preventDefault();
            event.currentTarget.classList.remove('is-over');
            const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            if (file) await takeFile(file);
          },
        },
        fileInput,
        h('span', { class: 'dropzone__icon', 'aria-hidden': 'true', text: '↥' }),
        h(
          'span',
          {},
          h('button', {
            class: 'linkish',
            type: 'button',
            text: 'Choose a file',
            onclick: () => fileInput.click(),
          }),
          ' or drop it here'
        ),
        h('span', { class: 'dropzone__hint mono', text: '.docx · .pdf · .txt · .md — never leaves your browser' })
      ),
      fileOut,
      cv,
      h('div', { style: 'display:flex;gap:.5rem;margin:.75rem 0' }, parse),
      parseOut
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Details' }),
      fieldRow('Headline', headline),
      h('div', { class: 'row' }, fieldRow('Skills', skills, 'Comma separated.'), fieldRow('Years of experience', years)),
      fieldRow('Must mention', mustHave, 'A job missing these is ranked down.'),
      fieldRow(
        'Deal-breakers',
        dealBreakers,
        'A job mentioning any of these is ruled out entirely, not just ranked lower.'
      ),
      h('div', { style: 'display:flex;justify-content:flex-end;margin-top:1rem' }, save)
    )
  );
}

// --- account & security ----------------------------------------------------

async function openAccount() {
  const body = h('div', {});
  showModal('Account & security', body, { wide: true });
  await renderAccount(body);
}

async function renderAccount(container) {
  clear(container);
  const user = state.user;

  // Password
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const savePassword = h('button', { class: 'btn btn--primary', text: 'Change password' });
  savePassword.addEventListener(
    'click',
    busy(savePassword, 'Saving…', async () => {
      await api('/api/account/password', {
        method: 'POST',
        body: { currentPassword: current.value, newPassword: next.value },
      });
      current.value = '';
      next.value = '';
      toast('Password changed. Other sessions were signed out.');
    })
  );

  // MFA
  const mfaPanel = h('div', { class: 'panel' });
  const renderMfa = () => {
    clear(mfaPanel);
    mfaPanel.append(
      h('h3', { text: 'Two-factor authentication' }),
      h('p', {
        text: user.mfaEnabled
          ? `On. ${user.recoveryCodesRemaining} recovery codes left.`
          : 'Off. Adds a six-digit code from your authenticator app at sign-in.',
      })
    );

    if (!user.mfaEnabled) {
      const start = h('button', { class: 'btn btn--primary', text: 'Turn on two-factor' });
      // A missing server secret is the operator's problem to fix, so show what
      // is actually wrong instead of a generic failure toast that names nothing.
      const problem = h('div', { class: 'notice notice--warn', hidden: true });
      start.addEventListener(
        'click',
        busy(start, 'Preparing…', async () => {
          try {
            problem.hidden = true;
            await startMfaFlow(container);
          } catch (err) {
            problem.textContent = err.message;
            problem.hidden = false;
          }
        })
      );
      mfaPanel.append(problem, start);
      return;
    }

    const password = h('input', { class: 'input', type: 'password', placeholder: 'Your password' });
    const regen = h('button', { class: 'btn btn--ghost', text: 'New recovery codes' });
    regen.addEventListener(
      'click',
      busy(regen, 'Generating…', async () => {
        const { recoveryCodes } = await api('/api/account/recovery', {
          method: 'POST',
          body: { password: password.value },
        });
        password.value = '';
        showRecoveryCodes(recoveryCodes, container);
      })
    );
    const disable = h('button', { class: 'btn btn--danger', text: 'Turn off' });
    disable.addEventListener(
      'click',
      busy(disable, 'Turning off…', async () => {
        await api('/api/account/mfa/disable', { method: 'POST', body: { password: password.value } });
        password.value = '';
        state.user = { ...state.user, mfaEnabled: false, recoveryCodesRemaining: 0 };
        await renderAccount(container);
        toast('Two-factor turned off');
      })
    );
    mfaPanel.append(
      fieldRow('Confirm with your password', password),
      h('div', { style: 'display:flex;gap:.5rem' }, regen, disable)
    );
  };
  renderMfa();

  // Sessions
  const { sessions } = await api('/api/account/sessions');
  const sessionRows = h('div', { class: 'list-rows' });
  for (const item of sessions) {
    sessionRows.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: `dot${item.current ? ' dot--ok' : ''}` }),
        h(
          'div',
          { class: 'list-row__main' },
          h('span', {
            class: 'list-row__title',
            text: item.current ? 'This device' : item.ip || 'Unknown device',
          }),
          h('span', {
            class: 'list-row__sub',
            text: `${(item.userAgent || 'unknown').slice(0, 60)} · seen ${relativeTime(item.lastSeenAt)}`,
          })
        )
      )
    );
  }
  const revoke = h('button', { class: 'btn btn--ghost', text: 'Sign out everywhere else' });
  revoke.addEventListener(
    'click',
    busy(revoke, 'Signing out…', async () => {
      await api('/api/account/sessions/revoke', { method: 'POST', body: {} });
      await renderAccount(container);
      toast('Other sessions signed out');
    })
  );

  // Danger zone
  const delPassword = h('input', { class: 'input', type: 'password', placeholder: 'Your password' });
  const delConfirm = h('input', { class: 'input', placeholder: 'delete my account' });
  const del = h('button', { class: 'btn btn--danger', text: 'Delete account' });
  del.addEventListener(
    'click',
    busy(del, 'Deleting…', async () => {
      await api('/api/account/delete', {
        method: 'POST',
        body: { password: delPassword.value, confirm: delConfirm.value },
      });
      location.href = '/';
    })
  );

  container.append(
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Signed in as' }),
      h('p', { text: `${user.email}${user.emailVerified ? '' : ' — not confirmed yet'}` }),
      user.emailVerified
        ? null
        : h('button', {
            class: 'btn btn--ghost btn--sm',
            text: 'Resend confirmation',
            onclick: async () => {
              await api('/api/auth/verify/resend', { method: 'POST', body: {} });
              toast('Confirmation email sent');
            },
          })
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Password' }),
      h('p', { text: 'Changing it signs out every other device.' }),
      h('div', { class: 'row' }, fieldRow('Current password', current), fieldRow('New password', next, 'At least 12 characters.')),
      h('div', { style: 'display:flex;justify-content:flex-end' }, savePassword)
    ),
    mfaPanel,
    h('div', { class: 'panel' }, h('h3', { text: 'Active sessions' }), sessionRows, h('div', { style: 'margin-top:.75rem' }, revoke)),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Delete account' }),
      h('p', { text: 'Removes your account, boards, jobs, and alert history immediately. There is no undo.' }),
      h('div', { class: 'row' }, fieldRow('Password', delPassword), fieldRow('Type "delete my account"', delConfirm)),
      h('div', { style: 'display:flex;justify-content:flex-end' }, del)
    ),
    h(
      'div',
      { style: 'display:flex;justify-content:flex-end;margin-top:1rem' },
      h('button', {
        class: 'btn btn--ghost',
        text: 'Sign out',
        onclick: async () => {
          await api('/api/auth/logout', { method: 'POST', body: {} });
          location.reload();
        },
      })
    )
  );
}

async function startMfaFlow(accountContainer) {
  const { secret, qrSvg, uri } = await api('/api/account/mfa/start', { method: 'POST', body: {} });

  const code = h('input', {
    class: 'input input--code mono',
    inputmode: 'numeric',
    maxlength: '6',
    placeholder: '000000',
  });
  const confirm = h('button', { class: 'btn btn--primary btn--block', text: 'Confirm and turn on' });
  confirm.addEventListener(
    'click',
    busy(confirm, 'Verifying…', async () => {
      const { recoveryCodes } = await api('/api/account/mfa/confirm', {
        method: 'POST',
        body: { code: code.value.trim() },
      });
      state.user = { ...state.user, mfaEnabled: true, recoveryCodesRemaining: recoveryCodes.length };
      showRecoveryCodes(recoveryCodes, accountContainer);
    })
  );

  const body = h(
    'div',
    {},
    h('p', {
      class: 'muted',
      style: 'font-size:.9375rem;margin-bottom:1rem',
      text: qrSvg
        ? 'Scan this with Google Authenticator, 1Password, Authy, or any TOTP app.'
        : 'Enter this key in Google Authenticator, 1Password, Authy, or any TOTP app.',
    }),
    // Server-generated SVG from our own encoder - not user input. Absent only
    // when no shortening got the URI inside a scannable code, in which case
    // manual entry below is the whole flow rather than a fallback.
    qrSvg ? h('div', { class: 'qr', html: qrSvg }) : null,
    h('p', { class: 'label', text: qrSvg ? "Can't scan it? Enter this key" : 'Setup key' }),
    h('div', { class: 'secret', text: secret }),
    h('p', {
      class: 'hint',
      style: 'text-align:center',
      text: 'Type it exactly, ignoring spaces. Algorithm SHA1, 6 digits, 30 seconds.',
    }),
    h('div', { style: 'margin-top:1.5rem' }, h('p', { class: 'label', text: 'Enter the current code' }), code, h('div', { style: 'margin-top:.75rem' }, confirm))
  );
  void uri;
  showModal('Set up two-factor', body);
}

function showRecoveryCodes(codes, accountContainer) {
  const body = h(
    'div',
    {},
    h('div', { class: 'notice notice--warn', text: 'These are shown once. Save them somewhere safe — each one signs you in if you lose your phone.' }),
    h('div', { class: 'codes' }, ...codes.map((code) => h('code', { text: code }))),
    h(
      'div',
      { style: 'display:flex;gap:.5rem;justify-content:flex-end' },
      h('button', {
        class: 'btn btn--ghost',
        text: 'Copy all',
        onclick: async (event) => {
          try {
            await navigator.clipboard.writeText(codes.join('\n'));
            event.target.textContent = 'Copied';
          } catch {
            toast('Copy failed — select and copy them manually', 'error');
          }
        },
      }),
      h('button', {
        class: 'btn btn--primary',
        text: "I've saved them",
        onclick: async () => {
          closeModal();
          if (accountContainer) {
            await openAccount();
          }
        },
      })
    )
  );
  showModal('Recovery codes', body);
}

// ===========================================================================
// POLLING + WIRING
// ===========================================================================

/**
 * Near-live updates without holding a socket open: poll a cheap changes
 * endpoint that returns only rows touched since the last check, and patch them
 * into place. Pauses while the tab is hidden.
 */
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.hidden || !state.boardId || !state.lastSync) return;
    try {
      const params = new URLSearchParams({ boardId: state.boardId, since: state.lastSync });
      const { changed, now, lastRefresh } = await api(`/api/jobs/changes?${params}`);
      state.lastSync = now;

      if (state.board) {
        state.board.lastRefresh = lastRefresh;
        $('#board-stamp').textContent = lastRefresh ? `synced ${relativeTime(lastRefresh)}` : 'never synced';
      }
      if (changed.length === 0) return;

      let added = 0;
      for (const job of changed) {
        const index = state.jobs.findIndex((j) => j.id === job.id);
        if (index >= 0) state.jobs[index] = job;
        else {
          state.jobs.push(job);
          added++;
        }
      }
      state.jobs.sort((a, b) => b.score - a.score || (a.discoveredAt < b.discoveredAt ? 1 : -1));
      render();
      if (added > 0) toast(`${added} new job${added === 1 ? '' : 's'} landed`);
    } catch {
      // A failed poll is not worth interrupting the user over; the next tick
      // will pick it up.
    }
  }, 20000);
}

function wireApp() {
  $('#new-board').addEventListener('click', () => openBoardEditor());
  $('#board-settings').addEventListener('click', () => {
    const board = state.boards.find((b) => b.id === state.boardId);
    if (board) openBoardEditor(board);
  });
  $('#open-account').addEventListener('click', openAccount);

  $('#refresh').addEventListener('click', async (event) => {
    if (!state.boardId) return;
    await busy(event.target, 'Refreshing…', async () => {
      const { summary } = await api('/api/boards/refresh', {
        method: 'POST',
        body: { id: state.boardId },
      });
      await loadJobs();
      await loadBoards();
      const parts = [`${summary.added} new`];
      if (summary.updated) parts.push(`${summary.updated} updated`);
      if (summary.filteredOut) parts.push(`${summary.filteredOut} filtered out`);
      toast(parts.join(', '));

      // A refresh that found nothing used to pass as a toast that vanished in
      // three seconds, leaving no account of what happened or what it cost.
      // Say it plainly instead, with the numbers and the spend.
      if (summary.added === 0) {
        const spend =
          summary.modelCalls > 0
            ? `${summary.modelCalls} AI call used.`
            : 'No AI spend — nothing new to rank.';
        banner(
          `Nothing new. Checked ${summary.sourcesRun || 0} sources and read ${summary.fetched || 0} listings; ` +
            `${summary.filteredOut || 0} did not match this board's criteria. ${spend}`,
          'warn'
        );
      }
      if (summary.warnings && summary.warnings.length) banner(summary.warnings.join(' · '), 'warn');
    })(event);
  });

  $$('.segmented__btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      $$('.segmented__btn').forEach((other) => {
        const on = other === btn;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-selected', String(on));
      });
      render();
    })
  );

  let searchTimer;
  $('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.query = event.target.value.trim();
      await loadJobs();
    }, 280);
  });

  $('#min-score').addEventListener('input', (event) => {
    $('#min-score-out').textContent = event.target.value;
  });
  $('#min-score').addEventListener('change', async (event) => {
    state.minScore = Number(event.target.value);
    await loadJobs();
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-scrim').addEventListener('click', closeModal);
  $('#drawer-scrim').addEventListener('click', closeDrawer);

  $('#sidebar-open').addEventListener('click', () => $('#app').classList.add('sidebar-open'));
  $('#sidebar-close').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));
  $('#sidebar-scrim').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#modal').hidden) closeModal();
      else if (!$('#drawer').hidden) closeDrawer();
    }
    // "/" focuses search, the one shortcut worth having in a triage tool.
    if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      $('#search').focus();
    }
  });
}

// --- boot ------------------------------------------------------------------

async function boot() {
  wireAuth();
  wireApp();

  // Add the alerts entry point once the app chrome exists.
  $('.sidebar__section').append(
    h('button', { class: 'btn btn--ghost btn--sm btn--block', text: 'Profile', onclick: openProfile }),
    h('button', { class: 'btn btn--ghost btn--sm btn--block', text: 'Applications', onclick: openApplications }),
    h('button', { class: 'btn btn--ghost btn--sm btn--block', text: 'Insights', onclick: openInsights }),
    h('button', { class: 'btn btn--ghost btn--sm btn--block', text: 'Sources', onclick: openSources }),
    h('button', { class: 'btn btn--ghost btn--sm btn--block', text: 'Alerts', onclick: openAlerts })
  );

  const params = new URLSearchParams(location.search);

  if (location.pathname === '/reset' && params.get('token')) {
    showAuth('reset');
    return;
  }

  try {
    const { user } = await api('/api/auth/session');
    await enterApp(user);
    if (params.get('verified') === '1') toast('Email confirmed');
  } catch (err) {
    if (err.payload && err.payload.mfaRequired) {
      showAuth('mfa');
      return;
    }
    showAuth(params.get('mode') === 'signup' || location.pathname === '/signup' ? 'signup' : 'signin');
  }
}

boot();
