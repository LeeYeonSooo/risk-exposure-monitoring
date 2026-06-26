/* ChainSpiral site — interactions */
(function () {
  "use strict";

  // sticky nav shadow on scroll + transparent/light nav while over the dark hero
  var nav = document.querySelector(".nav");
  var darkHero = document.querySelector(".hero--dark");
  function onScroll() {
    if (!nav) return;
    var y = window.scrollY || window.pageYOffset;
    nav.classList.toggle("scrolled", y > 8);
    if (darkHero) nav.classList.toggle("nav--dark", y < darkHero.offsetHeight - 70);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // mobile menu
  var toggle = document.querySelector(".nav__toggle");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      nav.classList.toggle("open");
    });
    nav.querySelectorAll(".nav__links a").forEach(function (a) {
      a.addEventListener("click", function () { nav.classList.remove("open"); });
    });
  }

  // active link by pathname
  var path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav__links a").forEach(function (a) {
    var href = a.getAttribute("href");
    if (href === path || (path === "index.html" && href === "index.html")) a.classList.add("active");
  });

  // scroll reveal — robust & natural: reveal each element as its top rises into the
  // lower part of the viewport. A plain scroll check never leaves content stuck invisible
  // (even on fast/jumpy scrolling) and gives a gentle, consistent fade-in.
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (reveals.length) {
    function reveal() {
      var trigger = window.innerHeight * 0.92;
      for (var i = reveals.length - 1; i >= 0; i--) {
        if (reveals[i].getBoundingClientRect().top < trigger) {
          reveals[i].classList.add("in");
          reveals.splice(i, 1); // done with this one
        }
      }
    }
    // call directly on scroll — cheap for a handful of elements, and never gets "stuck"
    window.addEventListener("scroll", reveal, { passive: true });
    window.addEventListener("resize", reveal, { passive: true });
    reveal(); // reveal whatever is already in view on load
  }

  // footer year
  var y = document.querySelector("[data-year]");
  if (y) y.textContent = new Date().getFullYear();

  // docs scroll-spy — highlight the sidebar link for the section currently in view
  var docNav = document.querySelector(".doc__nav");
  if (docNav) {
    var spyLinks = Array.prototype.slice.call(docNav.querySelectorAll("a"));
    var spyTargets = spyLinks.map(function (a) {
      var id = (a.getAttribute("href") || "").replace(/^#/, "");
      return id ? document.getElementById(id) : null;
    });
    function docSpy() {
      var line = window.scrollY + 150; // a bit below the sticky nav
      var idx = 0;
      for (var i = 0; i < spyTargets.length; i++) {
        var t = spyTargets[i];
        if (t && t.getBoundingClientRect().top + window.scrollY <= line) idx = i;
      }
      // pin the last section when scrolled to the very bottom (short final sections)
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) idx = spyTargets.length - 1;
      for (var k = 0; k < spyLinks.length; k++) spyLinks[k].classList.toggle("active", k === idx);
    }
    window.addEventListener("scroll", docSpy, { passive: true });
    window.addEventListener("resize", docSpy, { passive: true });
    docSpy();
  }

  // animate hero flow particles (if present)
  document.querySelectorAll("[data-flow] .particle").forEach(function (p, i) {
    p.style.animationDelay = (i * 0.45) + "s";
  });

  // ── dark hero: particle network that GATHERS at the top and DISPERSES outward as you scroll ──
  //    (Morpho-style — stars spread in all directions and fade; scrolling back up re-gathers them)
  (function heroParticles() {
    var canvas = document.querySelector(".hero__canvas");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var colors = ["#6366f1", "#2c5ff6", "#16b8d6", "#9db0ff"];
    var w = 0, h = 0, dpr = 1, link = 130, pts = [], raf = 0, progress = 0, range = 700;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      link = Math.max(108, Math.min(w, h) * 0.14);
      range = Math.max(420, window.innerHeight * 0.9); // scroll distance over which particles fully disperse
    }
    function seed() {
      var n = Math.round(Math.min(96, Math.max(46, (w * h) / 16000)));
      if (reduce) n = Math.round(n * 0.5);
      pts = [];
      for (var i = 0; i < n; i++) {
        var ang = Math.random() * Math.PI * 2; // each particle has its own outward direction → spreads everywhere
        pts.push({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.2, vy: (Math.random() - 0.5) * 0.2,
          dx: Math.cos(ang), dy: Math.sin(ang), dm: 0.55 + Math.random() * 0.95,
          r: Math.random() * 1.5 + 0.8, c: colors[(Math.random() * colors.length) | 0]
        });
      }
    }
    function onScroll() {
      var y = window.scrollY || window.pageYOffset;
      progress = Math.min(1, Math.max(0, y / range));
      if (reduce) draw(); // reduced-motion has no rAF loop → repaint on scroll
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      var i, j, p, a, b, dx, dy, d;
      var sp = Math.max(w, h) * 1.0;       // travel distance when fully dispersed
      var fade = 1 - progress * progress;  // fade out as they spread apart
      for (i = 0; i < pts.length; i++) {
        p = pts[i]; p.x += p.vx; p.y += p.vy;
        if (p.x < -30) p.x = w + 30; else if (p.x > w + 30) p.x = -30;
        if (p.y < -30) p.y = h + 30; else if (p.y > h + 30) p.y = -30;
        p._x = p.x + p.dx * progress * sp * p.dm; // displaced (dispersed) render position
        p._y = p.y + p.dy * progress * sp * p.dm;
      }
      ctx.lineWidth = 1;
      for (i = 0; i < pts.length; i++) {
        for (j = i + 1; j < pts.length; j++) {
          a = pts[i]; b = pts[j]; dx = a._x - b._x; dy = a._y - b._y; d = Math.sqrt(dx * dx + dy * dy);
          if (d < link) {
            ctx.strokeStyle = "rgba(125,145,255," + ((1 - d / link) * 0.45 * fade).toFixed(3) + ")";
            ctx.beginPath(); ctx.moveTo(a._x, a._y); ctx.lineTo(b._x, b._y); ctx.stroke();
          }
        }
      }
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        ctx.fillStyle = p.c; ctx.globalAlpha = 0.92 * fade;
        ctx.beginPath(); ctx.arc(p._x, p._y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    }
    resize(); seed(); onScroll(); cancelAnimationFrame(raf); draw();
    window.addEventListener("scroll", onScroll, { passive: true });
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(function () { resize(); seed(); onScroll(); if (reduce) draw(); }, 180);
    }, { passive: true });
  })();
})();
