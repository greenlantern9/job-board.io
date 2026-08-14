// job-board.io client. Vanilla ES modules, no build step.
//
// Everything user-supplied reaches the DOM through textContent or via the `h`
// helper, never innerHTML - the one exception is the QR SVG, which the Worker
// generates from our own encoder.

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
  query: '',
  lastSync: null,
  pollTimer: null,
  mfaRecoveryMode: false,
};

const STATUSES = [
  { key: 'new', label: 'New', color: '#c3f53c' },
  { key: 'saved', label: 'Saved', color: '#9aa08a' },
  { key: 'applied', label: 'Applied', color: '#7fc8f5' },
  { key: 'interview', label: 'Interview', color: '#f0b44a' },
  { key: 'offer', label: 'Offer', color: '#86d97f' },
  { key: 'rejected', label: 'Rejected', color: '#f26d61' },
];

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
          // Address already registered - the server answers identically either
          // way, so say the neutral thing.
          authNotice('Check your inbox to continue.', 'ok');
          return;
        }
        await enterApp(result.user);
        toast('Account created. Check your email to confirm the address.');
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
  const { boards } = await api('/api/boards');
  state.boards = boards;

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
  $('#board-stamp').textContent = board.lastRefresh
    ? `synced ${relativeTime(board.lastRefresh)}`
    : 'never synced';

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
      text: 'A board holds the criteria you care about and the company job boards it pulls from. Most people start with one and add more later.',
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
    const meta = [job.company, job.remote ? 'Remote' : job.location, salaryText(job)]
      .filter(Boolean)
      .join(' · ');

    body.append(
      h(
        'tr',
        {
          class: job.status === 'archived' ? 'is-archived' : '',
          onclick: () => openDrawer(job.id),
        },
        h('td', {}, scoreNode(job)),
        h(
          'td',
          {},
          h('span', { class: 'job__title', text: job.title }),
          job.scoreReason ? h('span', { class: 'job__why', text: job.scoreReason }) : null
        ),
        h('td', { class: 'job__meta' }, meta || '—'),
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
                  href: job.url,
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

  empty.append(
    h('h3', { text: hasSources ? 'No jobs yet' : 'Add a source to start pulling jobs' }),
    h('p', {
      text: hasSources
        ? 'The sources on this board returned nothing that matched your filters. Loosen the filters, or add another company.'
        : 'Point this board at a company job board — Greenhouse, Lever, or Ashby — or paste a job RSS feed.',
    }),
    h('button', { class: 'btn btn--primary', text: 'Manage sources', onclick: openSources })
  );
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
      class: 'kcard',
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
      h('span', { class: 'kcard__title', text: job.title })
    ),
    h('span', {
      class: 'kcard__meta',
      text: [job.company, job.remote ? 'Remote' : job.location].filter(Boolean).join(' · ') || '—',
    }),
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
            href: job.url,
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

// --- board editor ----------------------------------------------------------

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
  const seniority = h(
    'select',
    { class: 'select' },
    ...[
      ['', 'Any level'],
      ['0', 'Internship'],
      ['1', 'Junior'],
      ['2', 'Mid'],
      ['3', 'Senior / Staff'],
      ['4', 'Principal'],
      ['5', 'Director+'],
    ].map(([value, label]) =>
      h('option', { value, selected: String(filters.seniority ?? '') === value }, label)
    )
  );
  const refreshEvery = h(
    'select',
    { class: 'select' },
    ...[
      [15, 'Every 15 minutes'],
      [30, 'Every 30 minutes'],
      [60, 'Hourly'],
      [180, 'Every 3 hours'],
      [720, 'Twice a day'],
      [1440, 'Daily'],
    ].map(([value, label]) =>
      h('option', { value: String(value), selected: (board ? board.refreshEvery : 60) === value }, label)
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
        },
      };
      const result = await api(board ? '/api/boards/update' : '/api/boards/create', {
        method: 'POST',
        body,
      });
      closeModal();
      if (!board && result.board) state.boardId = result.board.id;
      await loadBoards();
      toast(board ? 'Board saved' : 'Board created — now add a source');
      if (!board) openSources();
    })
  );

  const body = h(
    'div',
    {},
    fieldRow('Board name', name),
    fieldRow(
      'What are you looking for?',
      prompt,
      'Plain English works best. This is what the ranking reads — the more specific, the better it sorts.'
    ),
    h('div', { class: 'label', style: 'margin-top:1.5rem', text: 'Filters (applied before ranking)' }),
    h('div', { class: 'row' }, fieldRow('Must mention', keywords, 'Comma separated. Any one is enough.'), fieldRow('Rule out', exclude, 'Comma separated.')),
    h('div', { class: 'row' }, fieldRow('Locations', locations, 'Remote jobs always pass.'), fieldRow('Minimum salary', minSalary, 'Jobs with no published range are kept.')),
    h('div', { class: 'row' }, fieldRow('Seniority', seniority), fieldRow('Refresh', refreshEvery)),
    fieldRow('Refresh mode', refreshMode),
    h('label', { class: 'checkbox' }, remoteOnly, h('span', { text: 'Remote roles only' })),
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
  const { sources } = await api(`/api/sources?boardId=${encodeURIComponent(state.boardId)}`);

  const rows = h('div', { class: 'list-rows' });
  if (sources.length === 0) {
    rows.append(
      h('p', { class: 'muted', style: 'font-size:.875rem', text: 'No sources yet. Add one below.' })
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
          h('span', { class: 'list-row__title', text: source.label || source.identifier }),
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

  container.append(
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Connected sources' }),
      h('p', {
        text: 'Each source is a public company job board. Paused sources stay configured but stop pulling.',
      }),
      rows
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { text: 'Add a source' }),
      h('p', {
        text: 'For an ATS, use the company identifier from its careers URL — boards.greenhouse.io/stripe means "stripe".',
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
      start.addEventListener('click', busy(start, 'Preparing…', () => startMfaFlow(container)));
      mfaPanel.append(start);
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
      text: 'Scan this with Google Authenticator, 1Password, Authy, or any TOTP app.',
    }),
    // Server-generated SVG from our own encoder - not user input.
    h('div', { class: 'qr', html: qrSvg }),
    h('p', { class: 'label', text: "Can't scan it? Enter this key" }),
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
