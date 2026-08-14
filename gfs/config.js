// Shared configuration for ALL THREE tools (Dashboard, VendorSync,
// OfficeSync) -- they all call the same consolidated Apps Script
// project now, so there's exactly one URL/token to keep in sync.
// Edit these after you deploy/redeploy apps-script/GFSFacilityHub/Code.gs.
const APP_CONFIG = {
  appVersion: '06.00.00',

  // The Apps Script Web App /exec URL for the consolidated GFS
  // Facility Hub backend. Apps Script -> Deploy -> Manage deployments
  // -> copy the Web app URL.
  apiUrl: 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec',

  // Must match API_TOKEN in apps-script/GFSFacilityHub/Code.gs. Change
  // both together.
  apiToken: '46ec51c3-743b-48bb-a47f-f56f2f6940fb',

  // Sidebar placeholders for tools that don't exist yet.
  workOrdersUrl: '',
  reportsUrl: '',
  supportUrl: 'mailto:admin@structurecollective.com'
};
