/*
 * Shared icon set for the GFS Facility Hub (/gfs/*).
 * Loaded on every page. Icons are inline SVG (no external requests, no
 * icon font) so they inherit color via `currentColor` and stay crisp at
 * any size.
 *
 * Usage: <span class="icon" data-icon="dashboard"></span>
 * then call GFSIcons.apply() once the DOM is ready (app.js does this).
 */
(function (global) {
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + inner + '</svg>';
  }

  const ICONS = {
    dashboard: svg(
      '<path d="M3 11.5 12 4l9 7.5"/>' +
      '<path d="M5 10.2V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9.8"/>' +
      '<path d="M9.5 21v-6h5v6"/>'
    ),
    vendors: svg(
      '<path d="M17.6 8.4a3.6 3.6 0 0 1-4.7 4.7L6 20l-2-2 6.9-6.9a3.6 3.6 0 0 1 4.7-4.7l-2.5 2.5 1.8 1.8 2.5-2.5z"/>'
    ),
    offices: svg(
      '<rect x="4" y="3" width="10" height="18" rx="1"/>' +
      '<path d="M14 8.5h4.5a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H14"/>' +
      '<path d="M7.5 7.5h1M7.5 11h1M7.5 14.5h1M7.5 18h1"/>' +
      '<path d="M16.5 12.5h1M16.5 16h1"/>'
    ),
    workOrders: svg(
      '<rect x="5" y="4.2" width="14" height="17.3" rx="2"/>' +
      '<path d="M9 3.2h6a1 1 0 0 1 1 1v1.5H8V4.2a1 1 0 0 1 1-1z"/>' +
      '<path d="M9 10.5h6M9 14h6M9 17.5h3.5"/>'
    ),
    reports: svg(
      '<path d="M4 20V11M9.5 20V6M15 20v-8M20.5 20H4"/>'
    ),
    allHubs: svg(
      '<rect x="3.2" y="3.2" width="7" height="7" rx="1.2"/>' +
      '<rect x="13.8" y="3.2" width="7" height="7" rx="1.2"/>' +
      '<rect x="3.2" y="13.8" width="7" height="7" rx="1.2"/>' +
      '<rect x="13.8" y="13.8" width="7" height="7" rx="1.2"/>'
    ),
    signOut: svg(
      '<path d="M9.5 21H5.8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2H9.5"/>' +
      '<path d="M15.5 16.5 20 12l-4.5-4.5"/>' +
      '<path d="M20 12H9.5"/>'
    ),
    tradeCategories: svg(
      '<path d="M20 12.6 12.6 20 4 11.4V4h7.4z"/>' +
      '<circle cx="8.2" cy="8.2" r="1.3"/>'
    ),
    states: svg(
      '<path d="M12 21s7-6.7 7-11.6A7 7 0 0 0 5 9.4C5 14.3 12 21 12 21z"/>' +
      '<circle cx="12" cy="9.4" r="2.4"/>'
    ),
    total: svg(
      '<rect x="5" y="4.2" width="14" height="17.3" rx="2"/>' +
      '<path d="M9 3.2h6a1 1 0 0 1 1 1v1.5H8V4.2a1 1 0 0 1 1-1z"/>' +
      '<path d="M9 10.5h6M9 14h6M9 17.5h3.5"/>'
    ),
    new: svg(
      '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 8v8M8 12h8"/>'
    ),
    inProgress: svg(
      '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 7.2v5.3l3.4 2"/>'
    ),
    approved: svg(
      '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M8.3 12.3l2.4 2.4 5-5"/>'
    )
  };

  function apply(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      const name = el.getAttribute('data-icon');
      if (ICONS[name]) el.innerHTML = ICONS[name];
    });
  }

  global.GFSIcons = { ICONS: ICONS, apply: apply };
})(window);
