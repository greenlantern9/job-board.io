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
