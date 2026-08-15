/*
 * Dashboard front end. Same fetch()-based API pattern as VendorSync's
 * app.js -- see that file's header comment for details.
 */

(function () {
  const $ = function (id) { return document.getElementById(id); };
  const colors = ['#102f73', '#0aa39a', '#1677d2', '#7656e8', '#e3ad22', '#e45472'];

  document.addEventListener('DOMContentLoaded', function () {
    if (!APP_CONFIG.apiUrl || APP_CONFIG.apiUrl.indexOf('REPLACE_WITH') !== -1) {
      $('loading').textContent =
        'Dashboard is not connected to a data source yet. Update apiUrl in gfs/config.js.';
      return;
    }

    bindPlaceholderNav();

    apiGet_('dashboard').then(renderDashboard).catch(showError);
  });

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

  function renderDashboard(d) {
    $('vendorTotal').textContent = d.totalVendors;
    $('tradeTotal').textContent = d.totalTrades;
    $('stateTotal').textContent = d.totalStates;
    $('officeTotal').textContent = d.totalOffices;
    $('donutTotal').textContent = d.totalVendors;
    renderBars(d);
    renderDonut(d);
    renderTopTrades(d);
    renderTeam(d.team);
    $('loading').hidden = true;
  }

  function renderBars(d) {
    const max = Math.max(1, ...d.topTrades.map(function (t) { return d.tradeTotals[t] || 0; }));

    $('tradeChart').innerHTML = d.topTrades.map(function (trade) {
      const parts = d.states.map(function (state, i) {
        const count = (d.stateTradeCounts[state] || {})[trade] || 0;
        return '<span title="' + esc(state) + ': ' + count + '" style="width:' +
          (count / max * 100) + '%;background:' + colors[i % colors.length] + '"></span>';
      }).join('');

      return '<div class="bar-row"><label>' + esc(trade) + '</label><div class="bar">' +
        parts + '</div><b>' + d.tradeTotals[trade] + '</b></div>';
    }).join('');

    $('legend').innerHTML = d.states.map(function (s, i) {
      return '<span><i style="background:' + colors[i % colors.length] + '"></i>' + esc(s) + '</span>';
    }).join('');
  }

  function renderDonut(d) {
    let cursor = 0;
    const stops = d.states.map(function (s, i) {
      const pct = d.totalVendors ? (d.stateTotals[s] || 0) / d.totalVendors * 100 : 0;
      const stop = colors[i % colors.length] + ' ' + cursor + '% ' + (cursor + pct) + '%';
      cursor += pct;
      return stop;
    });

    $('donut').style.background = 'conic-gradient(' + stops.join(',') + ')';

    $('stateLegend').innerHTML = d.states.map(function (s, i) {
      return '<p><i style="background:' + colors[i % colors.length] + '"></i>' + esc(s) +
        ' <b>' + (d.stateTotals[s] || 0) + '</b></p>';
    }).join('');
  }

  function renderTopTrades(d) {
    const top = d.topTrades.slice(0, 5);
    const max = Math.max(1, ...top.map(function (t) { return d.tradeTotals[t]; }));

    $('topTrades').innerHTML = top.map(function (t, i) {
      return '<div class="progress"><span>' + esc(t) + ' <b>' + d.tradeTotals[t] + '</b></span>' +
        '<i><em style="width:' + (d.tradeTotals[t] / max * 100) + '%;background:' +
        colors[i % colors.length] + '"></em></i></div>';
    }).join('');
  }

  function renderTeam(team) {
    $('teamList').innerHTML = (team || []).map(function (p) {
      return '<a class="person" href="mailto:' + esc(p.email) + '"><i>&#9679;</i><strong>' +
        esc(p.name) + '</strong><span>' + esc(p.role) + '</span><em>&#9993; ' + esc(p.email) + '</em></a>';
    }).join('');
  }

  function showError(e) {
    $('loading').hidden = true;
    alert(e && e.message ? e.message : String(e));
  }

  function esc(v) {
    return String(v).replace(/[&<>'"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c];
    });
  }
})();
