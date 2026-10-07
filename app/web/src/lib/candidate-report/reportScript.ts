/**
 * The ONE inline script the stakeholder report carries.
 *
 * It does three things and reads no data except `data-*` attributes the
 * builder wrote from numbers it computed itself:
 *   - a click on a timestamp button seeks that call's <audio> and plays it;
 *   - starting one player pauses the others (one voice at a time);
 *   - while a call plays, the turn being spoken is highlighted.
 *
 * It is exported as a string so the builder can place it verbatim between the
 * script tags AND hash exactly those bytes into the report's
 * Content-Security-Policy (`script-src 'sha256-...'`). Any script injected
 * through a missed escape would not match the hash and would not run. Keep the
 * text free of backslashes and template placeholders: it must be byte-for-byte
 * what the file contains.
 *
 * Without scripts (or in print) the report still reads in full: the timestamps
 * are visible text and the audio players keep their native controls.
 */
export const REPORT_SCRIPT = `(function () {
  'use strict';
  var d = document;
  function audioFor(id) {
    return d.querySelector('audio[data-audio-id="' + id + '"]');
  }
  function pauseOthers(current) {
    var all = d.querySelectorAll('audio');
    for (var i = 0; i < all.length; i++) {
      if (all[i] !== current && !all[i].paused) all[i].pause();
    }
  }
  function seek(audio, t) {
    var go = function () {
      try { audio.currentTime = t; } catch (e) {}
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
    };
    if (audio.readyState >= 1) go();
    else {
      audio.addEventListener('loadedmetadata', go, { once: true });
      audio.load();
    }
  }
  d.addEventListener('click', function (ev) {
    var el = ev.target;
    var btn = el && el.closest ? el.closest('button[data-audio][data-t]') : null;
    if (!btn) return;
    var audio = audioFor(btn.getAttribute('data-audio'));
    var t = parseFloat(btn.getAttribute('data-t'));
    if (!audio || !isFinite(t)) return;
    pauseOthers(audio);
    seek(audio, t);
  });
  d.addEventListener('play', function (ev) {
    if (ev.target && ev.target.tagName === 'AUDIO') pauseOthers(ev.target);
  }, true);
  function highlight(audio) {
    var id = audio.getAttribute('data-audio-id');
    var buttons = d.querySelectorAll('button[data-audio="' + id + '"][data-t]');
    var active = -1;
    for (var i = 0; i < buttons.length; i++) {
      if (parseFloat(buttons[i].getAttribute('data-t')) <= audio.currentTime + 0.25) active = i;
    }
    for (var j = 0; j < buttons.length; j++) {
      var row = buttons[j].closest('li');
      if (!row) continue;
      if (j === active) {
        row.setAttribute('data-active', 'true');
        buttons[j].setAttribute('aria-current', 'true');
      } else {
        row.removeAttribute('data-active');
        buttons[j].removeAttribute('aria-current');
      }
    }
  }
  d.addEventListener('timeupdate', function (ev) {
    if (ev.target && ev.target.tagName === 'AUDIO') highlight(ev.target);
  }, true);
})();`;
