// Behaviour for the admin page.
//
// A file rather than an inline script, because the site sends
// script-src 'self' and inline execution is blocked outright - so none of this
// ran and every card and table sat on "Loading…" indefinitely. The page began
// as a standalone artifact, where inline was fine; under the app's policy it is
// not.
const fmt = (n) => Number(n || 0).toLocaleString();
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  function card(title, value, note, tone) {
    const el = document.createElement('div');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
    const v = document.createElement('div');
    v.style.cssText = 'font-family:var(--mono);font-size:1.9rem;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums';
    if (tone) v.style.color = tone;
    v.textContent = value;
    const p = document.createElement('p');
    p.textContent = note;
    el.append(h, v, p);
    return el;
  }

  (async () => {
    // Sub-cent amounts are the normal case here, and rounding them to $0.00
    // would make real spend look like none at all.
    const money = (n) => {
      const v = Number(n || 0);
      if (v === 0) return '$0';
      if (v < 0.01) return '<$0.01';
      return '$' + v.toFixed(2);
    };

    const cards = document.getElementById('stat-cards');
    const table = document.querySelector('#source-table tbody');
    try {
      const res = await fetch('/api/admin/stats');
      if (!res.ok) throw new Error('Stats unavailable (' + res.status + ')');
      const s = await res.json();

      cards.textContent = '';
      cards.append(
        card('Accounts', fmt(s.users.total),
          fmt(s.users.withBoards) + ' built a board · ' + fmt(s.users.verified) + ' verified · ' + fmt(s.users.with2fa) + ' using 2FA'),
        card('Boards', fmt(s.boards),
          'First signup ' + when(s.users.firstSignup) + ' · latest ' + when(s.users.latestSignup)),
        card('Jobs held', fmt(s.jobs.total),
          fmt(s.jobs.applied) + ' applied to · ' + fmt(s.jobs.modelRanked) + ' ranked by the model'),
        card('Leads found', fmt(s.leads), 'From scouting the open web'),
        card('AI spend today', money(s.modelToday.cost),
          fmt(s.modelToday.calls) + ' calls · ' + fmt(s.modelToday.scored) + ' jobs ranked · '
            + fmt(s.modelToday.inputTokens) + ' in / ' + fmt(s.modelToday.outputTokens) + ' out',
          s.modelToday.calls > 0 ? 'var(--spend)' : undefined),
        card('AI spend all time', money((s.modelAllTime || {}).cost),
          fmt((s.modelAllTime || {}).calls) + ' calls since launch · 30 per account per day',
          'var(--spend)')
      );

      const missing = Object.entries({
        'AI ranking': s.integrations.aiRanking,
        'Two-factor': s.integrations.twoFactor,
        'Email': s.integrations.email,
        'Adzuna': s.integrations.adzuna,
        'Cloudflare Access': s.integrations.cloudflareAccess,
      }).filter(([, on]) => !on).map(([name]) => name);

      cards.append(
        card('Integrations', String(5 - missing.length) + ' / 5',
          missing.length ? 'Not configured: ' + missing.join(', ') : 'All configured',
          missing.length ? 'var(--inert)' : 'var(--free)')
      );

      const cat = s.catalogue || { total: 0, unclassified: 0, byPlatform: [], byField: [] };
      const ready = cat.total - cat.unclassified;
      cards.append(
        card('Catalogue', fmt(cat.total),
          cat.unclassified > 0
            ? fmt(ready) + ' ready · ' + fmt(cat.unclassified) + ' still being classified'
            : fmt(ready) + ' ready · every board classified',
          cat.unclassified > 0 ? 'var(--spend)' : 'var(--free)')
      );

      const readiness = cat.readiness || {};
      const rcards = document.getElementById('readiness-cards');
      if (rcards) {
        const pct = (n) => (readiness.total ? Math.round((n / readiness.total) * 100) + '%' : '—');
        rcards.textContent = '';
        rcards.append(
          card('Employers catalogued', fmt(readiness.total), 'Company boards known to the service'),
          card('Classified', fmt(readiness.classified),
            pct(readiness.classified) + ' — the rest reach nobody until they have a field',
            readiness.classified < readiness.total ? 'var(--spend)' : 'var(--free)'),
          card('With a vocabulary', fmt(readiness.withVocabulary),
            pct(readiness.withVocabulary) + ' — needed to match a search to an employer',
            readiness.withVocabulary < readiness.total ? 'var(--spend)' : 'var(--free)'),
          card('Retired', fmt(readiness.retired),
            fmt(readiness.slow) + ' more are slow but still offered',
            readiness.retired > 0 ? 'var(--inert)' : 'var(--free)'),
          card('Last background pass', !cat.lastCron || cat.lastCron === 'never' ? 'Never' : new Date(cat.lastCron).toLocaleString(),
            cat.lastCron === 'never' ? 'The cron has not completed a tick' : 'Loads, classifies, then discovers',
            cat.lastCron === 'never' ? 'var(--inert)' : undefined)
        );
      }

      const bigBody = document.querySelector('#biggest-table tbody');
      if (bigBody) {
        bigBody.textContent = '';
        for (const row of cat.biggest || []) {
          const tr = document.createElement('tr');
          const name = document.createElement('td');
          name.className = 'name';
          name.textContent = row.identifier;
          const n = document.createElement('td');
          n.className = 'num';
          n.textContent = fmt(row.job_count);
          const state = document.createElement('td');
          const tag = document.createElement('span');
          if (row.failed_streak >= 3) {
            tag.className = 'tag tag--inert';
            tag.textContent = 'retired';
          } else if (row.timeout_streak > 0) {
            tag.className = 'tag tag--spend';
            tag.textContent = 'slow · offered last';
          } else {
            tag.className = 'tag tag--free';
            tag.textContent = 'in use';
          }
          state.append(tag);
          tr.append(name, n, state);
          bigBody.append(tr);
        }
      }

      const catBody = document.querySelector('#catalogue-table tbody');
      catBody.textContent = '';
      if (!cat.byPlatform.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = 'Catalogue is empty.';
        tr.append(td);
        catBody.append(tr);
      }
      for (const row of cat.byPlatform) {
        const tr = document.createElement('tr');
        for (const [value, cls] of [[row.kind, 'name'], [fmt(row.n), 'num'], [fmt(row.unclassified), 'num'], [fmt(row.retired), 'num']]) {
          const td = document.createElement('td');
          td.className = cls;
          td.textContent = value;
          tr.append(td);
        }
        catBody.append(tr);
      }

      table.textContent = '';
      if (!s.sources.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.textContent = 'No sources connected yet.';
        tr.append(td);
        table.append(tr);
      }
      for (const row of s.sources) {
        const tr = document.createElement('tr');
        const kind = document.createElement('td');
        kind.className = 'name';
        kind.textContent = row.kind;
        const n = document.createElement('td');
        n.className = 'num';
        n.textContent = fmt(row.n);
        const found = document.createElement('td');
        found.className = 'num';
        found.textContent = fmt(row.found);
        tr.append(kind, n, found);
        table.append(tr);
      }
    } catch (err) {
      cards.textContent = '';
      const el = document.createElement('div');
      el.className = 'card';
      const h = document.createElement('h3');
      h.textContent = 'Could not load stats';
      const p = document.createElement('p');
      p.textContent = err.message;
      el.append(h, p);
      cards.append(el);

      // Say so in every table as well.
      //
      // Only the cards were cleared, so a page that had failed went on showing
      // "Loading…" in three tables indefinitely - which reads as slow rather
      // than broken, and is the state this page sat in while its script was
      // being blocked outright.
      for (const id of ['#source-table', '#catalogue-table', '#biggest-table']) {
        const body = document.querySelector(id + ' tbody');
        if (!body) continue;
        const columns = document.querySelectorAll(id + ' thead th').length || 1;
        body.textContent = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns;
        td.textContent = 'Unavailable — ' + err.message;
        tr.append(td);
        body.append(tr);
      }

      const readinessHost = document.getElementById('readiness-cards');
      if (readinessHost) {
        readinessHost.textContent = '';
        const rc = document.createElement('div');
        rc.className = 'card';
        const rh = document.createElement('h3');
        rh.textContent = 'Unavailable';
        rc.append(rh);
        readinessHost.append(rc);
      }
    }
  })();

  // Operations: accounts, failures, feedback. A separate call from the counts,
  // because this one carries addresses and free text.
  (async () => {
    const ago = (iso) => {
      if (!iso) return 'never';
      const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
      if (!Number.isFinite(mins)) return '—';
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      if (mins < 1440) return Math.round(mins / 60) + 'h ago';
      return Math.round(mins / 1440) + 'd ago';
    };
    const fill = (id, columns, message) => {
      const body = document.querySelector(id + ' tbody');
      if (!body) return;
      body.textContent = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns;
      td.textContent = message;
      tr.append(td);
      body.append(tr);
    };
    const rowOf = (body, cells) => {
      const tr = document.createElement('tr');
      for (const [value, cls] of cells) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = value;
        tr.append(td);
      }
      body.append(tr);
    };

    const host = document.getElementById('ops-cards');
    try {
      const res = await fetch('/api/admin/operations');
      if (!res.ok) throw new Error('Operations unavailable (' + res.status + ')');
      const ops = await res.json();

      const errors24 = (ops.errorKinds || []).reduce((sum, k) => sum + (k.n || 0), 0);
      const withBoards = (ops.accounts || []).filter((a) => a.boards > 0).length;
      const openFeedback = (ops.feedback || []).filter((f) => f.status === 'new').length;
      const worst = (ops.errorKinds || [])[0];

      host.textContent = '';
      host.append(
        card('Accounts', fmt((ops.accounts || []).length), withBoards + ' have built a board'),
        card('Failures, 24h', fmt(errors24),
          worst ? 'Most common: ' + worst.kind : 'Nothing has failed',
          errors24 > 0 ? 'var(--spend)' : 'var(--free)'),
        card('Feedback', fmt((ops.feedback || []).length),
          openFeedback + ' not yet triaged',
          openFeedback > 0 ? 'var(--spend)' : undefined),
        card('Forwarding', ops.feedbackForwarding ? 'Notion' : 'Off',
          ops.feedbackForwarding ? 'Copied to Notion as well as stored here' : 'Stored here only — set NOTION_API_KEY and NOTION_DATABASE_ID',
          ops.feedbackForwarding ? 'var(--free)' : 'var(--inert)')
      );

      const accounts = document.querySelector('#accounts-table tbody');
      accounts.textContent = '';
      if (!(ops.accounts || []).length) fill('#accounts-table', 7, 'No accounts yet.');
      for (const a of ops.accounts || []) {
        rowOf(accounts, [
          [a.email || '—', 'name'],
          [fmt(a.boards), 'num'],
          [fmt(a.jobs), 'num'],
          [fmt(a.applied), 'num'],
          [fmt(a.calls), 'num'],
          [fmt(a.errors), 'num'],
          [ago(a.last_login_at || a.created_at), 'num'],
        ]);
      }

      const errors = document.querySelector('#errors-table tbody');
      errors.textContent = '';
      if (!(ops.errors || []).length) fill('#errors-table', 4, 'Nothing has failed.');
      for (const e of ops.errors || []) {
        rowOf(errors, [
          [ago(e.created_at), 'num'],
          [e.kind, 'name'],
          [e.email || '—', ''],
          [[e.message, e.context].filter(Boolean).join(' — '), ''],
        ]);
      }

      const feedback = document.querySelector('#feedback-table tbody');
      feedback.textContent = '';
      if (!(ops.feedback || []).length) fill('#feedback-table', 4, 'Nobody has reported anything yet.');
      for (const f of ops.feedback || []) {
        rowOf(feedback, [
          [ago(f.created_at), 'num'],
          [f.kind === 'bug' ? 'bug' : 'idea', 'name'],
          [f.email || '—', ''],
          [[f.subject, f.body].filter(Boolean).join(' — ').slice(0, 240) + (f.forward_error ? '  [not forwarded: ' + f.forward_error + ']' : ''), ''],
        ]);
      }
    } catch (err) {
      host.textContent = '';
      const el = document.createElement('div');
      el.className = 'card';
      const h = document.createElement('h3');
      h.textContent = 'Could not load operations';
      const p = document.createElement('p');
      p.textContent = err.message;
      el.append(h, p);
      host.append(el);
      fill('#accounts-table', 7, 'Unavailable — ' + err.message);
      fill('#errors-table', 4, 'Unavailable — ' + err.message);
      fill('#feedback-table', 4, 'Unavailable — ' + err.message);
    }
  })();
