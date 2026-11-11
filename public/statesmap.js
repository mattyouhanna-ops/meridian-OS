/* Meridian OS — clickable US state map picker.
   Drop-in: MeridianStateMap.build(hostEl, { selected:[...], onChange:fn }) -> api
   api.get() -> ["MI","OH"], api.set([...]), api.clear(), api.selectAll()
   Tiles show the postal abbreviation; tap to toggle; gold = licensed.
   Geographic tile-grid (50 states + DC). No images, no external deps. */
(function () {
  // [code, row, col] on an 11-wide, 8-tall grid (stylized US layout)
  var GRID = [
    ["AK",0,0],["ME",0,10],
    ["VT",1,9],["NH",1,10],
    ["WA",2,0],["ID",2,1],["MT",2,2],["ND",2,3],["MN",2,4],["IL",2,5],["WI",2,6],["MI",2,7],["NY",2,9],["MA",2,10],
    ["OR",3,0],["NV",3,1],["WY",3,2],["SD",3,3],["IA",3,4],["IN",3,5],["OH",3,6],["PA",3,7],["NJ",3,8],["CT",3,9],["RI",3,10],
    ["CA",4,0],["UT",4,1],["CO",4,2],["NE",4,3],["MO",4,4],["KY",4,5],["WV",4,6],["VA",4,7],["MD",4,8],["DE",4,9],
    ["AZ",5,1],["NM",5,2],["KS",5,3],["AR",5,4],["TN",5,5],["NC",5,6],["SC",5,7],["DC",5,8],
    ["OK",6,3],["LA",6,4],["MS",6,5],["AL",6,6],["GA",6,7],
    ["HI",7,0],["TX",7,3],["FL",7,7]
  ];
  var NAMES = {
    AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",
    DE:"Delaware",DC:"Washington DC",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",
    IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",
    MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
    NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",
    OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
    TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",
    WI:"Wisconsin",WY:"Wyoming"
  };
  var FIFTY = GRID.map(function (g) { return g[0]; }).filter(function (c) { return c !== "DC"; }); // 50 states for the milestone

  function injectCSS() {
    if (document.getElementById("usmap-css")) return;
    var s = document.createElement("style");
    s.id = "usmap-css";
    s.textContent =
      ".usmap-wrap{margin-top:8px}" +
      ".usmap{display:grid;grid-template-columns:repeat(11,1fr);gap:4px;max-width:460px}" +
      ".usq{aspect-ratio:1/1;border:1px solid #2a2620;border-radius:7px;background:#141210;" +
        "color:#9a927f;font:700 12px/1 Arial,sans-serif;letter-spacing:.3px;cursor:pointer;padding:0;display:flex;" +
        "align-items:center;justify-content:center;transition:transform .05s,background .12s,border-color .12s;-webkit-tap-highlight-color:transparent}" +
      ".usq:hover{border-color:#8f7426;color:#f3efe6}" +
      ".usq:active{transform:scale(.9)}" +
      ".usq.on{background:linear-gradient(180deg,#f1d78a,#d4af37);border-color:#f1d78a;color:#231c00}" +
      ".usq.dc{border-radius:50%}" +
      ".usmap-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;flex-wrap:wrap}" +
      ".usmap-count{color:#c9c3b5;font:600 13px/1.3 Arial,sans-serif}" +
      ".usmap-count b{color:#f1d78a;font-size:15px}" +
      ".usmap-acts{display:flex;gap:8px}" +
      ".usmap-btn{background:transparent;border:1px solid #2a2620;color:#9a927f;font:600 12px/1 Arial,sans-serif;" +
        "padding:8px 12px;border-radius:8px;cursor:pointer;width:auto}" +
      ".usmap-btn:hover{border-color:#8f7426;color:#f3efe6}" +
      ".usmap-win{margin-top:10px;padding:10px 14px;border:1px solid #8f7426;border-radius:10px;" +
        "background:#1a1708;color:#f1d78a;font:700 13px/1.4 Arial,sans-serif;text-align:center}" +
      ".usmap-hint{color:#6f6a5c;font:400 12px/1.4 Arial,sans-serif;margin:2px 0 0}";
    document.head.appendChild(s);
  }

  function build(host, opts) {
    opts = opts || {};
    injectCSS();
    var selected = {};
    (opts.selected || []).forEach(function (c) { selected[String(c).toUpperCase()] = true; });

    host.classList.remove("stgrid", "stategrid");
    host.classList.add("usmap-wrap");
    host.style.display = "block";
    host.innerHTML = "";

    var grid = document.createElement("div");
    grid.className = "usmap";

    GRID.forEach(function (g) {
      var code = g[0];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "usq" + (code === "DC" ? " dc" : "") + (selected[code] ? " on" : "");
      b.setAttribute("data-code", code);
      b.title = NAMES[code] || code;
      b.textContent = code;
      b.style.gridRow = (g[1] + 1);
      b.style.gridColumn = (g[2] + 1);
      b.addEventListener("click", function () {
        if (selected[code]) delete selected[code]; else selected[code] = true;
        b.classList.toggle("on");
        refresh();
        if (typeof opts.onChange === "function") opts.onChange(getList());
      });
      grid.appendChild(b);
    });

    var foot = document.createElement("div");
    foot.className = "usmap-foot";
    var count = document.createElement("div");
    count.className = "usmap-count";
    var acts = document.createElement("div");
    acts.className = "usmap-acts";
    var allBtn = document.createElement("button");
    allBtn.type = "button"; allBtn.className = "usmap-btn"; allBtn.textContent = "All 50";
    var clrBtn = document.createElement("button");
    clrBtn.type = "button"; clrBtn.className = "usmap-btn"; clrBtn.textContent = "Clear";
    acts.appendChild(allBtn); acts.appendChild(clrBtn);
    foot.appendChild(count); foot.appendChild(acts);

    var win = document.createElement("div");
    win.className = "usmap-win"; win.style.display = "none";
    win.textContent = "🏆  Licensed in all 50 states — fully national.";

    host.appendChild(grid);
    host.appendChild(foot);
    host.appendChild(win);

    function getList() { return Object.keys(selected); }
    function stateCount() { return FIFTY.filter(function (c) { return selected[c]; }).length; }
    function refresh() {
      var n = stateCount();
      count.innerHTML = "<b>" + n + "</b> / 50 states" + (selected.DC ? " + DC" : "");
      win.style.display = n === 50 ? "" : "none";
    }

    allBtn.addEventListener("click", function () {
      FIFTY.forEach(function (c) { selected[c] = true; });
      grid.querySelectorAll(".usq").forEach(function (b) { if (b.getAttribute("data-code") !== "DC") b.classList.add("on"); });
      refresh(); if (typeof opts.onChange === "function") opts.onChange(getList());
    });
    clrBtn.addEventListener("click", function () {
      selected = {};
      grid.querySelectorAll(".usq").forEach(function (b) { b.classList.remove("on"); });
      refresh(); if (typeof opts.onChange === "function") opts.onChange(getList());
    });

    refresh();

    var api = {
      get: getList,
      set: function (arr) {
        selected = {};
        (arr || []).forEach(function (c) { selected[String(c).toUpperCase()] = true; });
        grid.querySelectorAll(".usq").forEach(function (b) {
          b.classList.toggle("on", !!selected[b.getAttribute("data-code")]);
        });
        refresh();
      },
      clear: function () { clrBtn.click(); },
      selectAll: function () { allBtn.click(); }
    };
    host.__stateMap = api;
    return api;
  }

  window.MeridianStateMap = { build: build, NAMES: NAMES };
})();
