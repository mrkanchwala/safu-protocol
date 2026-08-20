(function () {
  function showSection(id) {
    document.querySelectorAll('.wp-slide').forEach(function (s) {
      s.classList.remove('active');
    });
    document.querySelectorAll('.wp-nav-btn').forEach(function (b) {
      b.classList.remove('active');
    });
    var target = document.getElementById(id);
    var btn = document.querySelector('[data-target="' + id + '"]');
    if (target) target.classList.add('active');
    if (btn) btn.classList.add('active');
    var main = document.querySelector('.wp-main');
    if (main) main.scrollTop = 0;
  }

  document.querySelectorAll('.wp-nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showSection(btn.getAttribute('data-target'));
    });
  });

  // Deep-linking. Added 2026-08-20 alongside section 09: the homepage links
  // straight to /whitepaper.html#stakers, and without this the page always
  // opened on the cover and silently ignored the hash. Falls back to the
  // cover when the hash names nothing real, so a stale or hand-typed link
  // still lands somewhere sensible rather than on a blank document.
  function pinScroll() {
    var main = document.querySelector('.wp-main');
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function sectionFromHash() {
    var id = (window.location.hash || '').replace(/^#/, '');
    return id && document.getElementById(id) ? id : null;
  }

  window.addEventListener('hashchange', function () {
    var id = sectionFromHash();
    if (id) showSection(id);
  });

  showSection(sectionFromHash() || 'cover');

  // The browser performs its own native scroll to the element named by the
  // hash. That happens while every slide is still laid out, before this
  // script hides the inactive ones, so the leftover offset survives the
  // collapse and clips the section label above the fold. The residual scroll
  // sits on the WINDOW, not on .wp-main, so both are reset here on the next
  // frame and a deep link opens identically to a nav click.
  if (sectionFromHash()) {
    // This script is deferred, so it runs before the browser has finished its
    // own anchor scroll. Pinning once here is not enough; the native scroll
    // lands afterwards and wins. Pin again after load, when it is done.
    requestAnimationFrame(pinScroll);
    window.addEventListener('load', function () {
      requestAnimationFrame(pinScroll);
    });
  }
}());
