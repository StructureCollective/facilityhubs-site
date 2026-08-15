// Google Sign-In access control for the GFS Facility Hub (/gfs/*).
//
// Setup:
// 1. In Google Cloud Console, create an OAuth 2.0 Client ID of type
//    "Web application" (APIs & Services -> Credentials -> Create Credentials
//    -> OAuth client ID). Add https://facilityhubs.com (and your local/dev
//    URL if you test locally) under "Authorized JavaScript origins" --
//    no redirect URI is needed for this flow. Paste the client ID below.
// 2. Decide who's allowed in. Set allowedDomain to a Google Workspace
//    domain (e.g. "greggsfacilitysolutions.com") to allow anyone signing
//    in with that domain, and/or list individual addresses in
//    allowedEmails for people outside that domain (e.g. a personal
//    Gmail). You can use either or both.
//
// If both allowedDomain and allowedEmails are left empty, sign-in stays
// disabled for everyone -- this fails closed on purpose so the site is
// never accidentally left open while you're still setting this up.
// Note: Google's "OAuth client created" dialog also gives you a client
// secret (starts with GOCSPX-). That's for server-side flows and is NOT
// used here -- this page only needs the client ID below. Never put the
// client secret in this file or anywhere else that ships to the browser.
const GFS_AUTH_CONFIG = {
  googleClientId: '652216926906-t31frm10c8org05pigq8kirh84jjp7gd.apps.googleusercontent.com',

  allowedDomain: 'greggsfacilitysolutions.com',

  allowedEmails: [
    // e.g. 'someone@gmail.com',
  ],
};
