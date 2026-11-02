// Product analytics (PostHog EU Cloud), loaded after the pinned posthog-js bundle.
//
// Cookieless: nothing is stored in the browser (no cookies, no local or session storage), and no
// session recordings, surveys or autocapture. It counts page views, clicks on the sign-up
// buttons and outbound links, opening the menu, and which sections scroll into view; the page
// works the same when either script is blocked.
(function () {
  'use strict';
  var posthog = window.posthog;
  if (!posthog || typeof posthog.init !== 'function') return;

  posthog.init('phc_pVe3R8NDCnwRGoecKxUDR5xydaXGoCh38ZFXnFY8K54c', {
    api_host: 'https://eu.i.posthog.com',
    ui_host: 'https://eu.posthog.com',
    cookieless_mode: 'always',
    persistence: 'memory',
    capture_pageview: true,
    capture_pageleave: false,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
  });

  // Where on the page a button sits: its section's id (or class), the header, the menu, the footer.
  function where(el) {
    if (el.closest('#menu')) return 'menu';
    var section = el.closest('section');
    if (section) return section.id || section.classList[0] || 'section';
    if (el.closest('header')) return 'header';
    if (el.closest('footer')) return 'footer';
    return 'page';
  }

  // Which link: sign-up buttons carry the plan (`#/signup?plan=team`), never anything else;
  // outbound links say only where they go (an email link never sends the address).
  function classify(url) {
    if (url.protocol === 'mailto:') return { event: 'link_clicked', props: { target: 'email' } };
    if (url.hostname === 'app.spendbrake.dev') {
      var signup = /^#\/signup(?:\?(.*))?$/.exec(url.hash);
      if (signup) {
        var plan = new URLSearchParams(signup[1] || '').get('plan');
        return {
          event: 'cta_clicked',
          props: { cta: 'signup', plan: /^[a-z]{1,20}$/.test(plan || '') ? plan : null },
        };
      }
      return { event: 'link_clicked', props: { target: 'app' } };
    }
    if (url.hostname === 'docs.spendbrake.dev') {
      return { event: 'link_clicked', props: { target: 'docs' } };
    }
    if (url.hostname === 'github.com') {
      return { event: 'link_clicked', props: { target: 'github' } };
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    var link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!link) return;
    // The menu is CSS only (#menu:target): its Menu link is the one way to open it.
    if (link.getAttribute('href') === '#menu') {
      posthog.capture('menu_opened');
      return;
    }
    var hit = classify(new URL(link.href));
    if (!hit) return;
    hit.props.location = where(link);
    // The click usually leaves the page: send now, as a beacon, rather than with the next batch.
    posthog.capture(hit.event, hit.props, { send_instantly: true, transport: 'sendBeacon' });
  });

  // Sections people reach: each one once per page load, when it first scrolls into view.
  if (typeof IntersectionObserver === 'function') {
    var seen = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          seen.unobserve(entry.target);
          posthog.capture('section_viewed', { section: entry.target.id });
        });
      },
      { rootMargin: '0px 0px -25% 0px' },
    );
    document.querySelectorAll('main section[id]').forEach(function (section) {
      seen.observe(section);
    });
  }
})();
