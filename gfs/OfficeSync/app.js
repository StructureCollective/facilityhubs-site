/*
 * OfficeSync front end. Same fetch()-based API pattern as VendorSync's
 * app.js -- see that file's header comment for why GET uses query
 * params and POST (not used here) would use text/plain.
 */

(function () {
  const dataState = { all: [], filtered: [] };
  const $ = function (id) { return document.getElementById(id); };
  let timer = null;

  const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_NAMES = {
    Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
    Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday'
  };
  const DAY_TOKEN = '(Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const EVERY_OTHER_RE = new RegExp('^Every Other ' + DAY_TOKEN + '\\s+(.*)$', 'i');
  const RANGE_RE = new RegExp('^' + DAY_TOKEN + '\\s*-\\s*' + DAY_TOKEN + '\\s+(.*)$', 'i');
  const SINGLE_RE = new RegExp('^' + DAY_TOKEN + '\\s+(.*)$', 'i');

  document.addEventListener('DOMContentLoaded', function () {
    if (window.GFSIcons) GFSIcons.apply();

    if (!APP_CONFIG.apiUrl || APP_CONFIG.apiUrl.indexOf('REPLACE_WITH') !== -1) {
      showConfigWarning();
      return;
    }

    $('versionBadge').textContent = 'OfficeSync v ' + (APP_CONFIG.appVersion || '');
    $('supportButton').href = APP_CONFIG.supportUrl || '#';

    bindPlaceholderNav();

    $('searchButton').addEventListener('click', runSearch);
    $('clearButton').addEventListener('click', clearSearch);
    $('query').addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 250);
    });
    $('query').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runSearch();
    });
    $('state').addEventListener('change', runSearch);
    $('city').addEventListener('change', runSearch);

    $('officeGrid').addEventListener('click', handleGridClick_);
    document.addEventListener('click', closeOtherHoursPanels_);

    apiGet_('officesBootstrap').then(initialize).catch(showError);
  });

  function showConfigWarning() {
    $('loading').hidden = true;
    $('officeGrid').innerHTML =
      '<div class="empty-state" style="grid-column: 1 / -1;">' +
      'OfficeSync is not connected to a data source yet. Update ' +
      '<code>apiUrl</code> in gfs/config.js with your Apps Script Web ' +
      'App URL, then reload.</div>';
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

  function initialize(payload) {
    payload = payload || {};

    dataState.all = payload.offices || [];
    dataState.filtered = dataState.all.slice();

    $('officeCount').textContent = payload.totalOffices || 0;
    $('stateCount').textContent = (payload.states || []).length;

    fillSelect($('state'), payload.states || []);
    fillSelect($('city'), payload.cities || []);

    render(dataState.filtered);
    setLoading(false);
  }

  function fillSelect(select, values) {
    while (select.options.length > 1) {
      select.remove(1);
    }
    values.forEach(function (value) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  }

  function runSearch() {
    setLoading(true, 'Searching offices…');

    const filters = { query: $('query').value, state: $('state').value, city: $('city').value };

    apiGet_('officesSearch', filters)
      .then(function (results) {
        dataState.filtered = results || [];
        render(dataState.filtered);
        setLoading(false);
      })
      .catch(showError);
  }

  function clearSearch() {
    $('query').value = '';
    $('state').value = '';
    $('city').value = '';
    dataState.filtered = dataState.all.slice();
    render(dataState.filtered);
    setLoading(false);
  }

  function render(offices) {
    offices = offices || [];

    $('resultCount').textContent = offices.length + ' result' + (offices.length === 1 ? '' : 's');
    $('emptyState').hidden = offices.length > 0;

    $('officeGrid').innerHTML = offices.map(function (office, index) {
      const uid = office.rowNumber != null ? office.rowNumber : index;
      return (
        '<article class="office-card">' +
        '<div class="office-summary">' +
        '<h3>' + esc(office.nickname || 'Unnamed Office') + '</h3>' +
        statePill(office.state) +
        '</div>' +
        '<div class="address-field">' +
        '<b>ADDRESS</b>' +
        '<span>' + esc(office.streetAddress || '—') + '<br>' +
        esc([[office.city, office.state].filter(Boolean).join(', '), office.zipCode].filter(Boolean).join(' ')) +
        '</span>' +
        '</div>' +
        '<div class="contact-field">' +
        '<b>PHONE</b>' +
        phoneMarkup(office.phone) +
        hoursMarkup(office.officeHours, uid) +
        '</div>' +
        '<div class="office-action">' +
        copyButtonMarkup(office) +
        '</div>' +
        '</article>'
      );
    }).join('');
  }

  function statePill(state) {
    const stateCode = String(state || 'Unknown').trim().toUpperCase();
    const stateClasses = {
      NC: 'state-nc', VA: 'state-va', SC: 'state-sc', GA: 'state-ga',
      FL: 'state-fl', AL: 'state-al', TN: 'state-tn', MD: 'state-md',
      DC: 'state-dc', WV: 'state-wv'
    };
    const colorClass = stateClasses[stateCode] || 'state-default';
    return '<span class="office-pill ' + colorClass + '">' + esc(stateCode) + '</span>';
  }

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

  function setLoading(show, text) {
    const loading = $('loading');
    loading.textContent = text || 'Loading offices…';
    loading.hidden = !show;
    // Defensive re-apply: cheap and idempotent, guards against icons.js
    // finishing its own load slightly after the initial DOMContentLoaded pass.
    if (!show && window.GFSIcons) GFSIcons.apply();
  }

  function showError(error) {
    setLoading(false);
    const message = error && error.message ? error.message : String(error || 'An unknown error occurred.');
    console.error(message);
    alert('OfficeSync could not load the office directory.\n\n' + message);
  }

  function esc(value) {
    return String(value).replace(/[&<>'"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c];
    });
  }

  function phoneMarkup(phone) {
    if (!phone) return '<span>—</span>';
    const clean = String(phone).replace(/[^0-9+]/g, '');
    return (
      '<a class="phone-link" href="tel:' + esc(clean) + '">' +
      '<span class="phone-icon" data-icon="phone"></span>' +
      '<span>' + esc(phone) + '</span>' +
      '</a>'
    );
  }

  /* ---------------------- Office hours (Google-style dropdown) ---------------------- */

  function titleCaseDay_(token) {
    const s = String(token).slice(0, 3);
    return s.charAt(0).toUpperCase() + s.slice(1, 3).toLowerCase();
  }

  function expandDayRange_(start, end) {
    const startIdx = DAY_ORDER.indexOf(start);
    const endIdx = DAY_ORDER.indexOf(end);
    if (startIdx === -1 || endIdx === -1) return [start];
    const days = [];
    let i = startIdx;
    while (true) {
      days.push(DAY_ORDER[i]);
      if (i === endIdx) break;
      i = (i + 1) % DAY_ORDER.length;
      if (days.length > 7) break;
    }
    return days;
  }

  function parseOfficeHours_(raw) {
    const result = { days: {}, extras: [], notes: [], practiceNote: null };
    DAY_ORDER.forEach(function (day) { result.days[day] = null; });

    if (!raw || !String(raw).trim()) {
      result.notes.push('Hours not listed.');
      return result;
    }

    let text = String(raw).trim();

    const noteMatch = text.match(/\s*\(([^)]+)\)\s*$/);
    if (noteMatch) {
      result.practiceNote = noteMatch[1].trim();
      text = text.slice(0, noteMatch.index).trim();
    }

    text.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (segment) {
      let m = segment.match(EVERY_OTHER_RE);
      if (m) {
        const day = titleCaseDay_(m[1]);
        result.extras.push({ label: 'Every other ' + DAY_NAMES[day], hours: m[2].trim() });
        return;
      }

      m = segment.match(RANGE_RE);
      if (m) {
        const hours = m[3].trim();
        expandDayRange_(titleCaseDay_(m[1]), titleCaseDay_(m[2])).forEach(function (day) {
          result.days[day] = hours;
        });
        return;
      }

      m = segment.match(SINGLE_RE);
      if (m) {
        result.days[titleCaseDay_(m[1])] = m[2].trim();
        return;
      }

      result.notes.push(segment);
    });

    return result;
  }

  function parseClock_(str) {
    const m = String(str).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
    if (!m) return null;
    let hour = parseInt(m[1], 10) % 12;
    const minutes = m[2] ? parseInt(m[2], 10) : 0;
    if (/pm/i.test(m[3])) hour += 12;
    return hour * 60 + minutes;
  }

  function formatMinutes_(total) {
    let hour = Math.floor(total / 60);
    const minutes = total % 60;
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    if (hour === 0) hour = 12;
    return hour + (minutes ? ':' + String(minutes).padStart(2, '0') : '') + ' ' + suffix;
  }

  function hoursStatus_(hoursText) {
    if (!hoursText || /^closed$/i.test(hoursText.trim())) {
      return { open: false, label: 'Closed today' };
    }
    const m = hoursText.match(/(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])\s*-\s*(\d{1,2}(?::\d{2})?\s*[AaPp][Mm])/);
    if (!m) return { open: null, label: hoursText };

    const open = parseClock_(m[1]);
    const close = parseClock_(m[2]);
    if (open == null || close == null) return { open: null, label: hoursText };

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (nowMinutes >= open && nowMinutes < close) {
      return { open: true, label: 'Open now · Closes ' + formatMinutes_(close) };
    }
    if (nowMinutes < open) {
      return { open: false, label: 'Closed · Opens ' + formatMinutes_(open) };
    }
    return { open: false, label: 'Closed now' };
  }

  function getTodayKey_() {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  }

  function hoursMarkup(rawHours, uid) {
    const parsed = parseOfficeHours_(rawHours);
    const todayKey = getTodayKey_();
    const status = hoursStatus_(parsed.days[todayKey]);
    const statusClass = status.open === true ? 'is-open' : status.open === false ? 'is-closed' : '';

    const rows = DAY_ORDER.map(function (day) {
      const isToday = day === todayKey;
      const text = parsed.days[day] == null ? 'Closed' : parsed.days[day];
      return (
        '<tr class="' + (isToday ? 'is-today' : '') + '">' +
        '<td>' + DAY_NAMES[day] + '</td>' +
        '<td>' + esc(text) + '</td>' +
        '</tr>'
      );
    }).join('');

    const extraRows = parsed.extras.map(function (extra) {
      return (
        '<tr class="is-extra">' +
        '<td>' + esc(extra.label) + '</td>' +
        '<td>' + esc(extra.hours) + '</td>' +
        '</tr>'
      );
    }).join('');

    const noteLines = parsed.notes.map(function (note) {
      return '<p class="hours-note">' + esc(note) + '</p>';
    }).join('');

    const practiceNote = parsed.practiceNote
      ? '<p class="hours-note">Operates as ' + esc(parsed.practiceNote) + '</p>'
      : '';

    return (
      '<div class="hours-field">' +
      '<button type="button" class="hours-toggle" aria-expanded="false" aria-controls="hoursPanel' + uid + '">' +
      '<span class="hours-label">OFFICE HOURS</span>' +
      '<span class="hours-status ' + statusClass + '">' + esc(status.label) + '</span>' +
      '<span class="chevron" data-icon="chevronDown"></span>' +
      '</button>' +
      '<div class="hours-panel" id="hoursPanel' + uid + '" hidden>' +
      '<table class="hours-table">' + rows + extraRows + '</table>' +
      noteLines + practiceNote +
      '</div>' +
      '</div>'
    );
  }

  function handleGridClick_(event) {
    const toggleBtn = event.target.closest('.hours-toggle');
    if (toggleBtn) {
      const panel = document.getElementById(toggleBtn.getAttribute('aria-controls'));
      const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', String(!expanded));
      if (panel) panel.hidden = expanded;
      return;
    }

    const copyBtn = event.target.closest('.copy-button');
    if (copyBtn) {
      copyAddress_(copyBtn);
    }
  }

  function closeOtherHoursPanels_(event) {
    document.querySelectorAll('.hours-toggle[aria-expanded="true"]').forEach(function (btn) {
      if (!btn.parentElement.contains(event.target)) {
        btn.setAttribute('aria-expanded', 'false');
        const panel = document.getElementById(btn.getAttribute('aria-controls'));
        if (panel) panel.hidden = true;
      }
    });
  }

  /* ---------------------- Copy address ---------------------- */

  function copyButtonMarkup(office) {
    const fullAddress = [
      office.streetAddress,
      [office.city, office.state].filter(Boolean).join(', '),
      office.zipCode
    ].filter(Boolean).join(', ');

    return (
      '<button type="button" class="copy-button" data-address="' + esc(fullAddress) + '">' +
      '<span class="copy-icon" data-icon="copy"></span>' +
      '<span class="copy-label">Copy Address</span>' +
      '</button>'
    );
  }

  function legacyCopy_(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); } catch (e) { /* no-op */ }
    document.body.removeChild(textarea);
  }

  function copyAddress_(button) {
    const address = button.getAttribute('data-address') || '';

    const markCopied = function () {
      button.classList.add('is-copied');
      const icon = button.querySelector('.copy-icon');
      icon.setAttribute('data-icon', 'check');
      if (window.GFSIcons) GFSIcons.apply(button);
      button.querySelector('.copy-label').textContent = 'Copied!';

      clearTimeout(button._copyTimer);
      button._copyTimer = setTimeout(function () {
        button.classList.remove('is-copied');
        icon.setAttribute('data-icon', 'copy');
        if (window.GFSIcons) GFSIcons.apply(button);
        button.querySelector('.copy-label').textContent = 'Copy Address';
      }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(address).then(markCopied).catch(function () {
        legacyCopy_(address);
        markCopied();
      });
    } else {
      legacyCopy_(address);
      markCopied();
    }
  }
})();
