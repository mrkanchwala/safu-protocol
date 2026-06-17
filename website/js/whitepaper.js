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

  showSection('cover');
}());
