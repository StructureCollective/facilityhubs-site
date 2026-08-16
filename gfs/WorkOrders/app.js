/*
 * Work Orders front end.
 *
 * STATUS: this tool is UI-first. There is no live work-order backend yet --
 * work orders currently arrive by email in a handful of per-client formats,
 * and parsing those into the shared Apps Script backend (see config.js /
 * APP_CONFIG.apiUrl, same project as Dashboard/VendorSync/OfficeSync) is a
 * later phase once real email samples are available.
 *
 * For now this page renders a small set of SAMPLE_WORK_ORDERS (clearly
 * marked in the UI) and layers any local edits -- notes, assignment,
 * status/approval changes -- on top via localStorage, so the whole
 * interaction model (filter, open, assign, note, approve) is real and
 * clickable today. Swap loadWorkOrders_() to call the real API (matching
 * the apiGet_/apiPost_ pattern already used by the other three tools) once
 * a workOrdersBootstrap-style backend action exists.
 *
 * The one thing that IS live: the "Assigned to" list tries the existing
 * `dashboard` API action (same one Dashboard/ uses) to pull real team
 * members, falling back to placeholder names if that call fails or isn't
 * configured.
 */

(function () {
  const STORAGE_KEY = 'gfs_wo_overrides_v1';

  // Keep these in sync with the --client-* custom properties in style.css.
  const CLIENTS = [
    { key: 'riccobene', label: 'Riccobene', color: '#4a4dc9' },
    { key: 'lessen', label: 'Lessen', color: '#b5650a' },
    { key: 'superclean', label: 'SuperClean', color: '#0a7a52' },
    { key: 'servcon', label: 'Servcon', color: '#b32064' }
  ];

  const STATUSES = [
    { key: 'new', label: 'New' },
    { key: 'assigned', label: 'Assigned' },
    { key: 'in-progress', label: 'In Progress' },
    { key: 'completed', label: 'Completed' },
    { key: 'approved', label: 'Approved' }
  ];

  const FALLBACK_TEAM = [
    '[Team Member Name]',
    '[Team Member Name 2]',
    '[Team Member Name 3]'
  ];

  const state = {
    all: [],
    filtered: [],
    team: [],
    activeClients: new Set(),
    activeWoId: null
  };

  const $ = function (id) { return document.getElementById(id); };
  let searchTimer = null;

  document.addEventListener('DOMContentLoaded', function () {
    if (window.GFSIcons) GFSIcons.apply();

    $('versionBadge').textContent = 'Work Orders v ' + (APP_CONFIG.appVersion || '');
    $('supportButton').href = APP_CONFIG.supportUrl || '#';

    bindPlaceholderNav();
    renderClientChips();
    bindFilters();
    bindModal();

    loadTeam_();
    loadWorkOrders_();
  });

  /* ---------------- data loading ---------------- */

  function loadWorkOrders_() {
    setLoading(true, 'Loading work orders…');
    const overrides = readOverrides_();
    const base = sampleWorkOrders_();

    state.all = base.map(function (wo) {
      const o = overrides[wo.id] || {};
      return Object.assign({}, wo, {
        status: o.status || wo.status,
        assignedTo: o.assignedTo !== undefined ? o.assignedTo : wo.assignedTo,
        notes: o.notes || wo.notes || []
      });
    });

    state.filtered = state.all.slice();
    renderMetrics(state.all);
    applyFilters();
    setLoading(false);
  }

  function loadTeam_() {
    if (!APP_CONFIG.apiUrl || APP_CONFIG.apiUrl.indexOf('REPLACE_WITH') !== -1) {
      state.team = FALLBACK_TEAM;
      populateAssignedFilter();
      return;
    }

    apiGet_('dashboard')
      .then(function (d) {
        const names = (d && d.team || []).map(function (p) { return p.name; }).filter(Boolean);
        state.team = names.length ? names : FALLBACK_TEAM;
      })
      .catch(function () {
        state.team = FALLBACK_TEAM;
      })
      .then(populateAssignedFilter);
  }

  function apiGet_(action, params) {
    const url = new URL(APP_CONFIG.apiUrl);
    url.searchParams.set('action', action);
    url.searchParams.set('token', APP_CONFIG.apiToken || '');

    const authParam = window.GFSAuth ? GFSAuth.getAuthParam() : {};
    Object.keys(authParam).forEach(function (key) {
      url.searchParams.set(key, authParam[key]);
    });

    Object.keys(params || {}).forEach(function (key) {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.set(key, params[key]);
      }
    });

    return fetch(url.toString(), { method: 'GET' })
      .then(function (response) { return response.json(); })
      .then(unwrapApiResponse_);
  }

  function unwrapApiResponse_(result) {
    if (result && result.ok === false) {
      throw new Error(result.error || 'Request failed.');
    }
    return result && result.data !== undefined ? result.data : result;
  }

  /* ---------------- local overrides (notes / assign / status) ---------------- */

  function readOverrides_() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function writeOverride_(woId, patch) {
    const overrides = readOverrides_();
    const current = overrides[woId] || {};
    overrides[woId] = Object.assign({}, current, patch);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }

  /* ---------------- client filter chips ---------------- */

  function renderClientChips() {
    const wrap = $('clientFilter');
    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'client-chip active';
    allChip.dataset.client = '';
    allChip.style.setProperty('--chip-color', '#33415c');
    allChip.innerHTML = '<i></i> All clients';
    allChip.addEventListener('click', function () {
      state.activeClients.clear();
      refreshChipStates();
      applyFilters();
    });
    wrap.appendChild(allChip);

    CLIENTS.forEach(function (client) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'client-chip';
      chip.dataset.client = client.key;
      chip.style.setProperty('--chip-color', client.color);
      chip.innerHTML = '<i></i> ' + escapeHtml(client.label);
      chip.addEventListener('click', function () {
        if (state.activeClients.has(client.key)) {
          state.activeClients.delete(client.key);
        } else {
          state.activeClients.add(client.key);
        }
        refreshChipStates();
        applyFilters();
      });
      wrap.appendChild(chip);
    });
  }

  function refreshChipStates() {
    const wrap = $('clientFilter');
    const chips = wrap.querySelectorAll('.client-chip');
    chips.forEach(function (chip) {
      const key = chip.dataset.client;
      const isAllChip = key === '';
      const active = isAllChip ? state.activeClients.size === 0 : state.activeClients.has(key);
      chip.classList.toggle('active', active);
    });
  }

  /* ---------------- filters ---------------- */

  function bindFilters() {
    $('query').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 200);
    });
    $('status').addEventListener('change', applyFilters);
    $('priority').addEventListener('change', applyFilters);
    $('assignedFilter').addEventListener('change', applyFilters);
    $('clearButton').addEventListener('click', function () {
      $('query').value = '';
      $('status').value = '';
      $('priority').value = '';
      $('assignedFilter').value = '';
      state.activeClients.clear();
      refreshChipStates();
      applyFilters();
    });
  }

  function populateAssignedFilter() {
    const select = $('assignedFilter');
    state.team.forEach(function (name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  function applyFilters() {
    const query = $('query').value.trim().toLowerCase();
    const status = $('status').value;
    const priority = $('priority').value;
    const assignedTo = $('assignedFilter').value;

    state.filtered = state.all.filter(function (wo) {
      if (state.activeClients.size && !state.activeClients.has(wo.client)) return false;
      if (status && wo.status !== status) return false;
      if (priority && wo.priority !== priority) return false;
      if (assignedTo === '__unassigned' && wo.assignedTo) return false;
      if (assignedTo && assignedTo !== '__unassigned' && wo.assignedTo !== assignedTo) return false;

      if (query) {
        const haystack = (wo.number + ' ' + wo.title + ' ' + wo.site + ' ' + wo.description).toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }

      return true;
    });

    renderGrid();
  }

  /* ---------------- rendering ---------------- */

  function renderMetrics(all) {
    $('metricTotal').textContent = all.length;
    $('metricNew').textContent = all.filter(function (w) { return w.status === 'new'; }).length;
    $('metricProgress').textContent = all.filter(function (w) { return w.status === 'in-progress'; }).length;
    $('metricApproved').textContent = all.filter(function (w) { return w.status === 'approved'; }).length;
  }

  function renderGrid() {
    const grid = $('woGrid');
    const list = state.filtered.slice().sort(function (a, b) { return b.receivedAt - a.receivedAt; });

    $('resultCount').textContent = list.length + ' result' + (list.length === 1 ? '' : 's');
    $('emptyState').hidden = list.length > 0;

    grid.innerHTML = list.map(renderCard).join('');

    grid.querySelectorAll('[data-open-wo]').forEach(function (card) {
      card.addEventListener('click', function () {
        openWoModal(card.dataset.openWo);
      });
      card.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openWoModal(card.dataset.openWo);
        }
      });
    });
  }

  function renderCard(wo) {
    const client = clientByKey(wo.client);
    const initials = wo.assignedTo ? initialsOf(wo.assignedTo) : '—';

    return (
      '<article class="wo-card" tabindex="0" role="button" style="--client-color:' + client.color + '" data-open-wo="' + escapeHtml(wo.id) + '">' +
      '<div class="wo-card-top">' +
      '<span class="wo-number">' + escapeHtml(wo.number) + '</span>' +
      '<div class="wo-card-badges">' + statusBadge(wo.status) + priorityBadge(wo.priority) + '</div>' +
      '</div>' +
      '<span class="client-chip static" style="--chip-color:' + client.color + '"><i></i>' + escapeHtml(client.label) + '</span>' +
      '<h3>' + escapeHtml(wo.title) + '</h3>' +
      '<p class="wo-site">' + escapeHtml(wo.site) + '</p>' +
      '<p class="wo-description">' + escapeHtml(wo.description) + '</p>' +
      '<div class="wo-card-bottom">' +
      '<span class="wo-assignee"><span class="wo-avatar' + (wo.assignedTo ? '' : ' unassigned') + '">' + escapeHtml(initials) + '</span>' + escapeHtml(wo.assignedTo || 'Unassigned') + '</span>' +
      '<span class="wo-date">' + relativeDate(wo.receivedAt) + '</span>' +
      '</div>' +
      '</article>'
    );
  }

  function statusBadge(status) {
    const meta = STATUSES.find(function (s) { return s.key === status; }) || STATUSES[0];
    return '<span class="status-badge status-' + meta.key + '">' + escapeHtml(meta.label) + '</span>';
  }

  function priorityBadge(priority) {
    const label = priority === 'emergency' ? 'Emergency' : priority === 'urgent' ? 'Urgent' : 'Normal';
    return '<span class="priority-badge priority-' + escapeHtml(priority) + '">' + escapeHtml(label) + '</span>';
  }

  function clientByKey(key) {
    return CLIENTS.find(function (c) { return c.key === key; }) || { label: key, color: '#667085' };
  }

  function initialsOf(name) {
    return name.split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase();
  }

  function relativeDate(ts) {
    const diffMs = Date.now() - ts;
    const days = Math.floor(diffMs / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    const weeks = Math.floor(days / 7);
    if (weeks === 1) return '1 week ago';
    return weeks + ' weeks ago';
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* ---------------- detail modal ---------------- */

  function bindModal() {
    $('closeWoModal').addEventListener('click', closeWoModal);
    $('woModal').addEventListener('click', function (event) {
      if (event.target === $('woModal')) closeWoModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('woModal').hidden) closeWoModal();
    });

    $('woModalAssign').addEventListener('change', function () {
      const wo = findWo(state.activeWoId);
      if (!wo) return;
      const value = $('woModalAssign').value;
      wo.assignedTo = value || null;
      writeOverride_(wo.id, { assignedTo: wo.assignedTo });
      renderGrid();
    });

    $('woModal').querySelectorAll('[data-set-status]').forEach(function (button) {
      button.addEventListener('click', function () {
        setWoStatus(state.activeWoId, button.dataset.setStatus);
      });
    });

    $('noteForm').addEventListener('submit', function (event) {
      event.preventDefault();
      const wo = findWo(state.activeWoId);
      const text = $('noteText').value.trim();
      if (!wo || !text) return;

      const note = {
        text: text,
        author: (window.GFSAuth && GFSAuth.getSession() && decodeEmail_(GFSAuth.getSession().email)) || 'You',
        at: Date.now()
      };

      wo.notes = (wo.notes || []).concat([note]);
      writeOverride_(wo.id, { notes: wo.notes });
      $('noteText').value = '';
      renderNotes(wo);
    });
  }

  function decodeEmail_(email) {
    return email ? email.split('@')[0] : 'You';
  }

  function findWo(id) {
    return state.all.find(function (w) { return w.id === id; });
  }

  function openWoModal(id) {
    const wo = findWo(id);
    if (!wo) return;
    state.activeWoId = id;

    const client = clientByKey(wo.client);

    $('woModalClientChip').textContent = client.label;
    $('woModalClientChip').style.setProperty('--chip-color', client.color);
    $('woModalStatusBadge').outerHTML = statusBadge(wo.status).replace('class="status-badge', 'id="woModalStatusBadge" class="status-badge');
    $('woModalPriorityBadge').outerHTML = priorityBadge(wo.priority).replace('class="priority-badge', 'id="woModalPriorityBadge" class="priority-badge');

    $('woModalTitle').textContent = wo.title;
    $('woModalSite').textContent = wo.site;
    $('woModalDescription').textContent = wo.description;
    $('woModalReceived').textContent = formatDate(wo.receivedAt);
    $('woModalSource').textContent = wo.source;
    $('woModalNumber').textContent = wo.number;

    const assignSelect = $('woModalAssign');
    assignSelect.innerHTML = '<option value="">Unassigned</option>' +
      state.team.map(function (name) {
        return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
      }).join('');
    assignSelect.value = wo.assignedTo || '';

    updateStatusButtons(wo.status);
    renderNotes(wo);

    $('woModal').hidden = false;
    $('closeWoModal').focus();
  }

  function closeWoModal() {
    $('woModal').hidden = true;
    state.activeWoId = null;
  }

  function updateStatusButtons(status) {
    const buttons = $('woModal').querySelectorAll('[data-set-status]');
    buttons.forEach(function (button) {
      button.classList.toggle('is-active', button.dataset.setStatus === status);
    });

    const approveButton = $('approveButton');
    const canApprove = status === 'completed' || status === 'approved';
    approveButton.disabled = !canApprove;
    $('approveHint').hidden = canApprove;
  }

  function setWoStatus(id, status) {
    const wo = findWo(id);
    if (!wo) return;
    if (status === 'approved' && wo.status !== 'completed' && wo.status !== 'approved') return;

    wo.status = status;
    writeOverride_(id, { status: status });
    updateStatusButtons(status);
    renderMetrics(state.all);
    renderGrid();

    const statusEl = $('woModalStatusBadge');
    statusEl.outerHTML = statusBadge(status).replace('class="status-badge', 'id="woModalStatusBadge" class="status-badge');
  }

  function renderNotes(wo) {
    const list = $('notesList');
    const notes = (wo.notes || []).slice().sort(function (a, b) { return b.at - a.at; });

    if (!notes.length) {
      list.innerHTML = '<div class="notes-empty">No notes yet.</div>';
      return;
    }

    list.innerHTML = notes.map(function (note) {
      return (
        '<div class="note-item">' +
        '<div class="note-item-meta"><span>' + escapeHtml(note.author) + '</span><span>' + formatDate(note.at) + '</span></div>' +
        '<p>' + escapeHtml(note.text) + '</p>' +
        '</div>'
      );
    }).join('');
  }

  /* ---------------- placeholder nav (Reports, until it exists) ---------------- */

  function bindPlaceholderNav() {
    document.querySelectorAll('[data-url-key]').forEach(function (link) {
      const url = APP_CONFIG[link.dataset.urlKey];
      link.addEventListener('click', function (event) {
        event.preventDefault();
        if (!url) {
          alert('This destination has not been added yet.');
          return;
        }
        window.open(url, '_top');
      });
    });
  }

  function setLoading(show, message) {
    const loading = $('loading');
    loading.textContent = message || 'Loading work orders…';
    loading.hidden = !show;
    // Defensive re-apply: cheap and idempotent, guards against icons.js
    // finishing its own load slightly after the initial DOMContentLoaded pass.
    if (!show && window.GFSIcons) GFSIcons.apply();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
      return entities[character];
    });
  }

  /* ---------------- sample data ---------------- */

  function sampleWorkOrders_() {
    const day = 86400000;
    const now = Date.now();

    return [
      {
        id: 'wo-1042', number: 'WO-1042', client: 'riccobene',
        title: 'Reception aquarium filter not running',
        site: 'Riccobene Associates – Garner, NC',
        description: 'Front lobby aquarium filter pump has stopped running; water is starting to cloud. Needs service before it affects the fish.',
        priority: 'normal', status: 'new', assignedTo: null,
        receivedAt: now - 1 * day, source: 'workorders@riccobene.com', notes: []
      },
      {
        id: 'wo-1041', number: 'WO-1041', client: 'lessen',
        title: 'HVAC not cooling in break room',
        site: 'Lessen Portfolio – Store #204, Charlotte, NC',
        description: 'Break room unit is running but not cooling below 78°F. Staff reporting discomfort during shift.',
        priority: 'urgent', status: 'assigned', assignedTo: null,
        receivedAt: now - 1 * day - 4 * 3600000, source: 'dispatch@lessen.com', notes: []
      },
      {
        id: 'wo-1040', number: 'WO-1040', client: 'superclean',
        title: 'Deep clean requested after water leak',
        site: 'SuperClean HQ – Raleigh, NC',
        description: 'Ceiling leak in the hallway caused water damage to carpet tiles. Needs extraction and deep clean before mold risk sets in.',
        priority: 'emergency', status: 'in-progress', assignedTo: null,
        receivedAt: now - 2 * day, source: 'requests@superclean.com', notes: [
          { text: 'On site now, extracting water from carpet tiles in the east hallway.', author: 'GFS Dispatch', at: now - 1 * day - 3600000 }
        ]
      },
      {
        id: 'wo-1039', number: 'WO-1039', client: 'servcon',
        title: 'Parking lot light pole out',
        site: 'Servcon Client Site – Durham, NC',
        description: 'Light pole nearest the main entrance has been out for several nights. Tenants have raised a safety concern.',
        priority: 'normal', status: 'completed', assignedTo: null,
        receivedAt: now - 6 * day, source: 'workorders@servcon.com', notes: [
          { text: 'Replaced photocell sensor and bulb. Confirmed working after dark.', author: 'GFS Dispatch', at: now - 3 * day }
        ]
      },
      {
        id: 'wo-1038', number: 'WO-1038', client: 'riccobene',
        title: 'Broken window in waiting room',
        site: 'Riccobene Associates – Wake Forest, NC',
        description: 'Waiting room window cracked, likely from lawn equipment. Boarded temporarily; needs full glass replacement.',
        priority: 'urgent', status: 'approved', assignedTo: null,
        receivedAt: now - 9 * day, source: 'workorders@riccobene.com', notes: [
          { text: 'Glass vendor confirmed, replacement installed and inspected.', author: 'GFS Dispatch', at: now - 7 * day }
        ]
      },
      {
        id: 'wo-1037', number: 'WO-1037', client: 'lessen',
        title: 'Carpet stain removal – lobby',
        site: 'Lessen Portfolio – Store #118, Greensboro, NC',
        description: 'Large stain in front lobby carpet, likely coffee. Client asking for spot treatment ahead of a site visit next week.',
        priority: 'normal', status: 'new', assignedTo: null,
        receivedAt: now - 12 * 3600000, source: 'dispatch@lessen.com', notes: []
      },
      {
        id: 'wo-1036', number: 'WO-1036', client: 'superclean',
        title: 'Restroom plumbing leak under sink',
        site: 'SuperClean – Cary, NC',
        description: 'Slow leak under the restroom sink is pooling on the floor. Needs a plumber, not just cleanup.',
        priority: 'urgent', status: 'in-progress', assignedTo: null,
        receivedAt: now - 3 * day, source: 'requests@superclean.com', notes: []
      },
      {
        id: 'wo-1035', number: 'WO-1035', client: 'servcon',
        title: 'Exterior pressure washing',
        site: 'Servcon Client Site – Winston-Salem, NC',
        description: 'Annual exterior pressure washing for the storefront and walkways ahead of the client\'s spring inspection.',
        priority: 'normal', status: 'assigned', assignedTo: null,
        receivedAt: now - 4 * day, source: 'workorders@servcon.com', notes: []
      },
      {
        id: 'wo-1034', number: 'WO-1034', client: 'riccobene',
        title: 'Ceiling tile water stain – Exam Room 3',
        site: 'Riccobene Associates – Fuquay-Varina, NC',
        description: 'Brown water stain appeared on a ceiling tile above Exam Room 3. Needs roof/plumbing inspection and tile replacement.',
        priority: 'normal', status: 'completed', assignedTo: null,
        receivedAt: now - 8 * day, source: 'workorders@riccobene.com', notes: []
      },
      {
        id: 'wo-1033', number: 'WO-1033', client: 'lessen',
        title: 'Front door won\'t lock properly',
        site: 'Lessen Portfolio – Store #077, Fayetteville, NC',
        description: 'Main entrance door latch is not catching consistently. Store manager flagged as a security concern for closing.',
        priority: 'emergency', status: 'new', assignedTo: null,
        receivedAt: now - 5 * 3600000, source: 'dispatch@lessen.com', notes: []
      },
      {
        id: 'wo-1032', number: 'WO-1032', client: 'superclean',
        title: 'Monthly janitorial – additional trash pickup',
        site: 'SuperClean – Apex, NC',
        description: 'Client requested an additional weekly trash pickup added to the standing janitorial schedule.',
        priority: 'normal', status: 'approved', assignedTo: null,
        receivedAt: now - 14 * day, source: 'requests@superclean.com', notes: []
      },
      {
        id: 'wo-1031', number: 'WO-1031', client: 'servcon',
        title: 'Generator maintenance check',
        site: 'Servcon Client Site – High Point, NC',
        description: 'Routine quarterly maintenance check on the backup generator, per service contract.',
        priority: 'normal', status: 'in-progress', assignedTo: null,
        receivedAt: now - 2 * day - 6 * 3600000, source: 'workorders@servcon.com', notes: []
      }
    ];
  }
})();
