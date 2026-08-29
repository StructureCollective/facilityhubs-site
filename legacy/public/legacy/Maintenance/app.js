/*
 * Tenant maintenance requests page. Tenant identity comes from the
 * signed-in session (GET /legacy/api/tenants/me) rather than ?tenant_id=.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  // For issue_started_on -- a plain YYYY-MM-DD label (no time component),
  // so it's parsed/displayed as UTC to avoid shifting a day depending on
  // the viewer's timezone.
  function fmtDateOnly(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
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

  function signOut(e) {
    if (e) e.preventDefault();
    fetch('/legacy/api/auth/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { location.href = '/legacy/'; });
  }

  // Shown only when an admin is viewing this page through Admin's "View
  // Tenant Portal" -- lets them get back to Admin without signing out.
  function showImpersonationBanner(tenantName) {
    var bar = document.createElement('div');
    bar.className = 'impersonation-banner';
    bar.innerHTML = 'Viewing as <strong>' + esc(tenantName) + '</strong> (admin preview) ' +
      '<button type="button" id="backToAdminBtn">Back to Admin</button>';
    document.querySelector('.topbar').insertAdjacentElement('afterend', bar);
    $('backToAdminBtn').addEventListener('click', function () {
      fetch('/legacy/api/auth/return-to-admin', { method: 'POST' })
        .then(function (r) { location.href = r.ok ? '/legacy/Admin/' : '/legacy/'; })
        .catch(function () { location.href = '/legacy/'; });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('signOutLink').addEventListener('click', signOut);

    fetch('/legacy/api/tenants/me')
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 401) {
          location.href = '/legacy/';
          return;
        }
        if (!res.ok) {
          $('loadingMsg').textContent = 'Could not load this page. Please reload.';
          return;
        }
        if (res.data.impersonating) showImpersonationBanner(res.data.tenant.fullName);
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
      const issueType = $('issueType').value;
      const issueStartedOn = $('issueStarted').value; // '' if left blank
      const description = $('description').value.trim();
      if (!issueType) {
        $('submitStatus').textContent = 'Please select a type.';
        return;
      }
      if (!description) {
        $('submitStatus').textContent = 'Please describe the issue first.';
        return;
      }
      $('submitBtn').disabled = true;
      $('submitStatus').textContent = 'Submitting…';
      fetch('/legacy/api/tenants/me/maintenance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueType: issueType,
          issueStartedOn: issueStartedOn || null,
          description: description,
        }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          $('submitBtn').disabled = false;
          if (!res.ok) {
            $('submitStatus').textContent = res.data.error || 'Could not submit request.';
            return;
          }
          $('issueType').value = '';
          $('issueStarted').value = '';
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
    return fetch('/legacy/api/tenants/me/maintenance')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderRequests(data.requests || []); })
      .catch(function () {
        $('requestBody').innerHTML = '<tr><td colspan="5">Could not load requests.</td></tr>';
      });
  }

  function renderRequests(requests) {
    if (!requests.length) {
      $('requestBody').innerHTML = '<tr><td colspan="5">No requests yet.</td></tr>';
      return;
    }
    $('requestBody').innerHTML = requests.map(function (r) {
      return '<tr><td>' + esc(r.description) + '</td><td>' + esc(r.issue_type || '—') + '</td><td>' +
        fmtDateOnly(r.issue_started_on) + '</td><td><span class="pill ' + esc(r.status) + '">' +
        esc(r.status) + '</span></td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }).join('');
  }
})();
