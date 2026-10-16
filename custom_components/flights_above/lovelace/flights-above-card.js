/**
 * Flights Above - custom Lovelace card (Ivan's fork)
 * Origin -> plane -> destination progress tracks, a continuously sweeping
 * radar, a Leaflet map of every aircraft in range, and a compact list for
 * flights beyond the first few.
 */

const CARD_VERSION = "2.1.1-ivan";

const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";

const PLANE_SVG = `
<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
  <path fill="currentColor" d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>
</svg>`;

// Escape any value coming from sensor attributes (third-party API data)
// before it is placed into innerHTML.
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// Load Leaflet once per page, shared by every card instance.
let leafletPromise = null;
function loadLeaflet() {
  if (window.L && typeof window.L.map === "function") return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LEAFLET_JS;
      s.onload = () => resolve(window.L);
      s.onerror = () => {
        leafletPromise = null;
        reject(new Error("Leaflet failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return leafletPromise;
}

// Move a point along a heading by distance (great-circle).
function destPoint(lat, lon, headingDeg, km) {
  const R = 6371;
  const d = km / R;
  const th = (headingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 =
    l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (((l2 * 180) / Math.PI + 540) % 360) - 180];
}

// Make sure HA's built-in <ha-map> element is defined. It is lazy-loaded with
// the map card, so ask HA to create a map card once if needed.
async function loadHaMap() {
  if (customElements.get("ha-map")) return;
  if (window.loadCardHelpers) {
    try {
      const helpers = await window.loadCardHelpers();
      await helpers.createCardElement({ type: "map", entities: ["zone.home"] });
    } catch (e) {
      /* the import is what matters, not the card */
    }
  }
  await Promise.race([
    customElements.whenDefined("ha-map"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("ha-map not available")), 10000)),
  ]);
}

function waitFor(check, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Map planes are extrapolated at most this long after the last real update.
const MAX_EXTRAPOLATE_S = 150;

class FlightsAboveCard extends HTMLElement {
  setConfig(config) {
    const showRadar = config.show_radar === true;
    this._config = {
      title: config.title !== undefined ? config.title : "Flights Above",
      entity_prefix: config.entity_prefix || "sensor.flights_above",
      flights: Array.isArray(config.flights) ? config.flights : null,
      count_entity: config.count_entity || null,
      max: Number(config.max) > 0 ? Number(config.max) : 3,
      detailed: config.detailed !== undefined ? Math.max(0, Number(config.detailed) || 0) : 3,
      sort: config.sort === "distance" ? "distance" : "recent",
      show_details: config.show_details !== false,
      show_empty: config.show_empty !== false,
      show_radar: showRadar,
      show_map: config.show_map !== undefined ? config.show_map === true : showRadar,
      default_view: config.default_view === "map" ? "map" : "radar",
      sweep_seconds: Number(config.sweep_seconds) > 0 ? Number(config.sweep_seconds) : 4,
      map_height: Number(config.map_height) > 0 ? Number(config.map_height) : 280,
      // 0 = stay on the selected flight until Back is pressed.
      select_seconds:
        config.select_seconds !== undefined && Number(config.select_seconds) >= 0
          ? Number(config.select_seconds)
          : 30,
      departed: config.departed === "hide" ? "hide" : "dim",
      tile_url: typeof config.tile_url === "string" && config.tile_url ? config.tile_url : null,
      tile_attribution: typeof config.tile_attribution === "string" ? config.tile_attribution : null,
    };
    this._selected = this._selected || null;
    if (!this._view || !this._hasBothViews()) {
      this._view = this._config.show_radar ? this._config.default_view : "map";
      if (!this._config.show_map) this._view = "radar";
    }
    if (!this._built) {
      this.attachShadow({ mode: "open" });
      this._built = true;
    }
    // Config changed: rebuild the skeleton (and the map) on next render.
    this._destroyMap();
    this._skeleton = false;
    this._stamp = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    const dark = Boolean(hass.themes && hass.themes.darkMode);
    if (this._haMap && dark !== this._dark) this._haMap.hass = hass; // older HA only
    this._dark = dark;

    const parts = [];
    const countObj = hass.states[this._countEntityId()];
    if (countObj) parts.push(countObj.last_updated);
    for (const id of this._flightEntityIds()) {
      const s = hass.states[id];
      if (s) parts.push(s.last_updated);
    }
    const dataStamp = parts.join(",");
    const stamp = `${dataStamp}|${this._selected || ""}|${this._view}`;
    if (stamp === this._stamp) return;
    this._stamp = stamp;
    this._render();
  }

  getCardSize() {
    return 6 + (this._config ? Math.min(this._config.max, this._config.detailed) * 3 : 3);
  }

  connectedCallback() {
    if (this._api) {
      setTimeout(() => this._api && this._api.invalidate(), 50);
      this._startTicker();
    }
  }

  disconnectedCallback() {
    if (this._selectTimer) clearTimeout(this._selectTimer);
    this._selectTimer = null;
    this._stopTicker();
  }

  static getStubConfig() {
    return { entity_prefix: "sensor.flights_above", show_radar: true, max: 8 };
  }

  _hasBothViews() {
    return this._config && this._config.show_radar && this._config.show_map;
  }

  _select(callsign) {
    if (!callsign || callsign === "?") return;
    this._selected = callsign === this._selected ? null : callsign;
    if (this._selectTimer) clearTimeout(this._selectTimer);
    if (this._selected && this._config.select_seconds > 0) {
      this._selectTimer = setTimeout(() => {
        this._selected = null;
        this._selectTimer = null;
        this._stamp = null;
        this._render();
      }, this._config.select_seconds * 1000);
    }
    this._stamp = null;
    this._render();
  }

  _clearSelection() {
    if (this._selectTimer) clearTimeout(this._selectTimer);
    this._selectTimer = null;
    this._selected = null;
    this._stamp = null;
    this._render();
  }

  _setView(view) {
    if (view === this._view) return;
    this._view = view;
    this._stamp = null;
    this._render();
  }

  _flightEntityIds() {
    if (this._config.flights) return this._config.flights;
    // Probe every possible slot so sorting can consider all of them.
    const ids = [];
    const n = Math.max(10, this._config.max);
    for (let i = 1; i <= n; i++) ids.push(`${this._config.entity_prefix}_flight_${i}`);
    return ids;
  }

  _countEntityId() {
    return this._config.count_entity || `${this._config.entity_prefix}_flights_overhead`;
  }

  _fmtHours(h) {
    if (h === null || h === undefined) return null;
    return `${Number(h).toFixed(1)}h`;
  }

  _clampPercent(p) {
    if (p === null || p === undefined || isNaN(p)) return null;
    return Math.max(0, Math.min(100, Number(p)));
  }

  /* ---------------- flight detail (unchanged layout) ---------------- */

  _renderFlight(stateObj, departed = false) {
    const a = stateObj.attributes;
    const callsign = esc(stateObj.state);
    const origin = esc(a.origin_iata || a.origin_icao || "???");
    const dest = esc(a.destination_iata || a.destination_icao || "???");
    const originName = esc(a.origin_name || "");
    const destName = esc(a.destination_name || "");
    const originCountry = esc(a.origin_country || "");
    const destCountry = esc(a.destination_country || "");
    const pct = this._clampPercent(a.progress_percent);
    const planePos = pct === null ? 50 : Math.max(4, Math.min(96, pct));
    const knownRoute = a.progress_percent !== null && a.progress_percent !== undefined;

    const flown = this._fmtHours(a.hours_flown);
    const left = this._fmtHours(a.hours_remaining);
    const total = this._fmtHours(a.hours_total);

    const chips = [];
    if (departed) chips.push("left the area");
    else if (a.distance_km !== null && a.distance_km !== undefined) chips.push(`${a.distance_km} km away`);
    if (a.altitude_ft) chips.push(`${Number(a.altitude_ft).toLocaleString()} ft`);
    if (a.ground_speed_kmh) chips.push(`${Math.round(a.ground_speed_kmh)} km/h`);
    if (a.people_on_board) chips.push(`≈ ${a.people_on_board} on board`);
    if (a.climb_status && a.climb_status !== "level")
      chips.push(a.climb_status === "climbing" ? "↑ climbing" : "↓ descending");
    if (a.co2_total_kg) chips.push(`${Number(a.co2_total_kg).toLocaleString()} kg CO₂`);
    if (a.eta) {
      const t = new Date(a.eta);
      if (!isNaN(t)) chips.push(`ETA ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    }

    const subtitle = this._config.show_details
      ? esc([a.aircraft_type, a.registration].filter(Boolean).join(" · "))
      : "";

    return `
      <div class="flight ${departed ? "departed" : ""}">
        <div class="row head">
          <div class="callsign">${callsign}</div>
          ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ""}
        </div>
        <div class="row airports">
          <div class="airport left">
            <div class="code">${origin}</div>
            <div class="aname">${originName}</div>
            ${originCountry ? `<div class="acountry">${originCountry}</div>` : ""}
          </div>
          <div class="airport right">
            <div class="code">${dest}</div>
            <div class="aname">${destName}</div>
            ${destCountry ? `<div class="acountry">${destCountry}</div>` : ""}
          </div>
        </div>
        <div class="track ${knownRoute ? "" : "unknown"}">
          <div class="line"></div>
          <div class="fill" style="width:${pct === null ? 0 : pct}%"></div>
          <div class="dot origin"></div>
          <div class="dot dest"></div>
          <div class="plane" style="left:${planePos}%">${PLANE_SVG}</div>
        </div>
        <div class="row hours">
          <div class="h left">${flown ? `${flown} flown` : ""}</div>
          <div class="h mid">${pct === null ? "route unknown" : `${Math.round(pct)}%`}</div>
          <div class="h right">${left ? `${left} left` : ""}</div>
        </div>
        ${total ? `<div class="total">${total} total flight time</div>` : ""}
        ${
          this._config.show_details && chips.length
            ? `<div class="chips">${chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>`
            : ""
        }
      </div>`;
  }

  _renderCompact(stateObj, departed = false) {
    const a = stateObj.attributes;
    const origin = a.origin_iata || a.origin_icao || "???";
    const dest = a.destination_iata || a.destination_icao || "???";
    const pct = this._clampPercent(a.progress_percent);
    const dist = departed
      ? "left"
      : a.distance_km !== null && a.distance_km !== undefined
        ? `${a.distance_km} km`
        : "";
    return `
      <div class="crow ${departed ? "departed" : ""}" data-cs="${esc(stateObj.state)}">
        <span class="ccs">${esc(stateObj.state)}</span>
        <div class="cmid">
          <div class="croute">${esc(origin)} → ${esc(dest)}</div>
          <div class="cbar"><i style="width:${pct === null ? 0 : pct}%"></i></div>
        </div>
        <span class="cdist">${esc(dist)}</span>
      </div>`;
  }

  _renderBlipDetail(b) {
    const chips = [];
    if (b.distance_km !== null && b.distance_km !== undefined) chips.push(`${b.distance_km} km away`);
    if (b.altitude_ft) chips.push(`${Number(b.altitude_ft).toLocaleString()} ft`);
    if (b.speed_kmh) chips.push(`${b.speed_kmh} km/h`);
    if (b.bearing !== null && b.bearing !== undefined) chips.push(`Bearing ${b.bearing}°`);
    if (b.heading !== null && b.heading !== undefined) chips.push(`Heading ${b.heading}°`);
    return `
      <div class="flight">
        <div class="row head"><div class="callsign">${esc(b.callsign)}</div></div>
        <div class="summary">No route details for this aircraft yet, it is not one of the tracked flights.</div>
        ${chips.length ? `<div class="chips">${chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : ""}
      </div>`;
  }

  /* ---------------- radar ---------------- */

  _renderRadar(countObj) {
    const a = (countObj && countObj.attributes) || {};
    const radius = Number(a.radius_km) || 0;
    const blips = Array.isArray(a.radar) ? a.radar : [];
    if (!radius) return "";

    // Phase-lock every animation to the wall clock, so re-renders never
    // restart the sweep and each blip lights up exactly when it is crossed.
    const P = this._config.sweep_seconds;
    const phase = (Date.now() / 1000) % P;
    const delayFor = (fraction) => {
      const x = fraction * P - phase;
      return (((x % P) + P) % P) - P;
    };

    const R = 86, cx = 100, cy = 100;
    const showLabels = blips.length > 0 && blips.length <= 8;
    const pos = blips.map((b) => {
      const dist = Math.max(0, Math.min(Number(b.distance_km) || 0, radius));
      const d = (dist / radius) * R;
      const th = ((Number(b.bearing) || 0) * Math.PI) / 180;
      return { x: cx + d * Math.sin(th), y: cy - d * Math.cos(th), dist };
    });

    // Place labels so they never overlap: selected first, then nearest.
    // Each label tries the right side, then the left (left first near the
    // right edge); if both collide it is skipped (the selected one never is).
    const labels = new Map();
    const boxes = [];
    const hit = (bx) =>
      bx.x < 2 || bx.x + bx.w > 198 ||
      boxes.some((o) => bx.x < o.x + o.w && bx.x + bx.w > o.x && bx.y < o.y + o.h && bx.y + bx.h > o.y);
    blips
      .map((b, i) => i)
      .sort((i, j) => {
        const si = blips[i].callsign === this._selected ? 0 : 1;
        const sj = blips[j].callsign === this._selected ? 0 : 1;
        return si - sj || pos[i].dist - pos[j].dist;
      })
      .forEach((i) => {
        const b = blips[i];
        const selected = this._selected && b.callsign === this._selected;
        if (!showLabels && !selected) return;
        const { x, y } = pos[i];
        const w = String(b.callsign).length * 5.4 + 2;
        const right = { x: x + 7, y: y - 5, w, h: 10, tx: x + 8, anchor: "start" };
        const left = { x: x - 7 - w, y: y - 5, w, h: 10, tx: x - 8, anchor: "end" };
        const order = x > 140 ? [left, right] : [right, left];
        const pick = order.find((bx) => !hit(bx)) || (selected ? order[0] : null);
        if (pick) {
          boxes.push(pick);
          labels.set(i, pick);
        }
      });

    const marks = blips
      .map((b, i) => {
        const { x, y } = pos[i];
        const brg = Number(b.bearing) || 0;
        const selected = this._selected && b.callsign === this._selected;
        const delay = `${delayFor(brg / 360).toFixed(2)}s`;

        let track = "";
        const hd = Number(b.heading);
        if (b.heading !== null && b.heading !== undefined && !isNaN(hd)) {
          const hr = (hd * Math.PI) / 180;
          track = `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 12 * Math.sin(hr)).toFixed(1)}" y2="${(y - 12 * Math.cos(hr)).toFixed(1)}" class="heading ${selected ? "sel" : ""}"/>`;
        }
        const lp = labels.get(i);
        const label = lp
          ? `<text x="${lp.tx.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="${lp.anchor}" class="blip-label ${selected ? "sel" : ""}">${esc(b.callsign)}</text>`
          : "";
        return `
          <g class="bg ${selected ? "sel" : ""}" style="animation-delay:${delay}">
            ${track}
            <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${selected ? 6 : 4}" class="blip ${selected ? "sel" : ""}"/>
            ${label}
          </g>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="ping" style="animation-delay:${delay}"/>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" class="hit" data-cs="${esc(b.callsign)}"/>`;
      })
      .join("");

    const total = countObj ? countObj.state : blips.length;
    return `
      <svg viewBox="0 0 200 200" role="img" aria-label="Aircraft around your location">
        <circle cx="100" cy="100" r="86" class="ring"/>
        <circle cx="100" cy="100" r="57" class="ring"/>
        <circle cx="100" cy="100" r="28" class="ring"/>
        <line x1="100" y1="14" x2="100" y2="186" class="cross"/>
        <line x1="14" y1="100" x2="186" y2="100" class="cross"/>
        <text x="100" y="11" text-anchor="middle" class="dir">N</text>
        <text x="196" y="103" text-anchor="end" class="dir">E</text>
        <text x="100" y="196" text-anchor="middle" class="dir">S</text>
        <text x="4" y="103" text-anchor="start" class="dir">W</text>
        <g class="sweep" style="animation-duration:${P}s;animation-delay:${delayFor(0).toFixed(2)}s">
          <path class="w3" d="M100,100 L50.67,29.55 A86,86 0 0,1 70.59,19.19 Z"/>
          <path class="w2" d="M100,100 L70.59,19.19 A86,86 0 0,1 85.07,15.31 Z"/>
          <path class="w1" d="M100,100 L85.07,15.31 A86,86 0 0,1 100,14 Z"/>
          <line x1="100" y1="100" x2="100" y2="14"/>
        </g>
        <circle cx="100" cy="100" r="3.5" class="home"/>
        ${marks}
      </svg>
      <div class="radar-caption">${esc(total)} in range · ${esc(radius)} km radius</div>`;
  }

  /* ---------------- map ---------------- */
  //
  // The map draws through a small adapter (this._api) so the same code runs
  // on HA's built-in <ha-map> (new MapLibre engine API or older Leaflet
  // versions) and on an own Leaflet map with a custom tile_url.

  _ensureMap() {
    if (this._api || this._mapLoading || this._mapFailed) return;
    if (this._config.tile_url) this._ensureOwnMap();
    else this._ensureHaMap();
  }

  _ensureHaMap() {
    const holder = this.shadowRoot.getElementById("map");
    if (!holder) return;
    this._mapLoading = true;
    loadHaMap()
      .then(() => {
        const hm = document.createElement("ha-map");
        hm.style.display = "block";
        hm.style.height = "100%";
        // Older HA versions take hass as a property; newer ones read it
        // from context on their own. Setting it is harmless either way.
        hm.hass = this._hass;
        hm.entities = [];
        hm.autoFit = false;
        hm.zoom = 10;
        hm.zoomPosition = "bottomright";
        holder.appendChild(hm);
        this._haMap = hm;
        return waitFor(() => this._haApi(hm), 15000);
      })
      .then((api) => {
        this._mapLoading = false;
        this._api = api;
        this._afterMapReady();
      })
      .catch((err) => this._mapError(err, "HA's map component isn't available here."));
  }

  // Build the adapter for whichever ha-map internals this HA version has.
  _haApi(hm) {
    const engine = hm._engine;
    if (engine && typeof engine.addMarker === "function") {
      return {
        kind: "engine",
        engine,
        marker: (el, ll, opts) => {
          let h = engine.addMarker(el, ll, opts);
          return {
            move: (p) => {
              // Current engines can move a marker in place; otherwise re-add.
              if (typeof h.setLocation === "function") h.setLocation(p);
              else {
                h.remove();
                h = engine.addMarker(el, p, opts);
              }
            },
            remove: () => h.remove(),
          };
        },
        circle: (center, radiusM, color) => {
          const h = engine.addCircle(center, { radius: radiusM, color });
          return { remove: () => h.remove() };
        },
        fit: (points) => hm.fitBounds(points, { pad: 0.05, zoom: 14 }),
        invalidate: () => engine.invalidateSize && engine.invalidateSize(),
        alive: () => hm._engine === engine,
      };
    }
    if (hm.leafletMap && hm.Leaflet) return this._leafletApi(hm.Leaflet, hm.leafletMap, "ha-leaflet");
    return null;
  }

  _leafletApi(L, map, kind) {
    return {
      kind,
      marker: (el, ll, opts) => {
        const m = L.marker(ll, {
          icon: L.divIcon({
            html: el,
            className: "",
            iconSize: opts.size,
            iconAnchor: opts.anchor || [opts.size[0] / 2, opts.size[1] / 2],
          }),
          keyboard: false,
          interactive: opts.interactive !== false,
          zIndexOffset: opts.raised ? 1000 : 0,
        }).addTo(map);
        return { move: (p) => m.setLatLng(p), remove: () => map.removeLayer(m) };
      },
      circle: (center, radiusM, color) => {
        const c = L.circle(center, {
          radius: radiusM, color, weight: 1.5, dashArray: "5 5",
          fillColor: color, fillOpacity: 0.04, interactive: false,
        }).addTo(map);
        return { remove: () => map.removeLayer(c) };
      },
      fit: (points) => map.fitBounds(points, { padding: [8, 8] }),
      invalidate: () => map.invalidateSize(),
      alive: () => true,
    };
  }

  // Optional: own Leaflet map with a custom tile server (config: tile_url).
  _ensureOwnMap() {
    const el = this.shadowRoot.getElementById("map");
    if (!el) return;
    this._mapLoading = true;
    Promise.all([loadLeaflet(), this._cssReady])
      .then(([L]) => {
        this._mapLoading = false;
        if (!this.shadowRoot.contains(el)) return;
        const map = L.map(el, {
          zoomControl: false,
          attributionControl: false,
          scrollWheelZoom: false,
          dragging: !L.Browser.mobile,
          zoomSnap: 0.25,
        });
        L.control.zoom({ position: "bottomright" }).addTo(map);
        L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);
        const cfg = this._hass.config || {};
        map.setView([Number(cfg.latitude) || 45.8, Number(cfg.longitude) || 16], 10);
        L.tileLayer(this._config.tile_url, {
          maxZoom: 19,
          attribution: this._config.tile_attribution || "© OpenStreetMap contributors",
        }).addTo(map);
        this._ownMap = map;
        this._api = this._leafletApi(L, map, "own-leaflet");
        this._afterMapReady();
      })
      .catch((err) => this._mapError(err, "Map couldn't load. Check the device's internet access."));
  }

  _afterMapReady() {
    this._markers = new Map();
    this._homeItems = null;
    this._homeKey = null;
    this._updateMap(true);
    setTimeout(() => this._api && this._api.invalidate(), 50);
    this._startTicker();
  }

  _mapError(err, text) {
    // eslint-disable-next-line no-console
    console.warn("flights-above-card: map failed", err);
    this._mapLoading = false;
    this._mapFailed = true;
    const note = this.shadowRoot.getElementById("mapnote");
    if (note) note.textContent = text;
  }

  _destroyMap() {
    this._stopTicker();
    if (this._haMap) this._haMap.remove();
    if (this._ownMap) this._ownMap.remove();
    this._haMap = null;
    this._ownMap = null;
    this._api = null;
    this._markers = null;
    this._homeItems = null;
    this._homeKey = null;
    this._mapLoading = false;
    this._mapFailed = false;
  }

  _startTicker() {
    if (this._ticker || !this._api) return;
    this._ticker = setInterval(() => {
      if (this._view !== "map" || !this._api) return;
      // HA can rebuild its map engine (theme or style change, WebGL loss);
      // our items die with the old one, so put everything back.
      if (!this._api.alive()) {
        const fresh = this._haMap ? this._haApi(this._haMap) : null;
        if (!fresh) return;
        this._api = fresh;
        this._markers = new Map();
        this._homeItems = null;
        this._homeKey = null;
        this._updateMap(true);
        return;
      }
      this._moveMarkers();
    }, 1000);
  }

  _stopTicker() {
    if (this._ticker) clearInterval(this._ticker);
    this._ticker = null;
  }

  _cssColor(name, fallback) {
    const v = getComputedStyle(this).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Plane marker: an element with inline styles only, so it looks the same
  // in whatever shadow root the map engine puts it.
  _planeElement(b, selected) {
    const color = selected
      ? this._cssColor("--primary-text-color", "#fff")
      : this._cssColor("--primary-color", "#03a9f4");
    const halo = this._cssColor("--card-background-color", "#1c1c1c");
    const hd = Number(b.heading);
    const rot = b.heading !== null && b.heading !== undefined && !isNaN(hd) ? hd : 0;
    const el = document.createElement("div");
    el.style.cssText = "position:relative;width:24px;height:24px;cursor:pointer;";
    el.innerHTML = `
      <svg viewBox="-9 -9 18 18" width="24" height="24" style="display:block;transform:rotate(${rot}deg)">
        <path d="M0,-8 L6,7 L0,3.5 L-6,7 Z" fill="${esc(color)}" stroke="${esc(halo)}" stroke-width="1"/>
      </svg>
      <span style="position:absolute;left:24px;top:4px;white-space:nowrap;font-size:11px;font-weight:500;
        font-family:var(--ha-font-family-body, Roboto, sans-serif);color:${esc(this._cssColor("--primary-text-color", "#fff"))};
        text-shadow:0 0 3px ${esc(halo)},0 0 3px ${esc(halo)};pointer-events:none">${esc(b.callsign)}</span>`;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._select(b.callsign);
    });
    return el;
  }

  _updateMap(fit) {
    if (!this._api) return;
    const api = this._api;
    const countObj = this._hass.states[this._countEntityId()];
    const a = (countObj && countObj.attributes) || {};
    const blips = Array.isArray(a.radar) ? a.radar : [];
    const home = [Number(a.latitude), Number(a.longitude)];
    const radiusKm = Number(a.radius_km) || 0;

    if (!isNaN(home[0]) && !isNaN(home[1]) && radiusKm) {
      const key = `${home[0]},${home[1]},${radiusKm}`;
      if (this._homeKey !== key) {
        if (this._homeItems) this._homeItems.forEach((h) => h.remove());
        const dot = document.createElement("div");
        dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${this._cssColor("--primary-text-color", "#fff")};border:2px solid ${this._cssColor("--card-background-color", "#1c1c1c")};box-sizing:border-box;`;
        this._homeItems = [
          api.circle(home, radiusKm * 1000, this._cssColor("--primary-color", "#03a9f4")),
          api.marker(dot, home, { size: [10, 10], interactive: false }),
        ];
        this._homeKey = key;
        fit = true;
      }
      if (fit) {
        api.fit([0, 90, 180, 270].map((brg) => destPoint(home[0], home[1], brg, radiusKm)));
      }
    }

    this._baseTime = countObj ? Date.parse(countObj.last_updated) : Date.now();
    const seen = new Set();
    blips.forEach((b, i) => {
      const lat = Number(b.lat), lon = Number(b.lon);
      if (b.lat === undefined || isNaN(lat) || isNaN(lon)) return;
      const key = b.hex || `${b.callsign}-${i}`;
      seen.add(key);
      const selected = Boolean(this._selected && b.callsign === this._selected);
      const sig = `${b.callsign}|${b.heading}|${selected}`;
      let m = this._markers.get(key);
      if (m && m.sig !== sig) {
        m.handle.remove();
        m = null;
      }
      if (!m) {
        const opts = { size: [24, 24], raised: selected, title: b.callsign, nativeTitle: false };
        m = { handle: api.marker(this._planeElement(b, selected), [lat, lon], opts), sig };
        this._markers.set(key, m);
      }
      m.blip = b;
    });
    for (const [key, m] of this._markers) {
      if (!seen.has(key)) {
        m.handle.remove();
        this._markers.delete(key);
      }
    }
    this._moveMarkers();

    const withPos = blips.filter((b) => b.lat !== undefined).length;
    const note = this.shadowRoot.getElementById("mapnote");
    if (note) {
      note.textContent =
        blips.length && !withPos
          ? "No positions in the data yet. Update the integration's coordinator."
          : this._selected
            ? `Showing ${this._selected}`
            : "Tap a plane to see its details";
    }
  }

  // Dead-reckon each plane from its last reported position, speed and heading.
  _moveMarkers() {
    if (!this._markers) return;
    let elapsed = (Date.now() - (this._baseTime || Date.now())) / 1000;
    elapsed = Math.max(0, Math.min(elapsed, MAX_EXTRAPOLATE_S));
    for (const m of this._markers.values()) {
      const b = m.blip;
      let pos = [Number(b.lat), Number(b.lon)];
      const spd = Number(b.speed_kmh), hd = Number(b.heading);
      if (spd > 0 && !isNaN(hd) && b.heading !== null) {
        pos = destPoint(pos[0], pos[1], hd, (spd * elapsed) / 3600);
      }
      m.handle.move(pos);
    }
  }

  /* ---------------- render ---------------- */

  _buildSkeleton() {
    const both = this._hasBothViews();
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div id="hdr"></div>
        ${
          both
            ? `<div class="toggle">
                 <button data-v="radar">Radar</button>
                 <button data-v="map">Map</button>
               </div>`
            : ""
        }
        ${this._config.show_radar ? `<div id="radar" class="radar"></div>` : ""}
        ${
          this._config.show_map
            ? `<div id="mapwrap" class="mapwrap">
                 <div id="map" style="height:${this._config.map_height}px"></div>
                 <div id="mapnote" class="radar-note"></div>
               </div>`
            : ""
        }
        <div id="content" class="content"></div>
      </ha-card>`;

    this._cssReady = Promise.resolve();
    if (this._config.show_map && this._config.tile_url) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      this._cssReady = new Promise((resolve) => {
        link.onload = resolve;
        link.onerror = resolve;
      });
      this.shadowRoot.prepend(link);
    }

    this.shadowRoot.querySelectorAll(".toggle button").forEach((btn) =>
      btn.addEventListener("click", () => this._setView(btn.getAttribute("data-v")))
    );
    this.shadowRoot.getElementById("content").addEventListener("click", (ev) => {
      if (ev.target.closest(".back")) {
        this._clearSelection();
        return;
      }
      const row = ev.target.closest(".crow");
      if (row) this._select(row.getAttribute("data-cs"));
    });
    const radarEl = this.shadowRoot.getElementById("radar");
    if (radarEl) {
      radarEl.addEventListener("click", (ev) => {
        const hit = ev.target.closest(".hit");
        if (hit) this._select(hit.getAttribute("data-cs"));
      });
    }
    this._skeleton = true;
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._skeleton) this._buildSkeleton();
    const root = this.shadowRoot;

    const available = this._flightEntityIds()
      .map((id) => this._hass.states[id])
      .filter(
        (s) =>
          s &&
          s.state &&
          !["unknown", "unavailable", "None"].includes(s.state) &&
          s.attributes.in_range !== false
      );

    const countObj = this._hass.states[this._countEntityId()];
    const radarList =
      countObj && Array.isArray(countObj.attributes.radar) ? countObj.attributes.radar : [];

    // Slots hold every flight seen in the last 30 minutes. Anything that is
    // not in the live radar list has already left the radius.
    const inRange = new Set(radarList.map((b) => b.callsign));
    const hasRadar = Boolean(countObj && Array.isArray(countObj.attributes.radar));
    const isDeparted = (s) => (hasRadar ? !inRange.has(s.state) : false);

    let current = available.filter((s) => !isDeparted(s));
    let departed = available.filter((s) => isDeparted(s));
    if (this._config.sort === "distance") {
      const d = (s) => {
        const v = s.attributes.distance_km;
        return v === null || v === undefined ? Infinity : Number(v);
      };
      current.sort((a, b) => d(a) - d(b));
    }
    if (this._config.departed === "hide") departed = [];
    const flights = [...current, ...departed].slice(0, this._config.max);
    const count = countObj ? countObj.state : current.length;

    // Header
    root.getElementById("hdr").innerHTML = this._config.title
      ? `<div class="card-header"><span>${esc(this._config.title)}</span><span class="count">${esc(count)}</span></div>`
      : "";

    // View switching
    const both = this._hasBothViews();
    const view = both ? this._view : this._config.show_radar ? "radar" : "map";
    root.querySelectorAll(".toggle button").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-v") === view)
    );
    const radarEl = root.getElementById("radar");
    const mapWrap = root.getElementById("mapwrap");
    if (radarEl) {
      radarEl.classList.toggle("hidden", view !== "radar");
      if (view === "radar") {
        radarEl.innerHTML =
          this._renderRadar(countObj) +
          `<div class="radar-note">${
            this._selected
              ? `Showing ${esc(this._selected)}`
              : "Tap a plane to see its details"
          }</div>`;
      }
    }
    if (mapWrap) {
      const wasHidden = mapWrap.classList.contains("hidden");
      mapWrap.classList.toggle("hidden", view !== "map");
      if (view === "map") {
        if (!this._api) this._ensureMap();
        else {
          if (wasHidden) setTimeout(() => this._api && this._api.invalidate(), 30);
          this._updateMap(false);
        }
      }
    }

    // Detail area
    let body = "";
    if (this._selected) {
      const match = available.find((s) => s.state === this._selected);
      if (match) body = this._renderFlight(match, isDeparted(match));
      else {
        const blip = radarList.find((b) => b.callsign === this._selected);
        body = blip ? this._renderBlipDetail(blip) : "";
      }
      if (body) {
        body =
          `<button class="back" type="button"><ha-icon icon="mdi:arrow-left"></ha-icon><span>All flights</span></button>` +
          body;
      } else {
        // The selected aircraft vanished from the data: drop the selection.
        this._selected = null;
      }
    }
    if (!body) {
      if (flights.length) {
        // Full cards only for aircraft that are in range right now; everything
        // else (extra flights and ones that already left) goes compact.
        const n = this._config.detailed;
        const live = flights.filter((s) => !isDeparted(s));
        const big = live.slice(0, n).map((s) => this._renderFlight(s, false)).join("");
        const rest = [...live.slice(n), ...flights.filter((s) => isDeparted(s))];
        const small = rest.length
          ? `<div class="compact">${rest.map((s) => this._renderCompact(s, isDeparted(s))).join("")}</div>`
          : "";
        body = big + small;
      } else if (this._config.show_empty) {
        body = `<div class="empty">No flights currently in range.</div>`;
      }
    }
    root.getElementById("content").innerHTML = body;
  }

  _styles() {
    return `
      ha-card { overflow: hidden; }
      .hidden { display: none !important; }
      .card-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 16px 8px; font-size: 1.35rem; font-weight: 500;
        color: var(--ha-card-header-color, var(--primary-text-color));
      }
      .card-header .count {
        font-size: 0.85rem; font-weight: 500; padding: 2px 10px;
        border-radius: 12px; background: var(--primary-color); color: var(--text-primary-color, #fff);
      }
      .toggle {
        display: flex; margin: 4px 16px 8px; padding: 3px; gap: 3px;
        border-radius: 10px; background: var(--secondary-background-color);
      }
      .toggle button {
        flex: 1; border: none; background: transparent; cursor: pointer;
        padding: 6px 0; border-radius: 8px; font: inherit; font-size: 0.85rem;
        color: var(--secondary-text-color);
      }
      .toggle button.active {
        background: var(--card-background-color, var(--ha-card-background, #fff));
        color: var(--primary-text-color); font-weight: 500;
      }
      .content { padding: 0 16px 12px; }
      .flight { padding: 12px 0; border-top: 1px solid var(--divider-color); }
      .content > .flight:first-child { border-top: none; }
      .row { display: flex; align-items: baseline; justify-content: space-between; }
      .head { margin-bottom: 8px; }
      .callsign {
        font-size: 1.25rem; font-weight: 600; letter-spacing: 0.5px; color: var(--primary-text-color);
      }
      .subtitle {
        font-size: 0.8rem; color: var(--secondary-text-color);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
      }
      .airports { margin-bottom: 6px; align-items: flex-start; gap: 10px; }
      .airport { max-width: 48%; min-width: 0; }
      .airport.right { text-align: right; }
      .airport .code {
        font-size: 1.05rem; font-weight: 700; color: var(--primary-text-color);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .airport .aname {
        font-size: 0.72rem; color: var(--secondary-text-color);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .airport .acountry {
        font-size: 0.66rem; color: var(--secondary-text-color); opacity: 0.8;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .track { position: relative; height: 26px; margin: 6px 6px 2px; }
      .track .line, .track .fill {
        position: absolute; top: 50%; height: 3px; border-radius: 3px; transform: translateY(-50%);
      }
      .track .line { left: 0; right: 0; background: var(--divider-color); }
      .track .fill { left: 0; background: var(--primary-color); transition: width 1.2s ease; }
      .track.unknown .fill { background: var(--disabled-text-color, #9e9e9e); }
      .dot {
        position: absolute; top: 50%; width: 11px; height: 11px; border-radius: 50%;
        transform: translate(-50%, -50%); background: var(--primary-text-color);
        border: 2px solid var(--card-background-color, var(--ha-card-background, #fff));
      }
      .dot.origin { left: 0; }
      .dot.dest { left: 100%; }
      .plane {
        position: absolute; top: 50%; transform: translate(-50%, -50%);
        color: var(--primary-color); line-height: 0; transition: left 1.2s ease;
        filter: drop-shadow(0 1px 1px rgba(0,0,0,0.3));
      }
      .track.unknown .plane { color: var(--disabled-text-color, #9e9e9e); }
      .plane svg { transform: rotate(45deg); display: block; }
      .hours { margin-top: 6px; font-size: 0.8rem; color: var(--secondary-text-color); }
      .hours .mid { color: var(--primary-color); font-weight: 600; }
      .hours .right { text-align: right; }
      .total { text-align: center; font-size: 0.72rem; color: var(--secondary-text-color); margin-top: 2px; }
      .chips { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
      .chips span {
        font-size: 0.72rem; padding: 2px 8px; border-radius: 10px; white-space: nowrap;
        background: var(--secondary-background-color); color: var(--secondary-text-color);
      }
      .flight.departed, .crow.departed { opacity: 0.5; }
      .back {
        display: inline-flex; align-items: center; gap: 6px; margin: 4px 0 2px;
        padding: 6px 12px 6px 8px; border: none; border-radius: 16px; cursor: pointer;
        font: inherit; font-size: 0.85rem; font-weight: 500;
        background: var(--secondary-background-color); color: var(--primary-text-color);
      }
      .back ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
      .back + .flight { border-top: none; }
      .empty { padding: 24px 8px; text-align: center; color: var(--secondary-text-color); }
      .summary { margin-top: 6px; font-size: 0.85rem; color: var(--secondary-text-color); }

      .compact { border-top: 1px solid var(--divider-color); padding-top: 4px; }
      .crow {
        display: grid; grid-template-columns: 84px minmax(0, 1fr) 60px; gap: 10px;
        align-items: center; padding: 8px 0; cursor: pointer;
        border-top: 1px solid var(--divider-color); font-size: 0.85rem;
      }
      .compact .crow:first-child { border-top: none; }
      .ccs { font-weight: 600; color: var(--primary-text-color); }
      .croute { color: var(--secondary-text-color); font-size: 0.8rem; }
      .cbar {
        position: relative; height: 3px; margin-top: 5px; border-radius: 3px;
        background: var(--divider-color);
      }
      .cbar i {
        position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px;
        background: var(--primary-color);
      }
      .cdist { text-align: right; color: var(--secondary-text-color); font-size: 0.8rem; }

      .radar { padding: 6px 16px 2px; display: flex; flex-direction: column; align-items: center; }
      .radar svg { width: 100%; max-width: 250px; height: auto; }
      .radar .ring, .radar .cross { fill: none; stroke: var(--divider-color); stroke-width: 1; }
      .radar .dir { fill: var(--secondary-text-color); font-size: 11px; }
      .radar .home { fill: var(--primary-text-color); }
      .radar .blip { fill: var(--primary-color); }
      .radar .blip.sel { fill: var(--primary-text-color); }
      .radar .heading { stroke: var(--primary-color); stroke-width: 2; stroke-linecap: round; }
      .radar .heading.sel { stroke: var(--primary-text-color); }
      .radar .blip-label { fill: var(--secondary-text-color); font-size: 9px; }
      .radar .blip-label.sel { fill: var(--primary-text-color); font-weight: 700; }
      .radar .hit { fill: transparent; cursor: pointer; }
      .radar .sweep {
        transform-box: view-box; transform-origin: 100px 100px;
        animation-name: fa-spin; animation-timing-function: linear;
        animation-iteration-count: infinite; pointer-events: none;
      }
      .radar .sweep line { stroke: var(--primary-color); stroke-width: 2; stroke-linecap: round; }
      .radar .sweep path { fill: var(--primary-color); }
      .radar .sweep .w1 { opacity: 0.28; }
      .radar .sweep .w2 { opacity: 0.15; }
      .radar .sweep .w3 { opacity: 0.07; }
      .radar .bg {
        animation: fa-glow ${this._config.sweep_seconds}s linear infinite;
      }
      .radar .bg.sel { animation: none; }
      .radar .ping {
        fill: none; stroke: var(--primary-color); stroke-width: 1; opacity: 0;
        transform-box: fill-box; transform-origin: center; pointer-events: none;
        animation: fa-ping ${this._config.sweep_seconds}s ease-out infinite;
      }
      @keyframes fa-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes fa-glow { 0% { opacity: 1; } 25% { opacity: 1; } 100% { opacity: 0.35; } }
      @keyframes fa-ping {
        0% { opacity: 0.9; transform: scale(1); }
        25% { opacity: 0; transform: scale(2.8); }
        100% { opacity: 0; transform: scale(2.8); }
      }
      @media (prefers-reduced-motion: reduce) {
        .radar .sweep, .radar .ping { animation: none; opacity: 0; }
        .radar .bg { animation: none; }
      }
      .radar-caption { margin-top: 12px; font-size: 0.75rem; color: var(--secondary-text-color); }
      .radar-note {
        margin-top: 2px; font-size: 0.7rem; color: var(--secondary-text-color);
        opacity: 0.8; text-align: center;
      }

      .mapwrap { padding: 2px 16px 6px; }
      #map {
        width: 100%; border-radius: 12px; overflow: hidden; z-index: 0;
        background: var(--secondary-background-color);
      }
      .mapwrap .radar-note { margin-top: 6px; }
      .leaflet-container { font: inherit; background: var(--secondary-background-color); }
      .leaflet-bar { border: 1px solid var(--divider-color) !important; box-shadow: none !important; }
      .leaflet-bar a {
        background: var(--card-background-color, var(--ha-card-background, #fff));
        color: var(--primary-text-color); border-bottom-color: var(--divider-color);
      }
      .leaflet-control-attribution {
        font-size: 9px; background: transparent !important;
        color: var(--secondary-text-color);
      }
      .leaflet-control-attribution a { color: var(--secondary-text-color); }
    `;
  }
}

customElements.define("flights-above-card", FlightsAboveCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "flights-above-card",
  name: "Flights Above Card",
  description: "Overhead flights with progress tracks, a sweeping radar and a live map.",
  preview: false,
});

// eslint-disable-next-line no-console
console.info(
  `%c FLIGHTS-ABOVE-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#03a9f4;font-weight:700;",
  "color:#03a9f4;background:#fff;"
);
