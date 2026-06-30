/* react-grab-pick.js — in-page capture script for the /ui slash command.
 *
 * Injected via:  cmux browser --surface <S> eval --script "$(cat react-grab-pick.js)"
 *
 * Responsibility: wire react-grab's selection into a single global the runbook
 * polls — window.__UI_PICK__ — and make the wiring robust to the injected
 * react-grab copy differing from the npm API (risk R1). Feature-detect EVERYTHING.
 *
 * Contract:
 *   - window.__UI_PICK__  === null        -> nothing picked yet (keep polling)
 *   - window.__UI_PICK__  === 'cancelled' -> user pressed Escape (abort)
 *   - window.__UI_PICK__  === <blob obj>  -> a component was picked (resolve)
 *
 * The IIFE's final expression returns a JSON status string so the injecting
 * `eval` call tells the runbook what API shape it actually found and whether
 * activation succeeded — the runbook branches on this (e.g. fall back to
 * `cmux rpc browser.react_grab.toggle` only if in-page activate() is missing).
 */
(function () {
  "use strict";

  // ---- idempotent re-install (re-invoking /ui must not stack listeners) ----
  if (window.__UI_PICK_INSTALLED__) {
    window.__UI_PICK__ = null; // arm a fresh capture
    try { window.__UI_PICK_REARM__ && window.__UI_PICK_REARM__(); } catch (e) {}
    return JSON.stringify(Object.assign({ reinstalled: true }, window.__UI_PICK_STATUS__ || {}));
  }

  window.__UI_PICK__ = null;
  window.__UI_PICK_INSTALLED__ = true;

  var RG = window.__REACT_GRAB__ || null;
  var has = function (name) { return RG && typeof RG[name] === "function"; };

  var status = {
    reinstalled: false,
    reactGrabPresent: !!RG,
    apiKeys: RG ? Object.keys(RG) : [],
    hasGetSource: has("getSource"),
    hasGetStackContext: has("getStackContext"),
    hasGetDisplayName: has("getDisplayName"),
    hasSetOptions: has("setOptions"),
    hasActivate: has("activate"),
    mode: null,        // 'hook' | 'click-fallback' | 'none'
    activated: false
  };

  // ----------------------- helpers (all defensive) -----------------------
  var clip = function (s, n) {
    if (s == null) return null;
    s = String(s);
    return s.length > n ? s.slice(0, n) + "…[+" + (s.length - n) + "]" : s;
  };

  var readAttrs = function (el) {
    var out = {};
    try {
      var a = el.attributes || [];
      for (var i = 0; i < a.length; i++) out[a[i].name] = a[i].value;
    } catch (e) {}
    return out;
  };

  // curated computed-style subset — serializing the whole declaration is huge
  var STYLE_PROPS = [
    "display", "position", "top", "right", "bottom", "left", "zIndex",
    "width", "height", "margin", "padding", "boxSizing",
    "color", "backgroundColor", "opacity", "visibility",
    "font", "fontSize", "fontFamily", "fontWeight", "lineHeight",
    "textAlign", "letterSpacing", "whiteSpace",
    "border", "borderRadius", "boxShadow", "outline",
    "flex", "flexDirection", "alignItems", "justifyContent", "gap",
    "gridTemplateColumns", "gridTemplateRows",
    "transform", "transition", "overflow", "cursor", "pointerEvents"
  ];
  var readStyles = function (el) {
    var out = {};
    try {
      var cs = window.getComputedStyle(el);
      for (var i = 0; i < STYLE_PROPS.length; i++) {
        var p = STYLE_PROPS[i];
        var v = cs.getPropertyValue ? cs.getPropertyValue(p.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); })) : cs[p];
        if (v) out[p] = v;
      }
    } catch (e) {}
    return out;
  };

  var readBox = function (el) {
    try {
      var r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        top: Math.round(r.top), left: Math.round(r.left),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
        scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1
      };
    } catch (e) { return null; }
  };

  // parse "(at src/Foo.tsx:42:7)" out of a stack-context string -> {filePath,lineNumber,column}
  var parseStackFrame = function (stack) {
    if (!stack || typeof stack !== "string") return null;
    var m = stack.match(/\(at\s+([^):]+):(\d+):(\d+)\)/);
    if (!m) m = stack.match(/([^\s():]+\.[a-z]+):(\d+):(\d+)/i);
    if (!m) return null;
    return { filePath: m[1], lineNumber: parseInt(m[2], 10), column: parseInt(m[3], 10) };
  };

  // normalize whatever getSource returns into {filePath,lineNumber,column,componentName}
  var normalizeSource = function (src) {
    if (!src || typeof src !== "object") return null;
    var fp = src.filePath || src.fileName || src.file || src.source || null;
    if (!fp) return null;
    return {
      filePath: String(fp),
      lineNumber: src.lineNumber != null ? src.lineNumber : (src.line != null ? src.line : null),
      column: src.column != null ? src.column : (src.col != null ? src.col : null),
      componentName: src.componentName || src.displayName || src.name || null,
      lineTrusted: true   // came from react-grab's resolved source -> line is authoritative
    };
  };

  // Direct read of React fiber's _debugSource — the ONLY source signal available
  // on an un-instrumented dev app (react-grab.getSource needs its build plugin and
  // returns null without it; VERIFIED live on Vite+React 18). _debugSource gives a
  // RELIABLE fileName + columnNumber, but its lineNumber is offset by the bundler's
  // injected preamble (VERIFIED: +19 lines under @vitejs/plugin-react HMR). So we
  // surface fileName/column as trusted and the line only as an UNTRUSTED hint —
  // the runbook must locate the exact line by element content within the file.
  var FIBER_KEYS_RE = /^__reactFiber\$|^__reactInternalInstance\$/;
  var readDebugSource = function (el) {
    try {
      var k = Object.keys(el).find(function (x) { return FIBER_KEYS_RE.test(x); });
      if (!k) return null;
      var f = el[k], hops = 0;
      while (f && hops < 30) {               // walk owner/return chain for nearest _debugSource
        var d = f._debugSource;
        if (d && (d.fileName || d.filePath)) {
          return {
            filePath: String(d.fileName || d.filePath),
            lineNumber: d.lineNumber != null ? d.lineNumber : null,
            column: d.columnNumber != null ? d.columnNumber : (d.column != null ? d.column : null),
            componentName: null,
            lineTrusted: false  // bundler preamble offsets this -> hint only, locate by content
          };
        }
        f = f._debugOwner || f.return;
        hops++;
      }
    } catch (e) {}
    return null;
  };

  // ----------------------- blob assembly -----------------------
  // CRITICAL (fix #3): the ELEMENT half is committed SYNCHRONOUSLY on the very
  // first click — independent of getSource/getDisplayName. That guarantees the
  // poll resolves on click even when the injected react-grab lacks source APIs
  // (no more 120s dead poll, and the text/class/data-attr fallback ladder still
  // has real input). getSource/getStackContext/getDisplayName only ENRICH the
  // already-committed blob, asynchronously, in place.
  var picked = false; // first click wins; guards against hook+listener double-fire

  var assemble = function (el) {
    if (picked) return;                       // already captured this round
    if (window.__UI_PICK__ === "cancelled") return;
    if (!el || el.nodeType !== 1) return;
    picked = true;

    var blob = {
      source: null,        // enriched below if getSource works
      component: null,      // enriched below
      stack: null,          // enriched below
      element: {
        tag: (el.tagName || "").toLowerCase(),
        text: clip((el.innerText || el.textContent || "").trim(), 200),
        outerHTML: clip(el.outerHTML, 2000),
        attrs: readAttrs(el),
        className: (typeof el.className === "string" ? el.className : (el.getAttribute && el.getAttribute("class"))) || null
      },
      computedStyles: readStyles(el),
      box: readBox(el),
      url: location.href,
      capturedAt: Date.now(),
      enriched: false       // flips true once source enrichment settles
    };

    // ---- COMMIT NOW (element half) ----
    window.__UI_PICK__ = blob;

    // ---- enrich asynchronously, mutating the same committed object ----
    var stackP = Promise.resolve(null);
    if (has("getStackContext")) { try { stackP = Promise.resolve(RG.getStackContext(el)); } catch (e) {} }
    var srcP = Promise.resolve(null);
    if (has("getSource")) { try { srcP = Promise.resolve(RG.getSource(el)); } catch (e) {} }

    Promise.all([
      srcP.catch(function () { return null; }),
      stackP.catch(function () { return null; })
    ]).then(function (res) {
      var src = normalizeSource(res[0]), stack = res[1];

      if (!src && stack) {                    // backfill source from stack frame
        var f = parseStackFrame(stack);
        if (f) src = { filePath: f.filePath, lineNumber: f.lineNumber, column: f.column, componentName: null, lineTrusted: true };
      }
      // PRIMARY fallback on un-instrumented apps: read the fiber's _debugSource
      // directly. Gives a trusted file (line is a hint — see readDebugSource).
      if (!src || !src.filePath) {
        var ds = readDebugSource(el);
        if (ds) src = ds;
      }
      if (src && src.column == null && stack) { // backfill column from stack
        var f2 = parseStackFrame(stack);
        if (f2 && f2.lineNumber === src.lineNumber) src.column = f2.column;
      }

      // re-read the live global (Escape may have replaced it; don't clobber a cancel)
      if (window.__UI_PICK__ === "cancelled" || window.__UI_PICK__ == null) return;
      window.__UI_PICK__.source = src;        // may stay null -> fallback ladder
      window.__UI_PICK__.stack = typeof stack === "string" ? clip(stack, 4000) : null;
      window.__UI_PICK__.component =
        (src && src.componentName) ||
        (has("getDisplayName") ? (function () { try { return RG.getDisplayName(el); } catch (e) { return null; } })() : null);
      window.__UI_PICK__.enriched = true;
    });
  };

  // ----------------------- wiring -----------------------
  // SELF-SUFFICIENT select mode (VERIFIED live): we do NOT activate react-grab's
  // overlay. Two reasons proven on a real cmux browser surface: (1) without its
  // build plugin react-grab.getSource returns null, so it adds no source value
  // (we read _debugSource directly instead); (2) its active overlay swallows the
  // click in the capture phase, so OUR listener never fires. So /ui ships its own
  // lightweight hover-highlight + capture-phase click that preventDefaults the
  // app's own handler (clicking an <a>/<button> must NOT navigate/submit).

  // Two boxes, both pointer-events:none so they never block the real target:
  //  - hl  = HOVER highlight (blue, follows the cursor before the pick)
  //  - sel = SELECTED lock (indigo, solid, with a label) — STAYS on the picked
  //          region while you edit, so it's always clear what's being changed.
  var mkBox = function (id, css) {
    var b = document.getElementById(id);
    if (!b) { b = document.createElement("div"); b.id = id; (document.body || document.documentElement).appendChild(b); }
    b.style.cssText = css; return b;
  };
  var hl = mkBox("__ui_pick_hl__",
    "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:2px;transition:all .04s ease;display:none");
  var sel = mkBox("__ui_pick_sel__",
    "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f46e5;background:rgba(79,70,229,.10);border-radius:3px;box-shadow:0 0 0 2px rgba(79,70,229,.25),0 2px 12px rgba(79,70,229,.35);display:none");
  var selLabel = document.getElementById("__ui_pick_sel_label__");
  if (!selLabel) {
    selLabel = document.createElement("div"); selLabel.id = "__ui_pick_sel_label__";
    sel.appendChild(selLabel);
  }
  selLabel.style.cssText = "position:absolute;left:-2px;top:-22px;max-width:320px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:#4f46e5;color:#fff;font:600 11px/1.5 ui-sans-serif,system-ui,sans-serif;padding:1px 7px;border-radius:3px 3px 3px 0;pointer-events:none";

  // widget refs — declared early so onMove/onClick can guard against widget
  // clicks, and lockSelection / __UI_PICK_REARM__ can drive widget state.
  // Both are (re)assigned by the status-widget block further down.
  var widgetEl = null;
  var setWidgetState = function () {};
  var lastTag = null;            // tag of the currently locked selection (drives the processing/done states)
  var procTimers = [];           // pending done/revert timers, cleared on re-entry so calls don't stack

  var place = function (box, el) {
    try {
      var r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = r.left + "px"; box.style.top = r.top + "px";
      box.style.width = r.width + "px"; box.style.height = r.height + "px";
    } catch (e) {}
  };
  var onMove = function (e) {
    if (widgetEl && e.target && widgetEl.contains(e.target)) return; // never highlight over the widget
    if (!picked && e.target && e.target.nodeType === 1 && e.target !== hl && e.target !== sel) place(hl, e.target);
  };

  // remove the interaction listeners (called on pick AND on full teardown)
  var stopListening = function () {
    try { document.removeEventListener("mousemove", onMove, true); } catch (e) {}
    try { document.removeEventListener("click", onClick, true); } catch (e) {}
  };
  // PICK: lock the selected box onto the chosen element, keep it visible while editing
  var lockSelection = function (el) {
    stopListening();
    try { resetProcVisual(); } catch (e) {}   // M1: never inherit a prior block's processing visuals
    try { hl.style.display = "none"; } catch (e) {}
    place(sel, el);
    try {
      var tag = (el.tagName || "").toLowerCase();
      var t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      selLabel.textContent = (tag ? "<" + tag + ">" : "selected") + (t ? "  " + t.slice(0, 40) : "");
      lastTag = (tag || "node").replace(/[^a-z0-9-]/g, "") || "node";   // S3: sanitize; remembered for __UI_PICK_PROCESSING__
    } catch (e) {}
    // reflect the pick in the status widget (listeners are now off; toggle stays ON
    // so the user can "select another" by re-arming via the switch)
    try { setWidgetState("picked", (el.tagName || "").toLowerCase()); } catch (e) {}
  };
  // FULL teardown (Esc / Step 9 disarm / re-arm): remove listeners AND hide BOTH boxes
  var teardown = function () {
    stopListening();
    try { resetProcVisual(); } catch (e) {}   // M1: kill any in-flight processing visuals + timers
    try { hl.style.display = "none"; } catch (e) {}
    try { sel.style.display = "none"; } catch (e) {}
  };

  // capture-phase click: stop the app's handler, capture, then LOCK the highlight
  var onClick = function (e) {
    if (widgetEl && e.target && widgetEl.contains(e.target)) return; // clicks on the switch/✕ are not picks
    if (picked || window.__UI_PICK__ === "cancelled") return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === hl || el === sel) return;
    e.preventDefault(); e.stopImmediatePropagation();   // don't trigger app navigation/submit
    assemble(el);
    lockSelection(el);                                  // keep the selected region highlighted
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  window.__UI_PICK_REARM__ = function () {              // re-arm on re-install of /ui
    picked = false; window.__UI_PICK__ = null;
    try { resetProcVisual(); } catch (e) {}             // M1: don't carry processing visuals/timers into the next pick
    try { sel.style.display = "none"; } catch (e) {}    // clear the previous selection lock
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    // re-attach the widget if a prior session removed it (close -> re-/ui), then arm it
    try { if (widgetEl && !widgetEl.isConnected && document.body) document.body.appendChild(widgetEl); } catch (e) {}
    try { setWidgetState("armed"); } catch (e) {}
  };
  window.__UI_PICK_TEARDOWN__ = teardown;

  // ----------------------- processing / done state machine -----------------------
  // While Claude edits the picked block's source, the lock box + widget show a
  // "processing" sweep/breath; when the edit lands, a brief emerald "done" flash,
  // then back to the normal selected state. Driven by ONE hook the runbook calls:
  // window.__UI_PICK_PROCESSING__(true|false). All CSS (keyframes + .is-processing
  // / .is-done selectors) lives in the WIDGET_CSS stylesheet below — inline styles
  // can't hold keyframes, and animations there correctly beat the sel box's inline
  // box-shadow. NOTE: the indigo light-band is clipped by a small overflow:hidden
  // wrapper (#__ui_pick_sweep__) holding a moving band (#__ui_pick_sweep_band__),
  // rather than by overflow:hidden on the sel box itself — that keeps the selection
  // label (a child of the sel box that overhangs its top edge) from being clipped.
  var prefersReduce = function () {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches); } catch (e) { return false; }
  };
  var DOT_SPANS =
    '<span class="uipick-dot">.</span>' +
    '<span class="uipick-dot uipick-d2">.</span>' +
    '<span class="uipick-dot uipick-d3">.</span>';
  var ensureSweep = function () {                 // create the clip wrapper + moving band on demand
    var sw = document.getElementById("__ui_pick_sweep__");
    if (!sw) {
      sw = document.createElement("div");
      sw.id = "__ui_pick_sweep__";
      var band = document.createElement("div");
      band.id = "__ui_pick_sweep_band__";
      sw.appendChild(band);
      sel.appendChild(sw);
    }
    return sw;
  };
  var removeSweep = function () {                 // drop the band (and its will-change) entirely on exit
    try { var sw = document.getElementById("__ui_pick_sweep__"); if (sw && sw.parentNode) sw.parentNode.removeChild(sw); } catch (e) {}
  };
  var clearProcTimers = function () {
    try { for (var i = 0; i < procTimers.length; i++) clearTimeout(procTimers[i]); } catch (e) {}
    procTimers = [];
  };
  // M1: tear ALL processing/done visuals back to idle. MUST run on every exit/transition
  // path (not just the happy 600ms timer) or the sweep band (+ its will-change compositor
  // layer + infinite animation), the is-processing/is-done classes, the emerald label, and
  // pending revert timers leak onto the NEXT selected block / after a cancel.
  var resetProcVisual = function () {
    clearProcTimers();
    try { sel.classList.remove("is-processing", "is-done"); } catch (e) {}
    try { removeSweep(); } catch (e) {}
    try { sel.style.transition = ""; } catch (e) {}
    try { selLabel.style.background = "#4f46e5"; selLabel.style.color = "#fff"; } catch (e) {}
  };

  // THE ONE HOOK: enter processing (true) / finish with done-flash then revert (false).
  // Idempotent and safe to call repeatedly; every DOM op is guarded. No-ops if nothing
  // is currently selected.
  window.__UI_PICK_PROCESSING__ = function (on) {
    try {
      if (!sel) return;
      // require an active locked selection (sel visible + a remembered tag)
      var active = false;
      try { active = sel.style.display !== "none" && !!lastTag; } catch (e) {}

      if (on) {
        if (!active) return;                      // nothing selected -> no-op safely
        clearProcTimers();
        try { selLabel.style.background = "#4f46e5"; selLabel.style.color = "#fff"; } catch (e) {} // S1: drop leftover emerald chip if (false)->(true) raced
        try { ensureSweep(); } catch (e) {}        // show the sweep band
        try { sel.classList.remove("is-done"); sel.classList.add("is-processing"); } catch (e) {}
        try {                                      // lock label -> "<tag> · applying" + animated dots
          if (prefersReduce()) selLabel.textContent = "<" + lastTag + "> applying…";
          else selLabel.innerHTML = "&lt;" + lastTag + "&gt; · applying" + DOT_SPANS;
        } catch (e) {}
        try { setWidgetState("processing", lastTag); } catch (e) {}
        return;
      }

      // on === false -> finish: emerald "done" flash on both nodes, then auto-revert.
      // S2: only when we were actually processing (or already mid-done) — a stray (false)
      // must not yank an armed/paused widget into done->picked.
      var inProc = false;
      try { inProc = sel.classList.contains("is-processing") || sel.classList.contains("is-done"); } catch (e) {}
      if (!inProc) return;
      clearProcTimers();
      var tag = lastTag || "node";
      try { sel.classList.remove("is-processing"); sel.classList.add("is-done"); } catch (e) {}
      try { removeSweep(); } catch (e) {}          // drop the band (will-change) immediately
      try { sel.style.transition = "border-color .18s ease,box-shadow .18s ease"; } catch (e) {}
      try {                                        // label chip -> emerald "✓ <tag>"
        selLabel.style.background = "#34d399";
        selLabel.style.color = "#073b2e";
        selLabel.textContent = "✓ <" + tag + ">";
      } catch (e) {}
      try { setWidgetState("done", tag); } catch (e) {}

      // ~220ms: revert the lock box to its idle selected look + "<tag> selected" label
      procTimers.push(setTimeout(function () {
        try {
          sel.classList.remove("is-done");
          selLabel.style.background = "#4f46e5";
          selLabel.style.color = "#fff";
          selLabel.textContent = "<" + tag + "> selected";
        } catch (e) {}
      }, 220));

      // ~600ms: revert the widget to the picked state + final cleanup of transient styles
      procTimers.push(setTimeout(function () {
        try { sel.classList.remove("is-done", "is-processing"); } catch (e) {}
        try { sel.style.transition = ""; } catch (e) {}
        try { setWidgetState("picked", tag); } catch (e) {}
      }, 600));
    } catch (e) {}
  };

  // ----------------------- bottom-docked status widget -----------------------
  // Pill that tells the user /ui select mode is ON and lets them toggle it
  // on/off or close it. It DRIVES the machinery above — it never reimplements
  // it. State is one class on #ui-status-widget (is-armed | is-paused | is-picked):
  //   ON  (armed/picked) -> listeners active via __UI_PICK_REARM__
  //   OFF (paused)        -> stopListening(), widget stays visible, hover/click inert
  //   ✕                   -> __UI_PICK__='cancelled' + teardown() + remove widget
  var WIDGET_CSS = [
    // softer, slower halo — breathes rather than blinks
    "@keyframes uisw-pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.45),0 0 5px rgba(52,211,153,.55)}70%{box-shadow:0 0 0 5px rgba(52,211,153,0),0 0 5px rgba(52,211,153,.55)}100%{box-shadow:0 0 0 5px rgba(52,211,153,0),0 0 5px rgba(52,211,153,.4)}}",
    "@keyframes uisw-enter{from{opacity:0;transform:translateX(-50%) translateY(10px) scale(.98)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}",
    // refined pill: tighter proportions, layered glass with a top light-catch + soft stacked shadow
    "#ui-status-widget{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:2147483647;pointer-events:auto;box-sizing:border-box;height:33px;display:flex;align-items:center;gap:9px;padding:0 5px 0 13px;border-radius:16.5px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0) 42%),rgba(18,19,24,0.95);border:1px solid rgba(255,255,255,0.09);box-shadow:0 10px 30px rgba(0,0,0,0.46),0 2px 6px rgba(0,0,0,0.30),inset 0 1px 0 rgba(255,255,255,0.09),inset 0 -1px 0 rgba(0,0,0,0.25);color:#fff;font:500 12.5px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:.01em;animation:uisw-enter 220ms cubic-bezier(.22,1,.36,1) both;transition:border-color .2s ease,box-shadow .2s ease}",
    "@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){#ui-status-widget{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,0) 42%),rgba(20,21,27,0.66);-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%)}}",
    "#ui-status-widget:hover{border-color:rgba(255,255,255,0.14);box-shadow:0 12px 34px rgba(0,0,0,0.50),0 2px 8px rgba(0,0,0,0.32),inset 0 1px 0 rgba(255,255,255,0.11)}",
    "#ui-status-widget *{box-sizing:border-box}",
    "#ui-status-widget .uisw-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%}",
    "#ui-status-widget.is-armed .uisw-dot{background:#34d399;animation:uisw-pulse 2.2s cubic-bezier(.4,0,.2,1) infinite}",
    "#ui-status-widget.is-paused .uisw-dot{background:#5b6170}",
    "#ui-status-widget.is-picked .uisw-dot{background:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.18),0 0 7px rgba(99,102,241,.7)}",
    // label: /ui rendered as a quiet mono badge, the state words lighter — reads as crafted, not loud
    "#ui-status-widget .uisw-label{white-space:nowrap;color:rgba(255,255,255,0.86);font-weight:500;letter-spacing:.012em;transition:color .2s ease}",
    "#ui-status-widget.is-paused .uisw-label{color:rgba(255,255,255,0.5)}",
    "#ui-status-widget .uisw-tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;letter-spacing:0;color:#a5b4fc}",
    "#ui-status-widget.is-paused .uisw-tag{color:rgba(165,180,252,0.45)}",
    // switch: smaller, crisper, with an inset depth on the off-track
    "#ui-status-widget .uisw-switch{position:relative;flex:0 0 auto;width:32px;height:18px;padding:0;margin:0;border:none;border-radius:9px;cursor:pointer;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,0.12);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.07),inset 0 1px 2px rgba(0,0,0,.25);transition:background 200ms cubic-bezier(.4,0,.2,1)}",
    "#ui-status-widget.is-armed .uisw-switch,#ui-status-widget.is-picked .uisw-switch,#ui-status-widget.is-processing .uisw-switch,#ui-status-widget.is-done .uisw-switch{background:linear-gradient(180deg,#5b52ec,#4f46e5);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 1px 3px rgba(79,70,229,.45)}",
    "#ui-status-widget .uisw-switch:hover{background:rgba(255,255,255,0.18)}",
    "#ui-status-widget.is-armed .uisw-switch:hover,#ui-status-widget.is-picked .uisw-switch:hover,#ui-status-widget.is-processing .uisw-switch:hover,#ui-status-widget.is-done .uisw-switch:hover{background:linear-gradient(180deg,#6760ef,#5852e8)}",
    "#ui-status-widget .uisw-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:linear-gradient(180deg,#fff,#eef0f4);box-shadow:0 1px 2px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.06);transition:transform 200ms cubic-bezier(.4,0,.2,1)}",
    "#ui-status-widget.is-armed .uisw-knob,#ui-status-widget.is-picked .uisw-knob,#ui-status-widget.is-processing .uisw-knob,#ui-status-widget.is-done .uisw-knob{transform:translateX(14px)}",
    "#ui-status-widget .uisw-switch:active .uisw-knob{transform:scale(.9)}",
    "#ui-status-widget.is-armed .uisw-switch:active .uisw-knob,#ui-status-widget.is-picked .uisw-switch:active .uisw-knob,#ui-status-widget.is-processing .uisw-switch:active .uisw-knob,#ui-status-widget.is-done .uisw-switch:active .uisw-knob{transform:translateX(14px) scale(.9)}",
    "#ui-status-widget .uisw-switch:focus-visible{outline:2px solid #818cf8;outline-offset:2px}",
    // divider: hairline that fades at both ends — softer than a hard 1px bar
    "#ui-status-widget .uisw-divider{flex:0 0 auto;width:1px;height:14px;background:linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,0.14) 50%,rgba(255,255,255,0));margin:0 1px}",
    "#ui-status-widget .uisw-close{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;margin:0;border:none;border-radius:11px;cursor:pointer;background:transparent;color:rgba(255,255,255,0.4);font-size:13px;line-height:1;-webkit-appearance:none;appearance:none;transition:color .15s ease,background .15s ease}",
    "#ui-status-widget .uisw-close:hover{color:rgba(255,255,255,0.9);background:rgba(255,255,255,0.09)}",
    "#ui-status-widget .uisw-close:active{background:rgba(255,255,255,0.14)}",
    "#ui-status-widget .uisw-close:focus-visible{outline:2px solid #818cf8;outline-offset:2px}",
    // ---- processing / done states (lock box + widget) ----
    // keyframes: indigo light-sweep across the box, an alpha-only border-glow breath,
    // the label's ellipsis dots, and an indigo dot-pulse for the widget.
    "@keyframes uipick-sweep{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}",
    "@keyframes uipick-breath{0%,100%{box-shadow:0 0 0 2px rgba(79,70,229,.30),0 2px 12px rgba(79,70,229,.35)}50%{box-shadow:0 0 0 2px rgba(99,102,241,.55),0 2px 16px rgba(99,102,241,.55)}}",
    "@keyframes uipick-dots{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}",
    "@keyframes uisw-pulse-indigo{0%{box-shadow:0 0 0 0 rgba(99,102,241,.45),0 0 6px rgba(99,102,241,.6)}70%{box-shadow:0 0 0 5px rgba(99,102,241,0),0 0 6px rgba(99,102,241,.6)}100%{box-shadow:0 0 0 5px rgba(99,102,241,0),0 0 6px rgba(99,102,241,.45)}}",
    // lock box PROCESSING: border stays solid indigo; the breath animation beats the inline box-shadow
    "#__ui_pick_sel__.is-processing{border-color:#4f46e5;animation:uipick-breath 1600ms ease-in-out infinite}",
    // sweep: a static clip wrapper holding a moving band (clips the band to the rounded box without clipping the label)
    "#__ui_pick_sweep__{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}",
    "#__ui_pick_sweep_band__{position:absolute;inset:0;pointer-events:none;will-change:transform;background:linear-gradient(100deg,rgba(99,102,241,0) 38%,rgba(129,140,248,0.18) 50%,rgba(99,102,241,0) 62%);animation:uipick-sweep 1500ms cubic-bezier(.4,0,.2,1) infinite}",
    // lock label ellipsis dots (also reused inside the widget label)
    "#__ui_pick_sel_label__ .uipick-dot,#ui-status-widget .uipick-dot{animation:uipick-dots 1200ms ease-in-out infinite}",
    "#__ui_pick_sel_label__ .uipick-dot.uipick-d2,#ui-status-widget .uipick-dot.uipick-d2{animation-delay:160ms}",
    "#__ui_pick_sel_label__ .uipick-dot.uipick-d3,#ui-status-widget .uipick-dot.uipick-d3{animation-delay:320ms}",
    // lock box DONE: emerald flash (!important to beat the sel box's inline border/box-shadow)
    "#__ui_pick_sel__.is-done{transition:border-color .18s ease,box-shadow .18s ease;border-color:#34d399 !important;box-shadow:0 0 0 2px rgba(52,211,153,.35),0 2px 14px rgba(52,211,153,.45) !important}",
    // widget PROCESSING dot: indigo breathing; DONE dot: one emerald pulse
    "#ui-status-widget.is-processing .uisw-dot{background:#6366f1;animation:uisw-pulse-indigo 1.4s cubic-bezier(.4,0,.2,1) infinite}",
    "#ui-status-widget.is-done .uisw-dot{background:#34d399;animation:uisw-pulse 1.4s cubic-bezier(.4,0,.2,1) 1}",
    // reduced motion: no sweep/breath/dots/pulse — static indigo glow, literal ellipsis, instant done
    "@media (prefers-reduced-motion:reduce){#ui-status-widget{animation:none}#ui-status-widget.is-armed .uisw-dot{animation:none;box-shadow:0 0 0 3px rgba(52,211,153,0.18),0 0 6px rgba(52,211,153,.55)}#__ui_pick_sel__.is-processing{animation:none;border:2px dashed #6366f1 !important;box-shadow:0 0 0 2px rgba(99,102,241,.30),0 2px 14px rgba(99,102,241,.40) !important}#__ui_pick_sweep__{display:none}#__ui_pick_sel_label__ .uipick-dot,#ui-status-widget .uipick-dot{animation:none;opacity:1}#ui-status-widget.is-processing .uisw-dot{animation:none;background:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.18),0 0 6px rgba(99,102,241,.6)}#__ui_pick_sel__.is-done{transition:none}#ui-status-widget.is-done .uisw-dot{animation:none}}"
  ].join("\n");

  // toggle = arm vs pause picking (drives the SAME functions used elsewhere)
  function onToggleWidget() {
    try {
      if (!widgetEl) return;
      if (widgetEl.classList.contains("is-paused")) {
        // OFF -> ON: re-arm (clears any pick, re-adds listeners, sets is-armed)
        if (typeof window.__UI_PICK_REARM__ === "function") window.__UI_PICK_REARM__();
        else setWidgetState("armed");
      } else {
        // armed/picked -> OFF: stop listening, clear BOTH highlight boxes (S1: a
        // frozen blue hover box must not linger while the pill says "paused"), keep
        // the pill visible.
        try { stopListening(); } catch (e) {}
        try { resetProcVisual(); } catch (e) {}   // M1: pausing mid-process must not freeze the effect
        try { hl.style.display = "none"; } catch (e) {}
        try { sel.style.display = "none"; } catch (e) {}
        setWidgetState("paused");
      }
    } catch (e) {}
  }
  // close = full exit: signal abort to the runbook poll, tear down, remove the pill
  function onCloseWidget() {
    window.__UI_PICK__ = "cancelled";
    try { resetProcVisual(); } catch (e) {}   // M1: clear processing timers so none fire after close
    try { teardown(); } catch (e) {}
    try { if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl); } catch (e) {}
  }

  // single source of truth for the pill's visual state
  setWidgetState = function (state, tag) {
    try {
      if (!widgetEl) return;
      var label = widgetEl.querySelector(".uisw-label");
      var sw = widgetEl.querySelector(".uisw-switch");
      widgetEl.className = "is-" + state;
      var ct = String(tag || "").toLowerCase().replace(/[^a-z0-9-]/g, "") || "node";
      if (state === "processing") {
        if (label) label.innerHTML = '<span class="uisw-tag">&lt;' + ct + "&gt;</span> applying" +
          (prefersReduce() ? "…" : DOT_SPANS);
        if (sw) sw.setAttribute("aria-checked", "true");
      } else if (state === "done") {
        if (label) label.innerHTML = '<span class="uisw-tag">&lt;' + ct + "&gt;</span> ✓ done";
        if (sw) sw.setAttribute("aria-checked", "true");
      } else if (state === "picked") {
        var t = ct;
        if (label) label.innerHTML = '<span class="uisw-tag">&lt;' + t + "&gt;</span> selected";
        if (sw) sw.setAttribute("aria-checked", "true");
      } else if (state === "paused") {
        if (label) label.innerHTML = '<span class="uisw-tag">/ui</span> paused';
        if (sw) sw.setAttribute("aria-checked", "false");
      } else { // armed
        if (label) label.innerHTML = '<span class="uisw-tag">/ui</span> select mode';
        if (sw) sw.setAttribute("aria-checked", "true");
      }
    } catch (e) {}
  };

  // build once; reuse #ui-status-widget on re-inject instead of stacking duplicates
  try {
    var styleEl = document.getElementById("ui-status-widget-style");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "ui-status-widget-style";
      styleEl.textContent = WIDGET_CSS;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    widgetEl = document.getElementById("ui-status-widget");
    if (!widgetEl) {
      widgetEl = document.createElement("div");
      widgetEl.id = "ui-status-widget";
      widgetEl.className = "is-armed";
      widgetEl.setAttribute("role", "status");
      widgetEl.setAttribute("aria-live", "polite");
      widgetEl.innerHTML =
        '<span class="uisw-dot"></span>' +
        '<span class="uisw-label">/ui select mode</span>' +
        '<button type="button" class="uisw-switch" role="switch" aria-checked="true" aria-label="Toggle /ui select mode"><span class="uisw-knob"></span></button>' +
        '<span class="uisw-divider"></span>' +
        '<button type="button" class="uisw-close" aria-label="Exit /ui select mode">✕</button>';
      (document.body || document.documentElement).appendChild(widgetEl);
      var _sw = widgetEl.querySelector(".uisw-switch");
      var _cl = widgetEl.querySelector(".uisw-close");
      if (_sw) _sw.addEventListener("click", onToggleWidget);
      if (_cl) _cl.addEventListener("click", onCloseWidget);
    }
    setWidgetState("armed"); // install -> armed
  } catch (e) {}
  status.mode = "self-overlay";

  // Bonus path: if the PROJECT ships react-grab's build plugin, getSource returns a
  // trusted line — assemble() already prefers it over _debugSource. We still don't
  // activate the overlay; the project-instrumented case is handled by enrichment.

  // Escape -> cancel + clean up
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { window.__UI_PICK__ = "cancelled"; teardown(); }
  }, true);

  window.__UI_PICK_STATUS__ = status;
  return JSON.stringify(status);
})();
