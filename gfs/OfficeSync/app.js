/*
 * OfficeSync front end. Same fetch()-based API pattern as VendorSync's
 * app.js -- see that file's header comment for why GET uses query
 * params and POST (not used here) would use text/plain.
 */

(function () {
  const dataState = { all: [], filtered: [] };
  const $ = function (id) { return document.getElementById(id); };
  let timer = null;

  document.addEventListener('DOMContentLoaded', function () {
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

    $('officeGrid').innerHTML = offices.map(function (office) {
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
        '<div class="office-action">' +
        '<a class="map-button" href="' + esc(office.mapUrl || '#') + '" target="_blank" rel="noopener noreferrer">' +
        '&#8982; &nbsp; View Location</a>' +
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
})();
