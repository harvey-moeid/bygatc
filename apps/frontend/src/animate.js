/* animate.js -- Fase 4 checklist (checklist-upgrade-pro-btc-desk.md):
   shared count-up helper for key numbers (price, IV, funding, DVOL,
   etc.) across index.html / futures.html / options.html. Loaded via a
   plain <script> tag with no build step, same pattern as ui.js /
   data.js / charts.js elsewhere in this project -- exposes two
   functions on window so main.js / futures.js / options.js can call
   them directly.

   animateValue(el, value, opts)
     Tweens an element's text from its previous numeric value (stored
     in el.dataset.raw) to a new one over opts.duration ms, formatted
     with opts.prefix/opts.suffix/opts.decimals. First call for a given
     element (no dataset.raw yet) jumps straight to the final value
     instead of counting up from zero -- animating from zero on first
     paint would just be theatre, since zero was never a real reading.
     Passing a null/NaN value renders opts.fallback (default an
     em-dash) instead, so callers do not need a separate branch for
     "data not loaded yet".

     Also strips the ".skel" shimmer placeholder class (see base.css)
     from the element every time it is called, since receiving any
     value -- real or fallback -- means the element is no longer in
     its initial unloaded state.

   clearSkeletons()
     Removes ".skel" from every remaining tagged element in one pass.
     Call once after a page's first full render finishes, as a safety
     net for fields set via plain textContent (not animateValue) so no
     placeholder is left shimmering forever if that field's source
     data never arrives.
*/
(function (global) {
  'use strict';

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function animateValue(el, value, opts) {
    if (!el) return;
    var o = opts || {};
    var decimals = o.decimals || 0;
    var prefix = o.prefix || '';
    var suffix = o.suffix || '';
    var duration = o.duration || 600;
    var fallback = o.fallback != null ? o.fallback : '\u2014';

    el.classList.remove('skel');

    if (value == null || typeof value !== 'number' || Number.isNaN(value)) {
      el.textContent = fallback;
      delete el.dataset.raw;
      return;
    }

    function render(v) {
      return prefix + v.toLocaleString('en-US', {
        minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      }) + suffix;
    }

    var from = parseFloat(el.dataset.raw);

    if (Number.isNaN(from) || from === value) {
      el.textContent = render(value);
      el.dataset.raw = String(value);
      return;
    }

    if (el._animFrame) cancelAnimationFrame(el._animFrame);
    var start = performance.now();
    function tick(now) {
      var t = Math.min(1, (now - start) / duration);
      var cur = from + (value - from) * easeOutCubic(t);
      el.textContent = render(cur);
      if (t < 1) {
        el._animFrame = requestAnimationFrame(tick);
      } else {
        el.dataset.raw = String(value);
        el._animFrame = null;
      }
    }
    el._animFrame = requestAnimationFrame(tick);
  }

  function clearSkeletons() {
    var els = document.querySelectorAll('.skel');
    for (var i = 0; i < els.length; i++) els[i].classList.remove('skel');
  }

  global.animateValue = animateValue;
  global.clearSkeletons = clearSkeletons;
})(window);
