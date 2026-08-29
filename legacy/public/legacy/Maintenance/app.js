/*
 * Tenant maintenance requests page -- TEMPORARY no-auth mode (see
 * src/index.js header). Which tenant to show comes from ?tenant_id=N.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };
  let tenantId = null;

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  function esc(v) {
    return String(v).replace(/[&<>'"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c];
    });
  }

  function fmtAddress(label) {
    if (!label) return '';
    var idx = label.indexOf(',');
    if (idx === -1) return esc(label);
    return esc(label.slice(0, idx).trim()) + '<br>' + esc(label.slice(idx + 1).trim());
  }

  document.addEventListener('DOMContentLoaded', function () {
    tenantId = new URLSearchParams(location.search).get('tenant_id');
    if (!tenantId) {
      $('loadingMsg').innerHTML = 'No tenant selected. <a href="../Dashboard/">Go to Dashboard</a> to pick one.';
      return;
    }

    fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('loadingMsg').textContent = 'Tenant not found.';
          return;
        }
        $('greeting').textContent = 'Hi, ' + (res.data.tenant.fullName ? res.data.tenant.fullName.split(' ')[0] : 'there');
        $('unitLabel').innerHTML = fmtAddress(res.data.tenant.unitLabel);
        $('loadingMsg').hidden = true;
        $('app').hidden = false;
        return loadRequests();
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load this page. Please reload.';
      });

    $('submitBtn').addEventListener('click', function () {
      const description = $('description').value.trim();
      if (!description) {
        $('submitStatus').textContent = 'Please describe the issue first.';
        return;
      }
      $('submitBtn').disabled = true;
      $('submitStatus').textContent = 'Submitting…';
      fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId) + '/maintenance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: description }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          $('submitBtn').disabled = false;
          if (!res.ok) {
            $('submitStatus').textContent = res.data.error || 'Could not submit request.';
            return;
          }
          $('description').value = '';
          $('submitStatus').textContent = 'Request submitted.';
          loadRequests();
        })
        .catch(function () {
          $('submitBtn').disabled = false;
          $('submitStatus').textContent = 'Something went wrong. Please try again.';
        });
    });
  });

  function loadRequests() {
    return fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId) + '/maintenance')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderRequests(data.requests || []); })
      .catch(function () {
        $('requestBody').innerHTML = '<tr><td colspan="3">Could not load requests.</td></tr>';
      });
  }

  function renderRequests(requests) {
    if (!requests.length) {
      $('requestBody').innerHTML = '<tr><td colspan="3">No requests yet.</td></tr>';
      return;
    }
    $('requestBody').innerHTML = requests.map(function (r) {
      return '<tr><td>' + esc(r.description) + '</td><td><span class="pill ' + esc(r.status) + '">' +
        esc(r.status) + '</span></td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }).join('');
  }
})();
