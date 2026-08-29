/*
 * Legacy Property Hub -- sign-in landing page.
 * Submits the entered email to POST /legacy/api/auth/request, which
 * always responds { ok: true } whether or not the email matched a
 * tenant/admin (so this page can't be used to enumerate who has an
 * account) -- if it did match, a one-time sign-in link was emailed.
 */
(function () {
  var ERROR_MESSAGES = {
    invalid_link: 'That sign-in link is invalid. Please request a new one below.',
    expired_link: 'That sign-in link has expired or was already used. Please request a new one below.',
  };

  document.addEventListener('DOMContentLoaded', function () {
    var errorCode = new URLSearchParams(location.search).get('error');
    if (errorCode) {
      var notice = document.getElementById('errorNotice');
      notice.textContent = ERROR_MESSAGES[errorCode] || 'Something went wrong. Please try again.';
      notice.hidden = false;
    }

    var form = document.getElementById('emailForm');
    var submitBtn = document.getElementById('submitBtn');
    var emailInput = document.getElementById('emailInput');
    var backBtn = document.getElementById('backToSigninBtn');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = emailInput.value.trim();
      if (!email) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      fetch('/legacy/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      })
        .catch(function () { /* still show the same confirmation -- see note below */ })
        .then(function () {
          // Always show the same confirmation, matching the server's
          // "don't reveal whether the email matched" behavior.
          document.getElementById('signinView').hidden = true;
          document.getElementById('sentView').hidden = false;
        });
    });

    backBtn.addEventListener('click', function () {
      // Let them try again -- e.g. they typed the wrong email -- without
      // reloading the page. Reset the button/field state left over from
      // the previous submission.
      document.getElementById('sentView').hidden = true;
      document.getElementById('signinView').hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Sign-In Link';
      emailInput.value = '';
      emailInput.focus();
    });
  });
})();
