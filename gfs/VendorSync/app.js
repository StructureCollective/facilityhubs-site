/*
 * VendorSync front end.
 *
 * This used to run inside Apps Script HtmlService and call the backend
 * with google.script.run(). Now that the page is served from GitHub
 * Pages, it talks to the same Apps Script project over HTTP instead,
 * using the Web App URL in config.js (APP_CONFIG.apiUrl).
 *
 * GET requests (bootstrap/search) are plain query-string requests --
 * these are "simple requests" so the browser does not preflight them.
 * The POST request (addVendor) intentionally uses
 * Content-Type: text/plain to also avoid a CORS preflight, since Apps
 * Script Web Apps do not support handling OPTIONS. See Code.gs.
 */

(function () {
  const state = {
    all: [],
    filtered: []
  };

  const $ = function (id) {
    return document.getElementById(id);
  };

  let searchTimer = null;

  document.addEventListener('DOMContentLoaded', function () {
    if (window.GFSIcons) GFSIcons.apply();

    if (!APP_CONFIG.apiUrl || APP_CONFIG.apiUrl.indexOf('REPLACE_WITH') !== -1) {
      showConfigWarning();
    }

    $('versionBadge').textContent = 'VendorSync v ' + (APP_CONFIG.appVersion || '');
    $('supportButton').href = APP_CONFIG.supportUrl || '#';

    bindNavigation();
    bindAddVendorModal();

    $('searchButton').addEventListener('click', runSearch);
    $('clearButton').addEventListener('click', clearSearch);

    $('query').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') runSearch();
    });

    $('query').addEventListener('input', scheduleSearch);
    $('trade').addEventListener('change', runSearch);
    $('state').addEventListener('change', runSearch);

    loadBootstrap();
  });

  function showConfigWarning() {
    setLoading(false);
    const grid = $('vendorGrid');
    grid.innerHTML =
      '<div class="empty-state" style="grid-column: 1 / -1;">' +
      'VendorSync is not connected to a data source yet. Update ' +
      '<code>apiUrl</code> in gfs/config.js with your Apps Script Web ' +
      'App URL, then reload.</div>';
    $('emptyState').hidden = true;
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

    return fetch(url.toString(), { method: 'GET' }).then(function (response) {
      return response.json();
    }).then(unwrapApiResponse_);
  }

  function apiPost_(action, payload) {
    const body = JSON.stringify(Object.assign({
      action: action,
      token: APP_CONFIG.apiToken || '',
      payload: payload
    }, (window.GFSAuth ? GFSAuth.getAuthParam() : {})));

    return fetch(APP_CONFIG.apiUrl, {
      method: 'POST',
      // text/plain avoids a CORS preflight; Code.gs parses this as JSON.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body
    }).then(function (response) {
      return response.json();
    }).then(unwrapApiResponse_);
  }

  function unwrapApiResponse_(result) {
    if (result && result.ok === false) {
      throw new Error(result.error || 'Request failed.');
    }
    return result && result.data !== undefined ? result.data : result;
  }

  function loadBootstrap() {
    if (!APP_CONFIG.apiUrl || APP_CONFIG.apiUrl.indexOf('REPLACE_WITH') !== -1) {
      return;
    }

    apiGet_('vendorsBootstrap')
      .then(initialize)
      .catch(showError);
  }

  function initialize(payload) {
    payload = payload || {};

    state.all = payload.vendors || [];
    state.filtered = state.all.slice();

    $('vendorCount').textContent =
      payload.totalVendors !== undefined ? payload.totalVendors : state.all.length;

    $('tradeCount').textContent =
      payload.totalTrades !== undefined ? payload.totalTrades : 0;

    populateSelect($('trade'), payload.trades || []);
    populateSelect($('state'), payload.states || []);

    renderVendors(state.filtered);
    setLoading(false);
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      runSearch();
    }, 300);
  }

  function populateSelect(select, values) {
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
    setLoading(true, 'Searching vendors…');

    const filters = {
      query: $('query').value,
      trade: $('trade').value,
      state: $('state').value
    };

    apiGet_('vendorsSearch', filters)
      .then(function (results) {
        state.filtered = results || [];
        renderFeatured(state.filtered, filters);
        renderVendors(state.filtered);
        setLoading(false);
      })
      .catch(showError);
  }

  function clearSearch() {
    $('query').value = '';
    $('trade').value = '';
    $('state').value = '';

    state.filtered = state.all.slice();
    $('matchSection').hidden = true;

    renderVendors(state.filtered);
    setLoading(false);
  }

  function renderFeatured(results, filters) {
    const hasFilter = filters.query || filters.trade || filters.state;

    if (!hasFilter || results.length === 0) {
      $('matchSection').hidden = true;
      return;
    }

    const vendor = results[0];

    $('matchSection').hidden = false;
    $('matchCount').textContent =
      results.length === 1 ? '1 result found' : results.length + ' results found';

    $('featuredMatch').innerHTML =
      '<article class="featured-card">' +
      '<div class="featured-name">' +
      '<strong>' + escapeHtml(vendor.vendor) + '</strong>' +
      tradePills(vendor.trade) +
      '</div>' +
      field('LOCATION', locationText(vendor)) +
      field('CONTACT', vendor.contact || '—') +
      field('POC', vendor.poc || '—') +
      field('RATING', stars(vendor.rating)) +
      phoneAction(vendor.contact, 'Call Vendor') +
      '</article>';
  }

  function renderVendors(vendors) {
    const resultText = vendors.length + ' result' + (vendors.length === 1 ? '' : 's');

    $('resultCount').textContent = resultText;
    $('emptyState').hidden = vendors.length > 0;

    $('vendorGrid').innerHTML = vendors.map(function (vendor) {
      return (
        '<article class="vendor-card">' +
        '<div class="vendor-summary">' +
        '<h3>' + escapeHtml(vendor.vendor) + '</h3>' +
        tradePills(vendor.trade) +
        '</div>' +
        '<div class="vendor-details">' +
        field('LOCATION', locationText(vendor)) +
        '<div><span class="field-label">CONTACT</span>' + phoneAction(vendor.contact) + '</div>' +
        '</div>' +
        '<div class="vendor-details">' +
        field('POC', vendor.poc || '—') +
        field('RATING', stars(vendor.rating), 'rating') +
        '</div>' +
        '</article>'
      );
    }).join('');
  }

  function locationText(vendor) {
    const parts = [];
    if (vendor.cityArea) parts.push(vendor.cityArea);
    if (vendor.state) parts.push(vendor.state);
    return parts.length ? parts.join(', ') : '—';
  }

  function field(label, value, className) {
    className = className || '';
    return (
      '<div class="' + escapeHtml(className) + '">' +
      '<span class="field-label">' + escapeHtml(label) + '</span>' +
      '<span>' + escapeHtml(String(value || '—')) + '</span>' +
      '</div>'
    );
  }

  function tradePills(trade) {
    const trades = String(trade || 'Uncategorized')
      .split(',')
      .map(function (value) { return value.trim(); })
      .filter(function (value) { return value !== ''; });

    return trades.map(function (value) {
      const normalized = value.toLowerCase();
      let colorClass = '';

      if (normalized.indexOf('carpet') !== -1 || normalized.indexOf('floor') !== -1) {
        colorClass = 'teal';
      } else if (
        normalized.indexOf('glass') !== -1 ||
        normalized.indexOf('window') !== -1 ||
        normalized.indexOf('aquarium') !== -1
      ) {
        colorClass = 'blue';
      }

      return '<span class="trade-pill ' + colorClass + '">' + escapeHtml(value) + '</span>';
    }).join(' ');
  }

  function phoneAction(phone, label) {
    if (!phone) return '<span>—</span>';

    const phoneText = String(phone);
    const phoneLink = phoneText.replace(/[^+\d]/g, '');

    return (
      '<a class="phone-button" href="tel:' + escapeHtml(phoneLink) + '">' +
      '☎ &nbsp;' + escapeHtml(label || phoneText) + '</a>'
    );
  }

  function stars(rating) {
    let count = Number(rating) || 0;
    count = Math.max(0, Math.min(5, Math.round(count)));
    if (!count) return '—';
    return '★'.repeat(count) + '☆'.repeat(5 - count);
  }

  function bindNavigation() {
    const links = document.querySelectorAll('[data-url-key]');

    links.forEach(function (link) {
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

  function bindAddVendorModal() {
    const modal = $('addVendorModal');
    const form = $('addVendorForm');
    const errorBox = $('addVendorError');

    $('addVendorButton').addEventListener('click', function () {
      errorBox.hidden = true;
      form.reset();
      modal.hidden = false;
      $('fieldVendor').focus();
    });

    $('cancelAddVendor').addEventListener('click', function () {
      modal.hidden = true;
    });

    modal.addEventListener('click', function (event) {
      if (event.target === modal) modal.hidden = true;
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      errorBox.hidden = true;

      const vendor = {
        vendor: $('fieldVendor').value.trim(),
        trade: $('fieldTrade').value.trim(),
        poc: $('fieldPoc').value.trim(),
        contact: $('fieldContact').value.trim(),
        cityArea: $('fieldCityArea').value.trim(),
        state: $('fieldState').value.trim(),
        rating: $('fieldRating').value
      };

      if (!vendor.vendor) {
        errorBox.textContent = 'Vendor name is required.';
        errorBox.hidden = false;
        return;
      }

      const submitButton = $('submitAddVendor');
      submitButton.disabled = true;
      submitButton.textContent = 'Saving…';

      apiPost_('addVendor', vendor)
        .then(function () {
          modal.hidden = true;
          return loadBootstrapAndRefresh_();
        })
        .catch(function (error) {
          errorBox.textContent = error && error.message ? error.message : 'Could not save this vendor.';
          errorBox.hidden = false;
        })
        .finally(function () {
          submitButton.disabled = false;
          submitButton.textContent = 'Save vendor';
        });
    });
  }

  function loadBootstrapAndRefresh_() {
    setLoading(true, 'Refreshing vendors…');
    return apiGet_('vendorsBootstrap').then(initialize).catch(showError);
  }

  function setLoading(show, message) {
    const loading = $('loading');
    loading.textContent = message || 'Loading vendors…';
    loading.hidden = !show;
  }

  function showError(error) {
    setLoading(false);
    const message = error && error.message ? error.message : String(error || 'An unknown error occurred.');
    console.error(message);
    alert('VendorSync could not load the vendor directory.\n\n' + message);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
      return entities[character];
    });
  }
})();
