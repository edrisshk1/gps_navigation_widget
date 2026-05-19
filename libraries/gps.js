// ─── TOUCH SUPPORT UTILITIES ───────────────────────────
// Maps mouse events to their touch equivalents for tablet/touchscreen support.
// Leaflet fires 'mousedown'/'mousemove'/'mouseup' only for mouse input;
// touch fires separate 'touchstart'/'touchmove'/'touchend' events.
// These helpers register both so all drag interactions work on touch devices.
var _touchMap = { mousedown: 'touchstart', mousemove: 'touchmove', mouseup: 'touchend' };

function touchOn(target, mouseEvent, handler) {
    target.on(mouseEvent, handler);
    if (_touchMap[mouseEvent]) target.on(_touchMap[mouseEvent], handler);
}
function touchOff(target, mouseEvent, handler) {
    target.off(mouseEvent, handler);
    if (_touchMap[mouseEvent]) target.off(_touchMap[mouseEvent], handler);
}
// Prevent page scroll/zoom while a custom drag is active
var _customDragActive = false;
function setCustomDragActive(active) { _customDragActive = active; }

// ─── NATIVE DOM TOUCH FOR LEAFLET MARKERS ─────────────
// Leaflet's .on('touchstart') is unreliable on non-draggable markers.
// This helper adds a native DOM touchstart listener directly to the
// marker's icon element, bypassing Leaflet's event system entirely.
// The callback receives a synthetic object { latlng, originalEvent }.
function addMarkerDomTouch(marker, callback) {
    var el = marker._icon || (marker.getElement && marker.getElement());
    if (!el) return;
    el.style.touchAction = 'none';
    el.addEventListener('touchstart', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var touch = e.touches ? e.touches[0] : null;
        var latlng = null;
        if (touch && map) {
            var rect = map.getContainer().getBoundingClientRect();
            var pt = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
            latlng = map.containerPointToLatLng(pt);
        }
        callback({ latlng: latlng, originalEvent: e });
    }, { passive: false });
}

// ─── LONG-PRESS HELPER FOR TOUCH (waypoint removal) ───
// Fires callback on touch-and-hold (~500ms). Suppresses the
// subsequent 'click' event so a new waypoint is NOT created.
var _suppressNextMapClick = false;
var _longPressDelay = 500;

// Convert any Leaflet event (mouse or touch) to a LatLng.
// Leaflet populates e.latlng for mouse events but may omit it for
// touch events on markers.  This helper falls back to computing it
// from the raw touch coordinates.
function eventToLatLng(e) {
    if (e.latlng) return e.latlng;
    var oe = e.originalEvent || e;
    var touch = oe.touches ? oe.touches[0] : (oe.changedTouches ? oe.changedTouches[0] : null);
    if (touch && map) {
        var rect = map.getContainer().getBoundingClientRect();
        var pt = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
        return map.containerPointToLatLng(pt);
    }
    return null;
}

function attachLongPress(marker, callback) {
    // Uses native DOM listeners on the marker element so they survive
    // even after the marker is removed from the map (which strips
    // Leaflet-level listeners).  Also installs a capture-phase click
    // blocker on the map container to prevent the browser's synthetic
    // click from creating a new waypoint after long-press removal.
    function attach(el) {
        var _lpTimer = null;
        var _lpFired = false;
        var _startTouch = null;

        el.addEventListener('touchstart', function(e) {
            _lpFired = false;
            var touch = e.touches ? e.touches[0] : null;
            _startTouch = touch ? { x: touch.clientX, y: touch.clientY } : null;
            _lpTimer = setTimeout(function() {
                _lpFired = true;
                _suppressNextMapClick = true;
                // Block the follow-up click at DOM capture phase —
                // this fires before Leaflet's click handler and
                // catches both browser-synthesized clicks and Leaflet taps.
                var mapCont = map ? map.getContainer() : null;
                function blockClick(ev) { ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault(); }
                if (mapCont) {
                    mapCont.addEventListener('click', blockClick, true);
                    // Also block Leaflet's internal tap that might fire
                    mapCont.addEventListener('touchend', function blockTouchEnd(ev) {
                        ev.stopPropagation();
                        ev.stopImmediatePropagation();
                        mapCont.removeEventListener('touchend', blockTouchEnd, true);
                    }, true);
                }
                setTimeout(function() {
                    _suppressNextMapClick = false;
                    if (mapCont) mapCont.removeEventListener('click', blockClick, true);
                }, 2000);
                callback();
            }, _longPressDelay);
        }, { passive: false });

        el.addEventListener('touchmove', function(e) {
            if (!_startTouch) return;
            var touch = e.touches ? e.touches[0] : null;
            if (touch) {
                var dx = touch.clientX - _startTouch.x;
                var dy = touch.clientY - _startTouch.y;
                if (Math.sqrt(dx * dx + dy * dy) > 10) {
                    clearTimeout(_lpTimer);
                    _lpTimer = null;
                }
            }
        }, { passive: true });

        el.addEventListener('touchend', function(e) {
            clearTimeout(_lpTimer);
            _lpTimer = null;
            if (_lpFired) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, { passive: false });
    }

    // Attach immediately if marker icon exists, otherwise wait for add-to-map
    var el = marker._icon || (marker.getElement && marker.getElement());
    if (el) {
        attach(el);
    } else {
        marker.once('add', function() {
            var el2 = marker._icon || (marker.getElement && marker.getElement());
            if (el2) attach(el2);
        });
    }
}
// ───────────────────────────────────────────────────────

// ─── WIDGET LIFECYCLE ──────────────────────────────────
// Unique instance ID — every async callback checks this to abort if
// a newer widget instance has replaced this one (device switch).
var _instanceId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
var deviceID = (document.getElementById('gps-container') || document.body).getAttribute('data-device-id') || '';
var _widgetDeviceId = deviceID; // read from DOM data-device-id set by ThingsBoard

// If a previous widget instance is still running, destroy it now.
if (typeof window.__gpsMapWidgetDestroy === 'function') {
    try { window.__gpsMapWidgetDestroy(); } catch(e) { console.warn('[GPS Widget] Error destroying previous instance:', e); }
}
// Also clear any orphaned intervals from a previous instance that
// wasn't properly destroyed (belt-and-suspenders).
if (window.__gpsWidgetIntervalIds && window.__gpsWidgetIntervalIds.length) {
    window.__gpsWidgetIntervalIds.forEach(function(id) { try { clearInterval(id); } catch(e) {} });
}
// Remove any leftover event listeners from a previous instance
if (window.__gpsWidgetEventListeners) {
    window.__gpsWidgetEventListeners.forEach(function(entry) {
        try { entry.target.removeEventListener(entry.event, entry.handler); } catch(e) {}
    });
    window.__gpsWidgetEventListeners = null;
}

// ── Nuclear timer cleanup ────────────────────────────────────────
// ThingsBoard's SPA dashboard navigation keeps the old widget's
// iframe/script context alive until GC runs, so previous setInterval
// and setTimeout callbacks keep firing against shared state (localStorage,
// same-id DOM elements) and re-appear in the new dashboard until a full
// page refresh.  Brute-force cancel every pending timer ID in this
// window before this instance starts its own.  Safe because gps.html
// runs inside its own ThingsBoard iframe — the timer ID space is
// scoped to this iframe's window and contains only widget-owned timers.
try {
    var _maxTimerId = setTimeout(function(){}, 0);
    for (var _tid = 1; _tid <= _maxTimerId; _tid++) {
        try { clearTimeout(_tid); } catch(e) {}
        try { clearInterval(_tid); } catch(e) {}
    }
} catch(e) {}

window.__gpsWidgetInstanceId = _instanceId;

// ── Tracked event listeners (for cleanup) ─────────────────
// Every window/document addEventListener must go through this helper
// so destroyGpsMapWidget can remove them all.
var _eventListeners = [];
window.__gpsWidgetEventListeners = _eventListeners;
function addTrackedListener(target, event, handler) {
    target.addEventListener(event, handler);
    _eventListeners.push({ target: target, event: event, handler: handler });
}

// ── Cross-frame / App device-change detection via localStorage ──
// In the ThingsBoard mobile app the widget may run inside an isolated
// iframe whose window object is NOT shared with the new instance, so
// window.__gpsWidgetInstanceId never changes from the old instance's
// perspective.  We use localStorage (shared across same-origin frames)
// to signal that a newer instance has started and the old one must stop.
var _lcStorageKey = 'gpsWidget_activeInstance_' + _widgetDeviceId;
try {
    localStorage.setItem(_lcStorageKey, _instanceId);
} catch(e) {}
addTrackedListener(window, 'storage', function(e) {
    if (e.key === _lcStorageKey && e.newValue && e.newValue !== _instanceId) {
        // A new widget instance has started in another frame/tab/WebView — show overlay then destroy.
        showDuplicateTabOverlay();
        destroyGpsMapWidget();
    }
});

const widgetIntervals = [];   // track all setInterval IDs for cleanup
window.__gpsWidgetIntervalIds = widgetIntervals; // expose for cross-instance cleanup
let widgetDestroyed = false;  // guard async callbacks after destroy

// Returns true if this instance is still the active one.
// Use in every async callback / interval to bail out early.
function showJwtExpiredPopup() {
    var overlay = document.getElementById('jwt-expired-overlay');
    if (!overlay || overlay.dataset.shown) return;
    overlay.dataset.shown = '1';
    overlay.style.display = 'flex';
}

function showDuplicateTabOverlay() {
    var overlay = document.getElementById('duplicate-tab-overlay');
    if (!overlay || overlay.dataset.shown) return;
    overlay.dataset.shown = '1';
    overlay.style.display = 'flex';
}

function isAlive() {
    if (widgetDestroyed) return false;
    if (window.__gpsWidgetInstanceId !== _instanceId) return false;
    // Cross-frame check: a newer instance in another iframe may have set
    // a different ID in localStorage (window is not shared across iframes).
    try {
        var _stored = localStorage.getItem(_lcStorageKey);
        if (_stored && _stored !== _instanceId) return false;
    } catch(e) {}
    return true;
}
// ───────────────────────────────────────────────────────────

// Row spacing input live update (top-level, not in DOMContentLoaded)
console.log('[DEBUG] row spacing script loaded');
var rowSpacingInput = document.getElementById('row-spacing-input');
console.log('[DEBUG] rowSpacingInput:', rowSpacingInput);
if (rowSpacingInput) {
    console.log('[DEBUG] Attaching input/change handlers to rowSpacingInput');
    rowSpacingInput.addEventListener('input', function(e) {
        console.log('[Row Spacing] input event fired. Value:', rowSpacingInput.value);
        if (typeof abState === 'undefined') {
            console.error('abState is undefined!');
            return;
        }
        var val = parseFloat(rowSpacingInput.value);
        if (isFinite(val) && val > 0) {
            abState.rowSpacing = val;
            if (typeof buildABLines === 'function') {
                console.log('[Row Spacing] Calling buildABLines()');
                buildABLines();
            } else {
                console.error('buildABLines is not a function!');
            }
        }
    });
    rowSpacingInput.addEventListener('change', function(e) {
        console.log('[Row Spacing] change event fired. Value:', rowSpacingInput.value);
        if (typeof abState === 'undefined') {
            console.error('abState is undefined!');
            return;
        }
        var val = parseFloat(rowSpacingInput.value);
        if (isFinite(val) && val > 0) {
            abState.rowSpacing = val;
            if (typeof buildABLines === 'function') {
                console.log('[Row Spacing] Calling buildABLines()');
                buildABLines();
            } else {
                console.error('buildABLines is not a function!');
            }
        }
    });
} else {
    console.error('[DEBUG] rowSpacingInput not found in DOM');
}

// Waypoint spacing input live update
var waypointSpacingInput = document.getElementById('waypoint-spacing-input');
if (waypointSpacingInput) {
    function _updateWaypointSpacing() {
        if (typeof abState === 'undefined') return;
        var val = parseFloat(waypointSpacingInput.value);
        if (isFinite(val) && val > 0) {
            abState.waypointSpacing = val;
        }
    }
    waypointSpacingInput.addEventListener('input', _updateWaypointSpacing);
    waypointSpacingInput.addEventListener('change', _updateWaypointSpacing);
}

// Ensure row spacing panel is shown/hidden with AB controls
function showRowSpacingPanel(show) {
    var panel = document.getElementById('row-spacing-panel');
    if (panel) panel.style.display = show ? 'flex' : 'none';
}

// Patch showABControls to also show/hide row spacing panel
var _origShowABControls = window.showABControls;
window.showABControls = function(show) {
    if (_origShowABControls) _origShowABControls(show);
    showRowSpacingPanel(show);
};

// --- AB Line Drag Handlers: must be defined first for ThingBoard widget compatibility ---
function abLineDragMoveHandler(e) {
    if (!abState.abLineDragStart) return;
    const start = abState.abLineDragStart;
    const curr = eventToLatLng(e);
    if (!curr) return;
    console.debug('[AB Drag] type=', abState.abLineDragType, 'start=', start, 'curr=', curr, 'angleDeg=', abState.abAngleDeg, 'offset=', abState.abLineOffset);
    // Center of AB line
    let latSum = 0, lngSum = 0;
    abState.zoneCorners.forEach(pt => { latSum += pt.lat; lngSum += pt.lng; });
    const center = { lat: latSum / abState.zoneCorners.length, lng: lngSum / abState.zoneCorners.length };
    if (abState.abLineDragType === 'parallel') {
        // Drag: move parallel
        // If we have recorded starting A/B points, translate them (manual-style)
        if (abState._pointAStart && abState._pointBStart && abState._midDragStart) {
            // Project mouse delta onto the perpendicular to the AB line, apply only that component
            const startLat = abState._midDragStart.lat;
            const startLng = abState._midDragStart.lng;
            const dLatDeg = curr.lat - startLat;
            const dLngDeg = curr.lng - startLng;
            const metersPerDegLat = 111320;
            const avgLat = (startLat + curr.lat) / 2;
            const metersPerDegLng = 111320 * Math.cos(avgLat * Math.PI / 180);
            const dLatMeters = dLatDeg * metersPerDegLat;
            const dLngMeters = dLngDeg * metersPerDegLng;
            const angleRad = abState.abAngleDeg * Math.PI / 180;
            const perpX = Math.cos(angleRad); // east component (perp to AB)
            const perpY = -Math.sin(angleRad);  // north component (perp to AB)
            // projection of mouse movement onto perpendicular (meters)
            const projMeters = dLatMeters * perpY + dLngMeters * perpX;
            // convert projected meters back to degree deltas along lat/lng
            const deltaLatDeg = (projMeters * perpY) / metersPerDegLat;
            const deltaLngDeg = (projMeters * perpX) / metersPerDegLng;
            abState.pointA = { lat: abState._pointAStart.lat + deltaLatDeg, lng: abState._pointAStart.lng + deltaLngDeg };
            abState.pointB = { lat: abState._pointBStart.lat + deltaLatDeg, lng: abState._pointBStart.lng + deltaLngDeg };
            // Remove and redraw AB line and markers
            if (abState.abLine) map.removeLayer(abState.abLine);
            if (abState.pointAMarker) map.removeLayer(abState.pointAMarker);
            if (abState.pointBMarker) map.removeLayer(abState.pointBMarker);
            abState.pointAMarker = setABPoint(abState.pointA, 'A');
            abState.pointBMarker = setABPoint(abState.pointB, 'B');
            abState.abLine = L.polyline([abState.pointA, abState.pointB], { color: '#fbbf24', weight: 5, dashArray: '8 8', interactive: true }).addTo(map);
            updateABLinesFromAB();
            abState.abLineDragStart = curr;
            // keep _midDragStart so movement is always relative to initial click
        } else {
            // Fallback: older offset-based logic
            const dx = curr.lng - start.lng;
            const dy = curr.lat - start.lat;
            const angleRad = abState.abAngleDeg * Math.PI / 180;
            const cosLat = Math.cos(curr.lat * Math.PI / 180);
            const metersPerDegLat = 111320;
            const metersPerDegLng = 111320 * cosLat;
            const dLatMeters = dy * metersPerDegLat;
            const dLngMeters = dx * metersPerDegLng;
            const perpX = Math.cos(angleRad);
            const perpY = -Math.sin(angleRad);
            const offsetMeters = dLatMeters * perpY + dLngMeters * perpX;
            const offsetDeg = (offsetMeters / metersPerDegLat) * PARALLEL_SENSITIVITY;
            console.debug('[AB Parallel fallback] offsetDeg=', offsetDeg);
            abState.abLineOffset += offsetDeg;
            abState.abLineOffset = Math.max(Math.min(abState.abLineOffset, 1000), -1000);
            abState.abLineDragStart = curr;
            setupABInteractive();
        }
    }
}

function abLineDragEndHandler(e) {
    console.debug('[AB Drag End] type=', abState.abLineDragType, 'eventLatLng=', e && e.latlng ? e.latlng : e, 'offset=', abState.abLineOffset, 'angleDeg=', abState.abAngleDeg);
    // Clear any mid-drag state used by the midpoint handler
    if (abState._midDragStart) {
        console.debug('[AB Drag End] clearing _midDragStart and _midStartOffset');
        abState._midDragStart = null;
        abState._midStartOffset = null;
    }
    if (abState._draggingABPoint) {
        console.debug('[AB Drag End] clearing _draggingABPoint and _dragStartLatLng');
        abState._draggingABPoint = null;
        abState._dragStartLatLng = null;
    }
    abState.abLineDragStart = null;
    abState.abLineDragType = null;
    map.dragging.enable();
    map.getContainer().style.cursor = '';
    setCustomDragActive(false);
    setTimeout(function() { _suppressNextMapClick = false; }, 300);
    touchOff(map, 'mousemove', abLineDragMoveHandler);
    touchOff(map, 'mouseup', abLineDragEndHandler);
}
// ══════════════════════════════════════════════════════════
// ── INIT VARIABLES ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════

// ── Map & Core State ──
var map;                          // Leaflet map instance
var token;                        // JWT auth token from localStorage
var initialLatLng;                // {lat, lng} — initial map center from telemetry
var isMapInitialized = false;     // true after first successful initializeMap()
var _isInitializing = false;      // prevents concurrent initializeMap calls

// ── Waypoints ──
var markers = [];                 // Leaflet Marker[] — index 0 is the invisible initial marker
var latlngs = [];                 // {lat, lng, yaw, followRow?}[] — waypoint coordinates (parallel to markers[1..n])
var polyline;                     // Leaflet Polyline connecting waypoints (kept null when per-segment mode)
var followRowMode = false;        // internal flag — set by AB sensor-row-follow path generation
var pathSegmentLayers = [];       // Leaflet layers for individual path segments (mixed follow-row paths)
var lockMode = false;             // true when editing is locked (no add/move/remove)
var navigationMode = 'gps';       // 'gps' or 'row-follow'
var distanceControl;              // Leaflet Control showing total path distance
var highlightmarkers = [];        // snapshot of markers used for navigation highlight
var wpslock = false;              // true while navigation is RUNNING (locks highlight markers)

// ── Robot Position & Trail ──
var robotMarker = null;           // Leaflet Marker for the robot's live position
var current_latitude;             // latest robot latitude (from telemetry)
var current_longitude;            // latest robot longitude (from telemetry)
var robotOrientation = 0;         // robot's current heading in degrees
var robotTrail = [];              // last N robot coordinates [{lat, lng}]
var robotTrailOutlineLayer = null; // dark outline polyline behind the trail
var robotTrailLayer = null;       // bright polyline for the robot trail
var robotPathOutlineLayer = null; // dark outline for path between waypoints
var histPathLayer = null;         // historical path polyline (purple)
var histPathOutlineLayer = null;  // outline for historical path
var histPathStartMarker = null;   // circle marker at path start
var histPathEndMarker = null;     // circle marker at path end

// ── Obstacle Detection ──
var isObstaclePlaced = false;     // true when an obstacle marker is on the map
var obstacleLat = null;           // obstacle latitude
var obstacleLng = null;           // obstacle longitude

// ── Mode & Polygon Drawing ──
var currentMode = null;            // 'waypoint' | 'polygon' | 'exclusion-zone' | null
var boundingPolygon;              // Leaflet Polygon being actively drawn
var shadowPolygon;                // (unused legacy) shadow polygon reference
var polygonCorners = [];          // latlng[] — corners of the polygon being drawn
var savedPolygon = [];            // {lat, lng}[] — last finalized polygon corners (for saving)
var savedPolygonType = null;      // 'inclusion' | 'exclusion' — type of savedPolygon

// ── Zones (Inclusion / Exclusion) ──
var inclusionZones = [];          // Leaflet Polygon[] — active inclusion zones on map
var exclusionZones = [];          // Leaflet Polygon[] — active exclusion zones on map
var savedExclusionPolygon = [];   // (legacy) exclusion zone corners

// ── Zone Editing ──
var activeEditZone = null;        // the Leaflet Polygon currently being edited
var activeEditZoneType = null;    // 'inclusion' | 'exclusion'
var cornerMarkers = [];           // Leaflet Marker[] — draggable corner handles
var midpointMarkers = [];         // Leaflet Marker[] — midpoint handles to add new corners

// ── AB Line State ──
// Controls the AB line workflow: zone drawing → A/B placement → parallel lines → path generation
var abState = {
    active: false,                // true when AB workflow is in progress
    step: 'idle',                 // 'idle' | 'draw-zone' | 'select-a' | 'select-b' | 'ab-interactive' | 'lines-ready' | 'robot-wait-a' | 'robot-follow-b'
    workflow: 'path-generation',  // 'path-generation' | 'line-guidance'
    robotWidth: 2.4,              // robot width in meters (used for spacing calculation)
    rowSpacing: 8.0,              // distance between parallel AB lines (meters)
    waypointSpacing: 15,           // distance between waypoints along a line (meters)
    minTurningRadius: 2.0,        // minimum U-turn radius (meters)
    zoneCorners: [],              // latlng[] — corners of the operational zone
    zonePolygon: null,            // Leaflet Polygon for the AB zone
    pointA: null,                 // {lat, lng} — AB line start point
    pointB: null,                 // {lat, lng} — AB line end point
    pointAMarker: null,           // Leaflet Marker for point A
    pointBMarker: null,           // Leaflet Marker for point B
    abLine: null,                 // Leaflet Polyline connecting A and B
    abLineDraggable: false,       // whether the AB line can be dragged
    abAngleDeg: 0,               // angle of the AB line in degrees
    abLineOffset: 0,             // parallel offset in meters
    abLineDragStart: null,        // latlng where drag started
    abLineDragType: null,         // 'angle' | 'parallel'
    lineLayers: [],              // Leaflet Layer[] — rendered parallel lines
    lines: [],                   // {offset, start, end}[] — computed line segments
    pathOptions: null,           // last used path generation options
    pathLatLngs: [],             // {lat, lng, yaw}[] — generated path waypoints
    // Line Guidance Mode
    lineGuidanceEntryMarkers: [], // CircleMarker[] — entry point dots on line endpoints
    robotFollowLine: null,        // dashed Polyline from A to robot during "from robot" AB drawing
    robotFollowHandler: null,     // setInterval ID for tracking robot in AB draw
    abLineFirst: false            // true when AB line is defined before the zone
};

// ── AB Line Constants ──
var PARALLEL_SENSITIVITY = 6;     // multiplier for parallel drag responsiveness

// ══════════════════════════════════════════════════════════
// ── AB LINE: BUILD & DISPLAY ───────────────────────────────
// ══════════════════════════════════════════════════════════

function buildABLines() {
    if (!abState.pointA || !abState.pointB || abState.zoneCorners.length < 3) {
        if (!abState.abLineFirst) showNotification("AB setup incomplete.", "error");
        return;
    }
    abState.lineLayers.forEach(layer => map.removeLayer(layer));
    abState.lineLayers = [];
    abState.lines = [];
    const origin = abState.pointA;
    const aLocal = { x: 0, y: 0 };
    const bLocal = latLngToLocal(abState.pointB, origin);
    const dir = vecNormalize(bLocal);
    if (!dir) {
        showNotification("Point A and B must be different.", "error");
        return;
    }
    const normal = { x: -dir.y, y: dir.x };
    const polygonLocal = abState.zoneCorners.map(corner => latLngToLocal(corner, origin));
    const offsets = polygonLocal.map(point => vecDot(point, normal));
    const minOffset = Math.min.apply(null, offsets);
    const maxOffset = Math.max.apply(null, offsets);
    const spacing = abState.rowSpacing;
    let offset = Math.floor(minOffset / spacing) * spacing;
    const maxLines = 1000;
    let lineCount = 0;
    for (; offset <= maxOffset + 1e-6; offset += spacing) {
        if (lineCount > maxLines) break;
        lineCount++;
        const linePoint = vecAdd(aLocal, vecScale(normal, offset));
        const intersections = [];
        for (let i = 0; i < polygonLocal.length; i++) {
            const p1 = polygonLocal[i];
            const p2 = polygonLocal[(i + 1) % polygonLocal.length];
            const hit = lineSegmentIntersection(linePoint, dir, p1, p2);
            if (hit) intersections.push(hit);
        }
        if (intersections.length < 2) continue;
        intersections.sort((a, b) => a.t - b.t);
        let bestSegment = null;
        let bestLength = 0;
        for (let i = 0; i < intersections.length - 1; i += 2) {
            const start = intersections[i].point;
            const end = intersections[i + 1].point;
            const len = vecLen(vecSub(end, start));
            if (len > bestLength) {
                bestLength = len;
                bestSegment = { start, end };
            }
        }
        if (bestSegment) {
            abState.lines.push({ offset: offset, start: bestSegment.start, end: bestSegment.end });
            const startLatLng = localToLatLng(bestSegment.start, origin);
            const endLatLng = localToLatLng(bestSegment.end, origin);
            const lineLayer = L.polyline([
                [startLatLng.lat, startLatLng.lng],
                [endLatLng.lat, endLatLng.lng]
            ], {
                color: '#f59e0b',
                weight: 2,
                dashArray: '6 6'
            }).addTo(map);
            abState.lineLayers.push(lineLayer);
        }
    }
    if (abState.lines.length === 0) {
        showNotification("No AB lines intersected the zone.", "error");
        return;
    }
    abState.lines.sort((a, b) => a.offset - b.offset);
    abState.step = 'lines-ready';

    // In Line Guidance mode: show entry point dots and the Generate Line button
    if (abState.workflow === 'line-guidance') {
        showLineGuidanceEntryPoints();
        showLineGuidanceButton(true);
        showABConfigSaveButton(true);
        showNotification("AB lines ready. Position robot and click 'Generate Line'.", "success");
    } else {
        showABConfigSaveButton(true);
        showNotification("AB lines ready. Use 'Generate AB Path' to create waypoints.", "success");
    }
}

// ── Line Guidance Mode: show entry point dots on line endpoints ──
function showLineGuidanceEntryPoints() {
    // Remove old entry markers
    if (abState.lineGuidanceEntryMarkers) {
        abState.lineGuidanceEntryMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e){} });
    }
    abState.lineGuidanceEntryMarkers = [];
    var origin = abState.pointA;
    abState.lines.forEach(function(line) {
        var startLL = localToLatLng(line.start, origin);
        var endLL   = localToLatLng(line.end, origin);
        [startLL, endLL].forEach(function(ll) {
            var dot = L.circleMarker([ll.lat, ll.lng], {
                radius: 5,
                color: '#22c55e',
                fillColor: '#22c55e',
                fillOpacity: 0.8,
                weight: 2,
                interactive: false
            }).addTo(map);
            abState.lineGuidanceEntryMarkers.push(dot);
        });
    });
}

// ── Line Guidance Mode: show/hide the floating Generate Line button ──
function showLineGuidanceButton(show) {
    var existing = document.getElementById('line-guidance-generate-btn');
    if (!show) { if (existing) existing.remove(); return; }
    if (existing) return;
    var btn = document.createElement('button');
    btn.id = 'line-guidance-generate-btn';
    btn.innerHTML = '<i class="fas fa-route" style="margin-right:8px;"></i>Generate Line';
    btn.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:10010;padding:12px 30px;font-size:15px;font-weight:700;border-radius:10px;border:2px solid #60a5fa;background:linear-gradient(135deg,rgba(30,64,175,0.92),rgba(37,99,235,0.95));color:#93bbfd;cursor:pointer;font-family:Roboto,sans-serif;box-shadow:0 0 0 3px rgba(96,165,250,0.28),0 4px 20px rgba(59,130,246,0.5);backdrop-filter:blur(8px);transition:all 0.18s ease;';
    btn.onmouseenter = function() { btn.style.background = 'linear-gradient(135deg,rgba(37,99,235,0.95),rgba(59,130,246,0.98))'; btn.style.color = '#c7d2fe'; btn.style.boxShadow = '0 0 0 3px rgba(96,165,250,0.45),0 4px 24px rgba(59,130,246,0.65)'; };
    btn.onmouseleave = function() { btn.style.background = 'linear-gradient(135deg,rgba(30,64,175,0.92),rgba(37,99,235,0.95))'; btn.style.color = '#93bbfd'; btn.style.boxShadow = '0 0 0 3px rgba(96,165,250,0.28),0 4px 20px rgba(59,130,246,0.5)'; };
    btn.onclick = function() { generateLineGuidanceWaypoints(); };
    btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    btn.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });
    document.getElementById('gps-container').appendChild(btn);
}

// ── Show/hide floating Save AB Config button ──
function showABConfigSaveButton(show) {
    var existing = document.getElementById('ab-config-save-btn');
    if (!show) { if (existing) existing.remove(); return; }
    if (existing) return;
    var btn = document.createElement('button');
    btn.id = 'ab-config-save-btn';
    btn.innerHTML = '<i class="fas fa-save" style="margin-right:8px;"></i>Save AB Config';
    btn.style.cssText = 'position:absolute;bottom:130px;left:50%;transform:translateX(-50%);z-index:10010;padding:8px 18px;font-size:13px;font-weight:700;border-radius:9px;border:2px solid rgba(34,197,94,0.5);background:linear-gradient(135deg,rgba(21,128,61,0.92),rgba(34,197,94,0.85));color:#bbf7d0;cursor:pointer;font-family:Roboto,sans-serif;box-shadow:0 3px 12px rgba(34,197,94,0.3);backdrop-filter:blur(8px);white-space:nowrap;transition:all 0.18s ease;';
    btn.onmouseenter = function() { btn.style.background = 'linear-gradient(135deg,rgba(34,197,94,0.95),rgba(74,222,128,0.98))'; btn.style.color = '#dcfce7'; };
    btn.onmouseleave = function() { btn.style.background = 'linear-gradient(135deg,rgba(21,128,61,0.92),rgba(34,197,94,0.85))'; btn.style.color = '#bbf7d0'; };
    btn.onclick = function() { saveABConfig(); };
    btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    btn.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });
    document.getElementById('gps-container').appendChild(btn);
}

// ══════════════════════════════════════════════════════════
// ── AB LINE: FROM-ROBOT MODE ───────────────────────────────
// ══════════════════════════════════════════════════════════

function startABFromRobot() {
    abState.step = 'robot-wait-a';
    showNotification('Position robot at Point A, then click "Set A".', 'info');
    showRobotABButtons();
}

// ── Show Set A / Set B / Undo floating button bar for "From Robot" mode ──
function showRobotABButtons() {
    var existing = document.getElementById('ab-robot-btn-bar');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.id = 'ab-robot-btn-bar';
    bar.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:10010;display:flex;gap:8px;';
    bar.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    bar.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });

    function makeFBtn(id, icon, label, borderColor, bgGrad, textColor, hoverBg, hoverText) {
        var btn = document.createElement('button');
        btn.id = id;
        btn.innerHTML = '<i class="fas ' + icon + '" style="margin-right:8px;"></i>' + label;
        btn.style.cssText = 'padding:12px 24px;font-size:14px;font-weight:700;border-radius:10px;border:2px solid ' + borderColor + ';background:' + bgGrad + ';color:' + textColor + ';cursor:pointer;font-family:Roboto,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.3);backdrop-filter:blur(8px);transition:all 0.18s ease;white-space:nowrap;';
        btn.onmouseenter = function() { btn.style.background = hoverBg; btn.style.color = hoverText; };
        btn.onmouseleave = function() { btn.style.background = bgGrad; btn.style.color = textColor; };
        return btn;
    }

    // Set A button
    var btnA = makeFBtn('ab-robot-set-a', 'fa-map-marker-alt', 'Set A',
        'rgba(34,197,94,0.5)', 'linear-gradient(135deg,rgba(22,101,52,0.92),rgba(20,83,45,0.95))', '#4ade80',
        'linear-gradient(135deg,rgba(34,197,94,0.35),rgba(22,101,52,0.95))', '#86efac');
    btnA.onclick = function() { setAFromRobot(); };

    // Set B button
    var btnB = makeFBtn('ab-robot-set-b', 'fa-map-marker-alt', 'Set B',
        'rgba(239,68,68,0.5)', 'linear-gradient(135deg,rgba(153,27,27,0.92),rgba(185,28,28,0.95))', '#fca5a5',
        'linear-gradient(135deg,rgba(185,28,28,0.95),rgba(220,38,38,0.98))', '#fecaca');
    btnB.onclick = function() { setBFromRobot(); };
    btnB.style.opacity = '0.4';
    btnB.style.pointerEvents = 'none';

    // Undo button
    var btnUndo = makeFBtn('ab-robot-undo', 'fa-undo', 'Undo',
        'rgba(148,163,184,0.4)', 'linear-gradient(135deg,rgba(55,65,81,0.92),rgba(45,55,70,0.95))', '#94a3b8',
        'linear-gradient(135deg,rgba(75,85,99,0.95),rgba(55,65,81,0.98))', '#cbd5e1');
    btnUndo.onclick = function() { undoRobotABPoint(); };
    btnUndo.style.opacity = '0.4';
    btnUndo.style.pointerEvents = 'none';

    bar.appendChild(btnA);
    bar.appendChild(btnB);
    bar.appendChild(btnUndo);
    document.getElementById('gps-container').appendChild(bar);
    updateRobotABButtonStates();
}

function updateRobotABButtonStates() {
    var btnA = document.getElementById('ab-robot-set-a');
    var btnB = document.getElementById('ab-robot-set-b');
    var btnUndo = document.getElementById('ab-robot-undo');
    if (!btnA || !btnB || !btnUndo) return;

    var hasA = !!abState.pointA;
    var hasB = !!abState.pointB;

    // Set A: enabled only when A is not set yet
    btnA.style.opacity = hasA ? '0.4' : '1';
    btnA.style.pointerEvents = hasA ? 'none' : 'auto';

    // Set B: enabled only when A is set and B is not
    btnB.style.opacity = (hasA && !hasB) ? '1' : '0.4';
    btnB.style.pointerEvents = (hasA && !hasB) ? 'auto' : 'none';

    // Undo: enabled when at least A is set
    btnUndo.style.opacity = hasA ? '1' : '0.4';
    btnUndo.style.pointerEvents = hasA ? 'auto' : 'none';
}

function setAFromRobot() {
    if (!robotMarker) { showNotification('Robot position not available.', 'error'); return; }
    var robotPos = robotMarker.getLatLng();
    abState.pointA = { lat: robotPos.lat, lng: robotPos.lng };
    if (abState.pointAMarker) map.removeLayer(abState.pointAMarker);
    abState.pointAMarker = setABPoint(abState.pointA, 'A');
    abState.step = 'robot-follow-b';
    showNotification('Point A set. Move robot to B, then click "Set B".', 'info');

    // Show dashed line following robot from A
    if (abState.robotFollowLine) { map.removeLayer(abState.robotFollowLine); abState.robotFollowLine = null; }
    abState.robotFollowLine = L.polyline([
        [abState.pointA.lat, abState.pointA.lng],
        [robotPos.lat, robotPos.lng]
    ], { color: '#60a5fa', weight: 3, dashArray: '8 6', interactive: false }).addTo(map);

    if (abState.robotFollowHandler) clearInterval(abState.robotFollowHandler);
    abState.robotFollowHandler = setInterval(function() {
        if (!robotMarker || abState.step !== 'robot-follow-b') {
            clearInterval(abState.robotFollowHandler);
            abState.robotFollowHandler = null;
            return;
        }
        var rp = robotMarker.getLatLng();
        if (abState.robotFollowLine) {
            abState.robotFollowLine.setLatLngs([
                [abState.pointA.lat, abState.pointA.lng],
                [rp.lat, rp.lng]
            ]);
        }
    }, 500);

    updateRobotABButtonStates();
}

function setBFromRobot() {
    if (!robotMarker) { showNotification('Robot position not available.', 'error'); return; }
    if (!abState.pointA) { showNotification('Set Point A first.', 'error'); return; }
    var robotPos = robotMarker.getLatLng();
    abState.pointB = { lat: robotPos.lat, lng: robotPos.lng };
    if (abState.pointBMarker) map.removeLayer(abState.pointBMarker);
    abState.pointBMarker = setABPoint(abState.pointB, 'B');

    // Clean up follow line and interval
    if (abState.robotFollowLine) { map.removeLayer(abState.robotFollowLine); abState.robotFollowLine = null; }
    if (abState.robotFollowHandler) { clearInterval(abState.robotFollowHandler); abState.robotFollowHandler = null; }

    updateRobotABButtonStates();

    // Remove button bar and finalize
    var bar = document.getElementById('ab-robot-btn-bar');
    if (bar) bar.remove();

    // Draw AB line
    if (abState.abLine) { map.removeLayer(abState.abLine); abState.abLine = null; }
    abState.abLine = L.polyline([abState.pointA, abState.pointB], { color: '#fbbf24', weight: 5, dashArray: '8 8', interactive: false }).addTo(map);
    if (abState.abMidMarker) map.removeLayer(abState.abMidMarker);
    var midLat = (abState.pointA.lat + abState.pointB.lat) / 2;
    var midLng = (abState.pointA.lng + abState.pointB.lng) / 2;
    abState.abMidMarker = createManualMidMarker(midLat, midLng);
    abState.step = 'lines-ready';
    updateABLinesFromAB();
    showNotification('AB line set from robot. Lines ready.', 'success');
    showSaveABLineButton();
    if (abState.abLineFirst) showABLineFirstZonePrompt();
}

function undoRobotABPoint() {
    if (abState.pointB) {
        // Undo B → go back to follow mode
        if (abState.pointBMarker) { map.removeLayer(abState.pointBMarker); abState.pointBMarker = null; }
        abState.pointB = null;
        if (abState.abLine) { map.removeLayer(abState.abLine); abState.abLine = null; }
        if (abState.abMidMarker) { map.removeLayer(abState.abMidMarker); abState.abMidMarker = null; }
        // Restart follow line
        abState.step = 'robot-follow-b';
        if (!abState.robotFollowLine && abState.pointA) {
            var rp = robotMarker ? robotMarker.getLatLng() : abState.pointA;
            abState.robotFollowLine = L.polyline([
                [abState.pointA.lat, abState.pointA.lng],
                [rp.lat, rp.lng]
            ], { color: '#60a5fa', weight: 3, dashArray: '8 6', interactive: false }).addTo(map);
        }
        if (!abState.robotFollowHandler && abState.pointA) {
            abState.robotFollowHandler = setInterval(function() {
                if (!robotMarker || abState.step !== 'robot-follow-b') {
                    clearInterval(abState.robotFollowHandler);
                    abState.robotFollowHandler = null;
                    return;
                }
                var rp2 = robotMarker.getLatLng();
                if (abState.robotFollowLine) {
                    abState.robotFollowLine.setLatLngs([
                        [abState.pointA.lat, abState.pointA.lng],
                        [rp2.lat, rp2.lng]
                    ]);
                }
            }, 500);
        }
        // Remove parallel lines that were generated
        abState.lineLayers.forEach(function(l) { map.removeLayer(l); });
        abState.lineLayers = [];
        abState.lines = [];
        showNotification('Point B undone. Move robot and set B again.', 'info');
    } else if (abState.pointA) {
        // Undo A
        if (abState.pointAMarker) { map.removeLayer(abState.pointAMarker); abState.pointAMarker = null; }
        abState.pointA = null;
        if (abState.robotFollowLine) { map.removeLayer(abState.robotFollowLine); abState.robotFollowLine = null; }
        if (abState.robotFollowHandler) { clearInterval(abState.robotFollowHandler); abState.robotFollowHandler = null; }
        abState.step = 'robot-wait-a';
        showNotification('Point A undone. Position robot and set A.', 'info');
    }
    updateRobotABButtonStates();
}

// Legacy wrapper kept for cleanup code
function showSetBFromRobotButton(show) {
    var existing = document.getElementById('ab-set-b-robot-btn');
    if (existing) existing.remove();
    var bar = document.getElementById('ab-robot-btn-bar');
    if (!show && bar) bar.remove();
}

// finalizeBFromRobot kept as alias for backward compat
function finalizeBFromRobot() { setBFromRobot(); }

// ══════════════════════════════════════════════════════════
// ── AB LINE: LINE GUIDANCE WAYPOINT GENERATION ─────────────
// ══════════════════════════════════════════════════════════

function generateLineGuidanceWaypoints() {
    if (!robotMarker) {
        showNotification('Robot position not available.', 'error');
        return;
    }
    if (!abState.lines || abState.lines.length === 0) {
        showNotification('No AB lines available.', 'error');
        return;
    }
    var origin = abState.pointA;
    var robotPos = robotMarker.getLatLng();
    var robotLocal = latLngToLocal(robotPos, origin);

    // Find the closest line start or end point to the robot
    var bestDist = Infinity;
    var bestLine = null;
    var bestReverse = false; // whether to go end→start instead of start→end
    for (var i = 0; i < abState.lines.length; i++) {
        var line = abState.lines[i];
        var dStart = vecLen(vecSub(line.start, robotLocal));
        var dEnd   = vecLen(vecSub(line.end, robotLocal));
        if (dStart < bestDist) {
            bestDist = dStart;
            bestLine = line;
            bestReverse = false;
        }
        if (dEnd < bestDist) {
            bestDist = dEnd;
            bestLine = line;
            bestReverse = true;
        }
    }

    if (!bestLine) {
        showNotification('Could not find a matching line.', 'error');
        return;
    }

    // Generate waypoints along the chosen line
    var spacing = abState.waypointSpacing || 1.0;
    var lineStart = bestReverse ? bestLine.end : bestLine.start;
    var lineEnd   = bestReverse ? bestLine.start : bestLine.end;
    var points = interpolateSegmentPoints(lineStart, lineEnd, spacing);

    // Compute yaw using the same logic as AB path generation
    var wpLatLngs = points.map(function(pt, idx) {
        var ll = localToLatLng(pt, origin);
        var bearing = 0;
        if (idx < points.length - 1) {
            var nextLL = localToLatLng(points[idx + 1], origin);
            bearing = computeBearingDegrees(ll.lat, ll.lng, nextLL.lat, nextLL.lng);
        } else if (idx > 0) {
            var prevLL = localToLatLng(points[idx - 1], origin);
            bearing = computeBearingDegrees(prevLL.lat, prevLL.lng, ll.lat, ll.lng);
        }
        var yaw = (bearing - 90 + 360) % 360;
        return { lat: ll.lat, lng: ll.lng, yaw: yaw };
    });

    if (wpLatLngs.length === 0) {
        showNotification('No waypoints generated.', 'error');
        return;
    }

    // Highlight the selected line
    var startLL = localToLatLng(lineStart, origin);
    var endLL   = localToLatLng(lineEnd, origin);
    // Remove previous highlight if any
    if (abState._guidanceHighlight) { try { map.removeLayer(abState._guidanceHighlight); } catch(e){} }
    abState._guidanceHighlight = L.polyline([
        [startLL.lat, startLL.lng], [endLL.lat, endLL.lng]
    ], { color: '#22c55e', weight: 4, dashArray: null, interactive: false }).addTo(map);

    // Clear existing waypoints before adding new ones
    markers.slice(1).forEach(function(m) { map.removeLayer(m); });
    markers = markers.slice(0, 1);
    latlngs = [];
    updatePath();

    // Add waypoints
    addWaypointsBatch(wpLatLngs, { skipZoneChecks: true });
    updatePath();
    showNotification('Generated ' + wpLatLngs.length + ' waypoints for closest line (' + Math.round(bestDist) + 'm away).', 'success');
}

function interpolateSegmentPoints(start, end, spacing) {
    const segment = vecSub(end, start);
    const length = vecLen(segment);
    if (length === 0) return [start];
    if (!spacing || spacing <= 0 || length <= spacing) return [start, end];

    const dir = vecNormalize(segment);
    const points = [];
    for (let dist = 0; dist < length; dist += spacing) {
        points.push(vecAdd(start, vecScale(dir, dist)));
        if (points.length > 5000) break;
    }
    points.push(end);
    return points;
}


function updateABLinesFromAB() {
    buildABLines();
}

// ══════════════════════════════════════════════════════════
// ── MAP INITIALIZATION & LEAFLET CONFIG ────────────────────
// ══════════════════════════════════════════════════════════

L.Icon.Default.mergeOptions({
    iconSize: [20, 33], // Slightly smaller size (default is [25, 41])
    iconAnchor: [10, 33], // Adjust anchor point proportionally
    popupAnchor: [0, -28], // Adjust popup position proportionally
    shadowSize: [33, 33], // Proportionally smaller shadow size
});

// Function to check and initialize the map automatically if it's not initialized
function initializeMapIfNeeded() {
    if (!isAlive()) return;
    if (!isMapInitialized && !_isInitializing) {
        initializeMap();
    }
}

async function addWaypointFromRobot() {
    if (!robotMarker) {
        console.log('[DEBUG] addWaypointFromRobot called but robotMarker is not set');
        showNotification("Robot location is not available.", "error");
        return;
    }
    const robotLatLng = robotMarker.getLatLng();
    console.log('[DEBUG] addWaypointFromRobot robotLatLng:', robotLatLng);
    console.log('[DEBUG] addWaypointFromRobot robotOrientation:', robotOrientation);
    const exists = latlngs.some(coord => coord.lat === robotLatLng.lat && coord.lng === robotLatLng.lng);

    if (exists) {
        showNotification("Waypoint exists in robot's current location.", "info");
        console.log('[DEBUG] Waypoint exists at robot location, skipping add');
        return;
    } else {
        showNotification("Waypoint added using robot's current location.", "success");
    }

    // Use the latest robot orientation when creating the waypoint
    // Apply -90° correction to match how mouse-click orientation works (icon image points right by default)
    const yaw = (typeof robotOrientation === 'number') ? ((robotOrientation - 90 + 360) % 360) : 0;
    console.log('[DEBUG] Calling addWaypoint with', { lat: robotLatLng.lat, lng: robotLatLng.lng, yaw });
    const idx = await addWaypoint(robotLatLng.lat, robotLatLng.lng, yaw);
    console.log('[DEBUG] addWaypoint returned idx:', idx);
    if (idx) {
        console.log('[DEBUG] latlngs now length:', latlngs.length, 'last item:', latlngs[latlngs.length-1]);
        showNotification('Waypoint ' + idx + ' added with robot orientation ' + yaw.toFixed(1) + '°.', 'success');
    }
}

// ══════════════════════════════════════════════════════════
// ── WAYPOINT HIGHLIGHT (NAVIGATION PROGRESS) ───────────────
// ══════════════════════════════════════════════════════════

function highlightWaypoint(progress) {
    console.log("HighlightWaypoint called with progress:", progress);

    if (progress < 1 || progress > highlightmarkers.length) {
        console.error("Invalid progress value:", progress);
        return;
    }

    const targetMarker = highlightmarkers[progress]; // Get the marker to highlight
    console.log("Target marker:", targetMarker);

    if (!targetMarker) {
        console.error("Target marker is undefined for progress:", progress);
        return;
    }

    const targetLatLng = targetMarker.getLatLng(); // Get the coordinates of the target marker
    console.log("Target marker coordinates:", targetLatLng);

    const progres_str = progress.toString();

    // Create a new icon for highlighting
    const highlightIcon = L.divIcon({
        className: 'highlighted-waypoint-icon',
        html: '<div class="waypoint-bubble waypoint-highlight">' + progres_str + '</div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15] // Center the icon
    });

    console.log("Highlight icon created:", highlightIcon);

    // Add the highlighted marker to the map
    if (window.highlightedMarker) {
        console.log("Removing previous highlighted marker.");
        map.removeLayer(window.highlightedMarker); // Remove the previous highlighted marker
    }

    window.highlightedMarker = L.marker([targetLatLng.lat, targetLatLng.lng], {
        icon: highlightIcon,
        zIndexOffset: 500,
        interactive: false
    }).addTo(map);

    console.log("Highlighted marker added to map:", window.highlightedMarker);
}

// ══════════════════════════════════════════════════════════
// ── ROBOT TELEMETRY & LOCATION UPDATE ──────────────────────
// ══════════════════════════════════════════════════════════

async function UpdateRobotLocation() {
    if (!isAlive()) return;
    if (!map) return;
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        console.error("Token not available.");
        return null;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/timeseries?keys=current_latitude%2Ccurrent_longitude%2Ccurrent_orientation%2Caction_type%2Cprogress%2Cnavigation_state`;
    //console.log("API Endpoint:", apiEndpoint);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });
        if (!isAlive() || !map) return;

        if (!response.ok) {
            console.error("Failed to fetch robot location. HTTP Status:", response.status, response.statusText);
            return null;
        }

        const data = await response.json();
        if (!isAlive() || !map) return;
        //console.log("API Response Data:", data);
        
        const latitude = parseFloat(data.current_latitude?.[0]?.value || 0);
        const longitude = parseFloat(data.current_longitude?.[0]?.value || 0);
        const orientation = parseFloat(data.current_orientation?.[0]?.value || 0);
        // console.log('[DEBUG] Robot telemetry parsed:', { latitude, longitude, orientation, actionType: data.action_type?.[0]?.value, navigation_state: data.navigation_state?.[0]?.value });
        const actionType = parseInt(data.action_type?.[0]?.value || 0);
        const navigation_state = data.navigation_state?.[0]?.value || "";
        // Store the robot's orientation for use in waypoint creation
        robotOrientation = orientation || 0; 
        //console.log("Parsed Data - Latitude:", latitude, "Longitude:", longitude, "Orientation:", orientation, "Action Type:", actionType, "Navigation State:", navigation_state);
        
        const progress = parseInt(data.progress?.[0]?.value || 0); // Update the progress variable
        
        if (navigation_state == "RUNNINGS") {
            
            if (wpslock == false){
                wpslock = true;
                
                // Create a deep copy of markers to fix highlightmarkers
                highlightmarkers = markers.map(marker => {
                    return L.marker(marker.getLatLng(), { icon: marker.options.icon });
                });

                console.log("Highlightmarkers fixed:", highlightmarkers);
            }
            
            highlightWaypoint(progress+1); // Highlight the waypoint
        }
        
        if (wpslock == true && (navigation_state == "STOPPED" || navigation_state == "ABORTED" || navigation_state == "SUCCESS" || navigation_state == "UNAVAILABLE")){
            wpslock = false;
            console.log("Wpslock reset due to navigation state:", navigation_state);
        }
        
        
        if (!latitude || !longitude) {
            console.error("Invalid robot coordinates:", { latitude, longitude });
            return;
        }

        const robotIcon = L.divIcon({
            className: 'custom-robot-icon',
            html: '<div style="'
                + 'transform: rotate(' + orientation + 'deg); '
                + 'width: 24px; '
                + 'height: 24px; '
                + 'background-image: url(\'/api/images/public/vCLGxcoYcUt8iFPsvW9Qa2fGbVqx66kl\'); '
                + 'background-size: cover;">'
                + '</div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
        });

        if (!robotMarker) {
            robotMarker = L.marker([latitude, longitude], { icon: robotIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
            robotMarker._lastOrientation = orientation;
            console.log("Robot marker created: Latitude " + latitude + ", Longitude " + longitude + ", Orientation " + orientation);
        } else {
            robotMarker.setLatLng([latitude, longitude]);
            // Only rebuild the icon when orientation actually changes (avoids
            // DOM replacement flicker / blinking on tablets).
            if (robotMarker._lastOrientation == null ||
                Math.abs(robotMarker._lastOrientation - orientation) > 0.5) {
                robotMarker.setIcon(robotIcon);
                robotMarker._lastOrientation = orientation;
            }
            //console.log("Robot marker updated: Latitude " + latitude + ", Longitude " + longitude + ", Orientation " + orientation);
        }
        // Store latest robot orientation for other functions
        robotOrientation = orientation || 0;
        // If focus mode is active, keep the map centered on the robot
        if (window._focusMode) {
            map.panTo([latitude, longitude]);
        }
        // console.log('[DEBUG] robotOrientation set to', robotOrientation);

        const obstacleDistance = 1; // Distance in meters
        if (!isObstaclePlaced && (actionType === 2 || actionType === 1)) {
            // Calculate obstacle position based on robot's coordinates and orientation
            obstacleLat = latitude + (obstacleDistance * Math.cos(orientation * Math.PI / 180)) / 111320;
            obstacleLng = longitude + (obstacleDistance * Math.sin(orientation * Math.PI / 180)) / (111320 * Math.cos(latitude * Math.PI / 180));

            const obstacleColor = actionType === 2 ? 'orange' : 'red'; // Set initial color based on actionType
            const obstacleIcon = L.divIcon({
                className: 'custom-obstacle-icon',
                html: '<div style="'
                    + 'transform: rotate(' + orientation + 'deg); '
                    + 'width: 40px; '
                    + 'height: 10px; '
                    + 'background-color: ' + obstacleColor + '; '
                    + 'border-radius: 2px; '
                    + 'border: 2px solid black; ' // Add black border
                    + '"></div>',
                iconSize: [40, 10],
                iconAnchor: [20, 5], // Center the icon
            });

            window.obstacleMarker = L.marker([obstacleLat, obstacleLng], { icon: obstacleIcon }).addTo(map);
            isObstaclePlaced = true; // Mark the obstacle as placed
            showNotification("Obstacle detected! Action type: " + actionType, "info");
            console.log("Obstacle marker created: Latitude " + obstacleLat + ", Longitude " + obstacleLng + ", Color " + obstacleColor);
        } else if (isObstaclePlaced && actionType === 1) {
            // Update obstacle color to red for stop zone
            const obstacleIcon = L.divIcon({
                className: 'custom-obstacle-icon',
                html: '<div style="'
                    + 'transform: rotate(' + orientation + 'deg); '
                    + 'width: 40px; '
                    + 'height: 10px; '
                    + 'background-color: red; ' // Change color to red
                    + 'border-radius: 2px; '
                    + 'border: 2px solid black; ' // Add black border
                    + '"></div>',
                iconSize: [40, 10],
                iconAnchor: [20, 5], // Center the icon
            });

            window.obstacleMarker.setIcon(obstacleIcon);
            showNotification("Obstacle updated to stop zone!", "info");
            console.log("Obstacle marker updated: Color red");
        } else if (actionType === 0 && isObstaclePlaced) {
            // Remove the obstacle marker when actionType is 0
            map.removeLayer(window.obstacleMarker);
            window.obstacleMarker = null;
            isObstaclePlaced = false; // Reset the flag
            showNotification("Obstacle cleared.", "success");
            console.log("Obstacle marker removed.");
        }
        
        // Add trail logic when navigation_state is "RUNNING"
        if (navigation_state === "RUNNING") {
            // Add the current robot coordinates to the trail
            robotTrail.push([latitude, longitude]);

            // Keep only the last 100 coordinates
            if (robotTrail.length > 1000) robotTrail.shift();

            // Remove any legacy per-point markers if present
            if (window.robotTrailMarkers && window.robotTrailMarkers.length) {
                try { window.robotTrailMarkers.forEach(m => map.removeLayer(m)); } catch(e) {}
                window.robotTrailMarkers = [];
            }

            // Create or update a single polyline with a darker outline underneath
            if (robotTrailOutlineLayer) {
                try { robotTrailOutlineLayer.setLatLngs(robotTrail); } catch (e) { console.warn('Failed to update robotTrailOutlineLayer', e); }
            } else {
                robotTrailOutlineLayer = L.polyline(robotTrail, {
                    color: '#0b3b0b', // dark green/near-black outline
                    weight: 7,
                    opacity: 0.9,
                    interactive: false
                }).addTo(map);
            }

            if (robotTrailLayer) {
                try { robotTrailLayer.setLatLngs(robotTrail); } catch (e) { console.warn('Failed to update robotTrailLayer', e); }
            } else {
                // Main visible trail on top of the outline
                robotTrailLayer = L.polyline(robotTrail, {
                    color: '#32CD32', // lime green
                    weight: 3,
                    opacity: 0.95,
                    interactive: false
                }).addTo(map);
            }
        }
    } catch (error) {
        console.error("Failed to fetch robot location:", error);
        return null;
    }
}


// ══════════════════════════════════════════════════════════
// ── PATH HISTORY ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════

function openPathHistoryPanel() {
    var panel = document.getElementById('path-history-panel');
    if (!panel) return;
    // Default times: end = now, start = 1 hour ago
    var now = new Date();
    var startDefault = new Date(now.getTime() - 60 * 60 * 1000);
    function toLocalInput(d) {
        var pad = function(n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    var startEl = document.getElementById('ph-start');
    var endEl = document.getElementById('ph-end');
    if (startEl && !startEl.value) startEl.value = toLocalInput(startDefault);
    if (endEl && !endEl.value) endEl.value = toLocalInput(now);
    panel.style.display = 'block';
}

function closePathHistoryPanel() {
    var panel = document.getElementById('path-history-panel');
    if (panel) panel.style.display = 'none';
}

function showPathHistoryStatus(msg, type) {
    var el = document.getElementById('ph-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'ph-status ph-status-' + (type || 'info');
}

async function loadPathHistory() {
    if (!token) { showPathHistoryStatus('Not authenticated.', 'error'); return; }
    if (!map) { showPathHistoryStatus('Map not ready.', 'error'); return; }

    var startEl = document.getElementById('ph-start');
    var endEl = document.getElementById('ph-end');
    var intervalEl = document.getElementById('ph-interval');
    var btn = document.getElementById('ph-load-btn');

    var startTs = startEl && startEl.value ? new Date(startEl.value).getTime() : NaN;
    var endTs = endEl && endEl.value ? new Date(endEl.value).getTime() : NaN;
    var intervalSec = intervalEl ? parseInt(intervalEl.value) : 30;
    var intervalMs = intervalSec * 1000;

    if (isNaN(startTs) || isNaN(endTs)) {
        showPathHistoryStatus('Please fill in both date/time fields.', 'error'); return;
    }
    if (endTs <= startTs) {
        showPathHistoryStatus('End time must be after start time.', 'error'); return;
    }
    if (endTs - startTs > 7 * 24 * 60 * 60 * 1000) {
        showPathHistoryStatus('Maximum range is 7 days.', 'error'); return;
    }

    var limit = Math.min(5000, Math.ceil((endTs - startTs) / intervalMs));

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…';
    showPathHistoryStatus('Fetching data…', 'info');

    var url = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId +
        '/values/timeseries?keys=current_latitude%2Ccurrent_longitude' +
        '&startTs=' + startTs + '&endTs=' + endTs +
        '&limit=' + limit + '&agg=NONE&orderBy=ASC';

    try {
        var response = await fetch(url, {
            headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token }
        });

        if (!response.ok) {
            showPathHistoryStatus('Server error: HTTP ' + response.status, 'error');
            return;
        }

        var data = await response.json();
        var lats = data.current_latitude || [];
        var lngs = data.current_longitude || [];

        if (!lats.length || !lngs.length) {
            showPathHistoryStatus('No location data found for that time range.', 'error'); return;
        }

        // Build a ts→value map for longitudes, then match each lat point to nearest lng
        var lngByTs = {};
        lngs.forEach(function(p) { lngByTs[p.ts] = parseFloat(p.value); });
        var lngTsSorted = lngs.map(function(p) { return p.ts; }).sort(function(a,b){return a-b;});

        var points = [];
        var lastPlottedTs = -Infinity;

        lats.forEach(function(p) {
            var ts = p.ts;
            var lat = parseFloat(p.value);
            if (isNaN(lat) || lat === 0) return;

            // Skip points closer than the chosen interval
            if (ts - lastPlottedTs < intervalMs) return;

            var lng = lngByTs[ts];
            if (lng === undefined) {
                // Find nearest lng timestamp within 2 seconds
                var minDiff = Infinity, nearest = null;
                for (var i = 0; i < lngTsSorted.length; i++) {
                    var diff = Math.abs(lngTsSorted[i] - ts);
                    if (diff < minDiff) { minDiff = diff; nearest = lngTsSorted[i]; }
                    if (lngTsSorted[i] > ts + 2000) break;
                }
                if (nearest !== null && minDiff <= 2000) lng = lngByTs[nearest];
            }

            if (lng === undefined || isNaN(lng) || lng === 0) return;
            points.push([lat, lng]);
            lastPlottedTs = ts;
        });

        if (points.length < 2) {
            showPathHistoryStatus('Not enough valid coordinates found (' + points.length + ' pts).', 'error'); return;
        }

        renderHistoricalPath(points);
        showPathHistoryStatus('Showing ' + points.length + ' points.', 'success');

        try { map.fitBounds(L.latLngBounds(points), { padding: [40, 40] }); } catch(e) {}

    } catch(err) {
        console.error('[PathHistory] fetch error:', err);
        showPathHistoryStatus('Request failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-route"></i> Load Path';
    }
}

function renderHistoricalPath(points) {
    clearHistoricalPath();
    if (!map || points.length < 2) return;

    histPathOutlineLayer = L.polyline(points, {
        color: '#1e1b4b', weight: 7, opacity: 0.85, interactive: false
    }).addTo(map);

    histPathLayer = L.polyline(points, {
        color: '#a78bfa', weight: 3, opacity: 0.9, dashArray: '8 5', interactive: false
    }).addTo(map);

    histPathStartMarker = L.circleMarker(points[0], {
        radius: 6, color: '#a78bfa', fillColor: '#a78bfa', fillOpacity: 1,
        weight: 2, interactive: false
    }).addTo(map);

    histPathEndMarker = L.circleMarker(points[points.length - 1], {
        radius: 6, color: '#f472b6', fillColor: '#f472b6', fillOpacity: 1,
        weight: 2, interactive: false
    }).addTo(map);
}

function clearHistoricalPath() {
    [histPathOutlineLayer, histPathLayer, histPathStartMarker, histPathEndMarker].forEach(function(l) {
        if (l && map) { try { map.removeLayer(l); } catch(e) {} }
    });
    histPathOutlineLayer = histPathLayer = histPathStartMarker = histPathEndMarker = null;
    var statusEl = document.getElementById('ph-status');
    if (statusEl && statusEl.className.indexOf('ph-status-success') !== -1) {
        statusEl.textContent = '';
        statusEl.className = 'ph-status';
    }
}

// ══════════════════════════════════════════════════════════
// ── UI NOTIFICATIONS ───────────────────────────────────────
// ══════════════════════════════════════════════════════════

function showNotification(message, type) {
    const notifEl = document.getElementById('top-bar-notification');
    const sepEl = document.getElementById('top-bar-separator');
    if (!notifEl || !sepEl) {
        console.warn('Notification elements not found.');
        return;
    }

    notifEl.textContent = message;
    notifEl.className = 'top-bar-notification top-bar-notif-visible';
    if (type) notifEl.classList.add('top-bar-notif-' + type);
    sepEl.classList.add('top-bar-sep-visible');

    clearTimeout(notifEl._hideTimer);
    notifEl._hideTimer = setTimeout(function() {
        notifEl.className = 'top-bar-notification';
        sepEl.classList.remove('top-bar-sep-visible');
    }, 3500);
}

// ══════════════════════════════════════════════════════════
// ── AB LINE: STATE MANAGEMENT & WORKFLOW ───────────────────
// ══════════════════════════════════════════════════════════

function resetABState() {
    if (abState.zonePolygon) {
        map.removeLayer(abState.zonePolygon);
    }
    abState.lineLayers.forEach(layer => map.removeLayer(layer));
    abState.lineLayers = [];
    abState.lines = [];

    if (abState.pointAMarker) map.removeLayer(abState.pointAMarker);
    if (abState.pointBMarker) map.removeLayer(abState.pointBMarker);
    if (abState.abMidMarker) { map.removeLayer(abState.abMidMarker); abState.abMidMarker = null; }
    if (abState.abLine) { map.removeLayer(abState.abLine); abState.abLine = null; }

    abState.zoneCorners = [];
    abState.zonePolygon = null;
    // Clean up zone corner markers
    if (abState._zoneCornerMarkers) {
        abState._zoneCornerMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e){} });
        abState._zoneCornerMarkers = [];
    }
    // Remove Done button if visible
    var doneBtn = document.getElementById('ab-zone-done-btn');
    if (doneBtn) doneBtn.remove();
    // Remove zone edit markers and confirm button
    clearABZoneEditMarkers();
    var confirmBtn = document.getElementById('ab-zone-confirm-btn');
    if (confirmBtn) confirmBtn.remove();
    abState.pointA = null;
    abState.pointB = null;
    abState.pointAMarker = null;
    abState.pointBMarker = null;
    abState.abMidMarker = null;
    abState.pathLatLngs = [];
    abState.pathOptions = null;
    abState.step = 'idle';
    abState.active = false;
    abState.workflow = 'path-generation';
    abState.abLineFirst = false;
    // Clean up Line Guidance Mode state
    if (abState.lineGuidanceEntryMarkers) {
        abState.lineGuidanceEntryMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e){} });
        abState.lineGuidanceEntryMarkers = [];
    }
    if (abState.robotFollowLine) { try { map.removeLayer(abState.robotFollowLine); } catch(e){} abState.robotFollowLine = null; }
    if (abState.robotFollowHandler) { clearInterval(abState.robotFollowHandler); abState.robotFollowHandler = null; }
    if (abState._guidanceHighlight) { try { map.removeLayer(abState._guidanceHighlight); } catch(e){} abState._guidanceHighlight = null; }
    var lgBtn = document.getElementById('line-guidance-generate-btn');
    if (lgBtn) lgBtn.remove();
    var abSaveBtn = document.getElementById('ab-config-save-btn');
    if (abSaveBtn) abSaveBtn.remove();
    var abSaveLineBtn = document.getElementById('ab-save-line-btn');
    if (abSaveLineBtn) abSaveLineBtn.remove();
    var setBBtn = document.getElementById('ab-set-b-robot-btn');
    if (setBBtn) setBBtn.remove();
    var robotBar = document.getElementById('ab-robot-btn-bar');
    if (robotBar) robotBar.remove();
    // Hide the row spacing panel when AB state is reset
    try { showRowSpacingPanel(false); } catch (err) {}
}

function startABLines() {
    if (lockMode) { showNotification('Widget is locked. Unlock to edit.', 'error'); return; }
    // Hide row spacing panel
    var rowSpacingPanel = document.getElementById('row-spacing-panel');
    if (rowSpacingPanel) rowSpacingPanel.style.display = 'none';
    if (!map) {
        showNotification("Initialize the map before starting AB lines.", "error");
        return;
    }

    const widthValue = 2.4;

    // Remove any existing popup
    var oldPopup = document.getElementById('ab-spacing-popup');
    if (oldPopup) oldPopup.remove();

    var popup = document.createElement('div');
    popup.id = 'ab-spacing-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:320px;border:1px solid rgba(255,255,255,0.12);';

    var title = document.createElement('div');
    title.textContent = 'AB Lines Setup';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    var subtitle = document.createElement('div');
    subtitle.textContent = 'Set row spacing and choose what to define first';
    subtitle.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:20px;text-align:center;';
    popup.appendChild(subtitle);

    var inputLabel = document.createElement('div');
    inputLabel.textContent = 'Row Spacing (m)';
    inputLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    popup.appendChild(inputLabel);

    var spInput = document.createElement('input');
    spInput.type = 'number';
    spInput.min = '0.1';
    spInput.step = '0.1';
    spInput.value = abState.rowSpacing || widthValue;
    spInput.style.cssText = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(55,65,81,0.5);color:#e2e8f0;font-size:15px;font-family:Roboto,sans-serif;margin-bottom:18px;box-sizing:border-box;';
    popup.appendChild(spInput);

    // Section label
    var orderLabel = document.createElement('div');
    orderLabel.textContent = 'What to define first?';
    orderLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px;';
    popup.appendChild(orderLabel);

    // Two large option cards
    var orderRow = document.createElement('div');
    orderRow.style.cssText = 'display:flex;gap:10px;margin-bottom:18px;';

    function makeOrderCard(icon, label, desc, accentColor) {
        var card = document.createElement('button');
        card.style.cssText = 'flex:1;padding:14px 8px 12px;border-radius:10px;border:2px solid rgba(255,255,255,0.12);background:rgba(55,65,81,0.5);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;transition:all 0.15s;text-align:center;';
        card.innerHTML = '<div style="font-size:22px;margin-bottom:6px;">' + icon + '</div>'
            + '<div style="font-size:14px;font-weight:600;margin-bottom:3px;">' + label + '</div>'
            + '<div style="font-size:11px;color:#9ca3af;">' + desc + '</div>';
        card.onmouseenter = function() { card.style.borderColor = accentColor; card.style.background = 'rgba(37,99,235,0.12)'; };
        card.onmouseleave = function() { card.style.borderColor = 'rgba(255,255,255,0.12)'; card.style.background = 'rgba(55,65,81,0.5)'; };
        return card;
    }

    var cardZoneFirst = makeOrderCard('🗺️', 'Zone First', 'Draw zone, then AB line', '#60a5fa');
    var cardABFirst = makeOrderCard('📏', 'AB Line First', 'Set AB line, then zone', '#f59e0b');

    function getSpacingValue() {
        var v = parseFloat(spInput.value);
        if (!Number.isFinite(v) || v <= 0) { showNotification("Invalid row spacing.", "error"); return null; }
        return v;
    }

    // Zone-first sub-options row (shown inside the card flow)
    cardZoneFirst.onclick = function() {
        var spacingValue = getSpacingValue();
        if (!spacingValue) return;
        // show zone sub-choice: Draw or Use Saved
        popup.remove();
        showABZoneFirstPopup(spacingValue, widthValue);
    };

    cardABFirst.onclick = function() {
        var spacingValue = getSpacingValue();
        if (!spacingValue) return;
        popup.remove();
        resetABState();
        abState.active = true;
        abState.abLineFirst = true;
        abState.robotWidth = widthValue;
        abState.rowSpacing = spacingValue;
        abState.step = 'ab-interactive';
        showABWorkflowPopup();
    };

    orderRow.appendChild(cardZoneFirst);
    orderRow.appendChild(cardABFirst);
    popup.appendChild(orderRow);

    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'display:block;width:100%;padding:10px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); };
    popup.appendChild(btnCancel);

    document.body.appendChild(popup);
    spInput.focus();
    spInput.select();
}

// ── Show saved zone selector to use as AB zone ──
async function showABSavedZoneSelector() {
    if (!token) {
        showNotification("Token not available.", "error");
        resetABState();
        return;
    }

    // Fetch inclusion zone keys from ThingsBoard
    var apiEndpoint = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/keys/attributes';
    var keys = [];
    try {
        var resp = await fetch(apiEndpoint, { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } });
        if (resp.ok) {
            var allKeys = await resp.json();
            keys = allKeys.filter(function(k) {
                return (k.startsWith('inclusionzone_') || k.startsWith('zonefile_')) && !k.includes(',');
            }).sort();
        }
    } catch (err) {
        console.error('Error fetching zones for AB:', err);
    }

    // Also offer currently drawn inclusion zones from the map
    var mapZones = inclusionZones.map(function(z, i) {
        return { key: '__map__' + i, label: 'Map zone ' + (i + 1), corners: z.getLatLngs()[0].map(function(c) { return { lat: c.lat, lng: c.lng }; }) };
    });

    if (keys.length === 0 && mapZones.length === 0) {
        showNotification("No saved inclusion zones found. Draw a zone manually.", "info");
        showNotification("AB Lines: draw the operational zone. Tap Done when finished.", "info");
        return;
    }

    var old = document.getElementById('ab-zone-selector-popup');
    if (old) old.remove();

    var popup = document.createElement('div');
    popup.id = 'ab-zone-selector-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:24px 24px 16px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10012;font-family:Roboto,sans-serif;min-width:320px;max-width:400px;border:1px solid rgba(255,255,255,0.12);';

    var title = document.createElement('div');
    title.textContent = 'Select AB Zone';
    title.style.cssText = 'font-size:17px;font-weight:700;margin-bottom:4px;text-align:center;';
    popup.appendChild(title);

    var sub = document.createElement('div');
    sub.textContent = 'Choose a saved inclusion zone to use as the AB zone';
    sub.style.cssText = 'font-size:12px;color:#9ca3af;margin-bottom:14px;text-align:center;';
    popup.appendChild(sub);

    var listDiv = document.createElement('div');
    listDiv.style.cssText = 'max-height:220px;overflow-y:auto;margin-bottom:14px;';

    function applyZoneCorners(corners) {
        popup.remove();
        if (!corners || corners.length < 3) {
            showNotification("Zone has fewer than 3 corners. Draw zone manually.", "error");
            showNotification("AB Lines: draw the operational zone. Tap Done when finished.", "info");
            return;
        }
        abState.zoneCorners = corners.map(function(c) { return { lat: c.lat, lng: c.lng }; });
        var polyCorners = abState.zoneCorners.map(function(c) { return L.latLng(c.lat, c.lng); });
        if (abState.zonePolygon) map.removeLayer(abState.zonePolygon);
        abState.zonePolygon = L.polygon(polyCorners, { color: '#60a5fa', weight: 3, fillOpacity: 0.2 }).addTo(map);
        map.fitBounds(L.latLngBounds(polyCorners), { padding: [40, 40] });
        touchOff(map, 'mousemove', updateABZonePolygon);
        abState.step = 'ab-interactive';
        // Allow corner editing before confirming
        showABZoneEditMarkers();
        showABZoneConfirmButton();
    }

    // Add map zones first
    mapZones.forEach(function(mz) {
        var item = document.createElement('button');
        item.textContent = '🗺 ' + mz.label;
        item.style.cssText = 'display:block;width:100%;padding:9px 12px;margin-bottom:4px;border-radius:8px;border:1px solid rgba(96,165,250,0.25);background:rgba(37,99,235,0.12);color:#93c5fd;cursor:pointer;font-family:Roboto,sans-serif;font-size:13px;text-align:left;';
        item.onclick = function() { applyZoneCorners(mz.corners); };
        listDiv.appendChild(item);
    });

    // Add saved zones from ThingsBoard
    keys.forEach(function(key) {
        var label = key.replace('inclusionzone_', '').replace('zonefile_', '');
        var item = document.createElement('button');
        item.textContent = '🟢 ' + label;
        item.style.cssText = 'display:block;width:100%;padding:9px 12px;margin-bottom:4px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);background:rgba(55,65,81,0.5);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;font-size:13px;text-align:left;';
        item.onmouseenter = function() { item.style.borderColor = 'rgba(96,165,250,0.5)'; item.style.background = 'rgba(37,99,235,0.15)'; };
        item.onmouseleave = function() { item.style.borderColor = 'rgba(255,255,255,0.08)'; item.style.background = 'rgba(55,65,81,0.5)'; };
        item.onclick = async function() {
            try {
                var ep = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/values/attributes/SHARED_SCOPE?keys=' + encodeURIComponent(key);
                var r = await fetch(ep, { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } });
                if (r.ok) {
                    var d = await r.json();
                    var zoneData = (d && d[0]) ? d[0].value : null;
                    if (!zoneData || !zoneData.length) { showNotification("Zone data is empty.", "error"); return; }
                    applyZoneCorners(zoneData);
                } else {
                    showNotification("Failed to load zone. Error: " + r.status, "error");
                }
            } catch(e) {
                showNotification("Error loading zone.", "error");
            }
        };
        listDiv.appendChild(item);
    });

    popup.appendChild(listDiv);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:center;';

    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Draw Manually';
    btnCancel.style.cssText = 'padding:8px 20px;font-size:13px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() {
        popup.remove();
        showNotification("AB Lines: draw the operational zone. Tap Done when finished.", "info");
    };
    btnRow.appendChild(btnCancel);
    popup.appendChild(btnRow);

    document.body.appendChild(popup);
}

// ── Zone-first sub-choice popup (Draw Zone or Use Saved Zone) ──
function showABZoneFirstPopup(spacingValue, widthValue) {
    var old = document.getElementById('ab-zone-first-popup');
    if (old) old.remove();

    resetABState();
    abState.active = true;
    abState.step = 'draw-zone';
    abState.robotWidth = widthValue || 2.4;
    abState.rowSpacing = spacingValue;

    var popup = document.createElement('div');
    popup.id = 'ab-zone-first-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:320px;border:1px solid rgba(255,255,255,0.12);';

    var title = document.createElement('div');
    title.textContent = 'Define the Zone';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    var sub = document.createElement('div');
    sub.textContent = 'Draw a new zone or use a saved one';
    sub.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:22px;text-align:center;';
    popup.appendChild(sub);

    var actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;gap:10px;margin-bottom:10px;';

    var btnDraw = document.createElement('button');
    btnDraw.innerHTML = '<i class="fas fa-draw-polygon" style="margin-right:6px;"></i>Draw Zone';
    btnDraw.style.cssText = 'flex:1;padding:12px 8px;font-size:14px;font-weight:600;border-radius:8px;border:none;background:linear-gradient(135deg,#2563eb,#1e40af);color:#fff;cursor:pointer;font-family:Roboto,sans-serif;';
    btnDraw.onclick = function() {
        popup.remove();
        showNotification("AB Lines: draw the operational zone. Tap Done when finished.", "info");
    };

    var btnSaved = document.createElement('button');
    btnSaved.innerHTML = '<i class="fas fa-layer-group" style="margin-right:6px;"></i>Use Saved Zone';
    btnSaved.style.cssText = 'flex:1;padding:12px 8px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(167,139,250,0.5);background:rgba(91,33,182,0.25);color:#c4b5fd;cursor:pointer;font-family:Roboto,sans-serif;';
    btnSaved.onclick = function() {
        popup.remove();
        showABSavedZoneSelector();
    };

    actRow.appendChild(btnDraw);
    actRow.appendChild(btnSaved);
    popup.appendChild(actRow);

    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'display:block;width:100%;padding:9px;font-size:13px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); resetABState(); };
    popup.appendChild(btnCancel);

    document.body.appendChild(popup);
}

// ── Zone prompt after AB line is defined first ──
function showABLineFirstZonePrompt() {
    var old = document.getElementById('ab-linefirst-zone-popup');
    if (old) old.remove();

    var popup = document.createElement('div');
    popup.id = 'ab-linefirst-zone-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:320px;border:1px solid rgba(255,255,255,0.12);';

    var title = document.createElement('div');
    title.textContent = 'Now Define the Zone';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    var sub = document.createElement('div');
    sub.textContent = 'The zone is needed to generate the AB path';
    sub.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:22px;text-align:center;';
    popup.appendChild(sub);

    var actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;gap:10px;margin-bottom:10px;';

    var btnDraw = document.createElement('button');
    btnDraw.innerHTML = '<i class="fas fa-draw-polygon" style="margin-right:6px;"></i>Draw Zone';
    btnDraw.style.cssText = 'flex:1;padding:12px 8px;font-size:14px;font-weight:600;border-radius:8px;border:none;background:linear-gradient(135deg,#2563eb,#1e40af);color:#fff;cursor:pointer;font-family:Roboto,sans-serif;';
    btnDraw.onclick = function() {
        popup.remove();
        abState.step = 'draw-zone';
        showNotification("Draw the operational zone. Tap Done when finished.", "info");
    };

    var btnSaved = document.createElement('button');
    btnSaved.innerHTML = '<i class="fas fa-layer-group" style="margin-right:6px;"></i>Use Saved Zone';
    btnSaved.style.cssText = 'flex:1;padding:12px 8px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(167,139,250,0.5);background:rgba(91,33,182,0.25);color:#c4b5fd;cursor:pointer;font-family:Roboto,sans-serif;';
    btnSaved.onclick = function() {
        popup.remove();
        showABSavedZoneSelector();
    };

    actRow.appendChild(btnDraw);
    actRow.appendChild(btnSaved);
    popup.appendChild(actRow);

    var btnSkip = document.createElement('button');
    btnSkip.textContent = 'Skip for Now';
    btnSkip.style.cssText = 'display:block;width:100%;padding:9px;font-size:13px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnSkip.onclick = function() { popup.remove(); };
    popup.appendChild(btnSkip);

    document.body.appendChild(popup);
}

function drawABZone(latlng) {
    if (abState.zoneCorners.length === 0) {
        abState.zoneCorners.push(latlng);
        abState.zonePolygon = L.polygon([abState.zoneCorners], {
            color: '#60a5fa',
            weight: 3,
            fillOpacity: 0.2
        }).addTo(map);
        if (!abState._zoneCornerMarkers) abState._zoneCornerMarkers = [];
        abState._zoneCornerMarkers.push(L.circleMarker([latlng.lat, latlng.lng], {
            radius: 7, color: '#fff', weight: 2, fillColor: '#60a5fa', fillOpacity: 1, interactive: false
        }).addTo(map));
        touchOn(map, 'mousemove', updateABZonePolygon);
    } else {
        abState.zoneCorners.push(latlng);
        abState.zonePolygon.setLatLngs(abState.zoneCorners);
        if (!abState._zoneCornerMarkers) abState._zoneCornerMarkers = [];
        abState._zoneCornerMarkers.push(L.circleMarker([latlng.lat, latlng.lng], {
            radius: 7, color: '#fff', weight: 2, fillColor: '#60a5fa', fillOpacity: 1, interactive: false
        }).addTo(map));
    }
    // Show the "Done" button after 3+ corners
    if (abState.zoneCorners.length >= 3) {
        showABZoneDoneButton(true);
    }
}

function updateABZonePolygon(e) {
    if (abState.zoneCorners.length > 0 && abState.zonePolygon) {
        const tempCorners = [...abState.zoneCorners, e.latlng];
        abState.zonePolygon.setLatLngs(tempCorners);
    }
}

function finalizeABZone() {
    if (abState.zoneCorners.length < 3) {
        showNotification("AB zone needs at least 3 corners.", "error");
        if (abState.zonePolygon) map.removeLayer(abState.zonePolygon);
        abState.zonePolygon = null;
        abState.zoneCorners = [];
        // Clean up corner markers
        if (abState._zoneCornerMarkers) {
            abState._zoneCornerMarkers.forEach(function(m) { map.removeLayer(m); });
            abState._zoneCornerMarkers = [];
        }
        showABZoneDoneButton(false);
        return;
    }
    abState.zonePolygon.setLatLngs(abState.zoneCorners);
    touchOff(map, 'mousemove', updateABZonePolygon);
    // Clean up corner markers
    if (abState._zoneCornerMarkers) {
        abState._zoneCornerMarkers.forEach(function(m) { map.removeLayer(m); });
        abState._zoneCornerMarkers = [];
    }
    showABZoneDoneButton(false);
    abState.step = 'ab-interactive';
    // Enable corner dragging before continuing
    showABZoneEditMarkers();
    showABZoneConfirmButton();
}

// Show/hide the floating "Done" button for AB zone drawing
function showABZoneDoneButton(show) {
    var existing = document.getElementById('ab-zone-done-btn');
    if (!show) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return; // already visible
    var btn = document.createElement('button');
    btn.id = 'ab-zone-done-btn';
    btn.innerHTML = '<i class="fas fa-check" style="margin-right:6px;"></i>Done';
    btn.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:10010;padding:10px 28px;font-size:15px;font-weight:700;border-radius:10px;border:2px solid rgba(34,197,94,0.5);background:linear-gradient(135deg,rgba(22,101,52,0.92),rgba(20,83,45,0.95));color:#4ade80;cursor:pointer;font-family:Roboto,sans-serif;box-shadow:0 4px 16px rgba(34,197,94,0.35);backdrop-filter:blur(8px);transition:all 0.18s ease;';
    btn.onmouseenter = function() { btn.style.background = 'linear-gradient(135deg,rgba(34,197,94,0.35),rgba(22,101,52,0.95))'; btn.style.color = '#86efac'; };
    btn.onmouseleave = function() { btn.style.background = 'linear-gradient(135deg,rgba(22,101,52,0.92),rgba(20,83,45,0.95))'; btn.style.color = '#4ade80'; };
    btn.onclick = function() { finalizeABZone(); };
    // Prevent map click through
    btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    btn.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });
    document.getElementById('gps-container').appendChild(btn);
}

// ── AB Zone Corner Editing (drag to reshape after drawing) ──
var _abZoneEditMarkers = [];

function clearABZoneEditMarkers() {
    _abZoneEditMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e){} });
    _abZoneEditMarkers = [];
}

function showABZoneEditMarkers() {
    clearABZoneEditMarkers();
    if (!abState.zonePolygon) return;
    var corners = abState.zonePolygon.getLatLngs()[0];
    corners.forEach(function(corner, idx) {
        var icon = L.divIcon({
            className: '',
            html: '<div style="width:14px;height:14px;background:#60a5fa;border:2px solid white;border-radius:50%;cursor:move;box-shadow:0 2px 6px rgba(0,0,0,0.5);"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });
        var m = L.marker([corner.lat, corner.lng], { icon: icon, draggable: true, zIndexOffset: 2000 }).addTo(map);
        m._abCornerIdx = idx;
        m.on('drag', function(e) {
            var latlngs = abState.zonePolygon.getLatLngs()[0];
            latlngs[m._abCornerIdx] = e.target.getLatLng();
            abState.zonePolygon.setLatLngs(latlngs);
            abState.zoneCorners[m._abCornerIdx] = { lat: e.target.getLatLng().lat, lng: e.target.getLatLng().lng };
        });
        _abZoneEditMarkers.push(m);
    });
}

function showABZoneConfirmButton() {
    var existing = document.getElementById('ab-zone-confirm-btn');
    if (existing) existing.remove();
    var btn = document.createElement('button');
    btn.id = 'ab-zone-confirm-btn';
    btn.innerHTML = '<i class="fas fa-check-circle" style="margin-right:6px;"></i>Confirm Zone';
    btn.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);z-index:10010;padding:10px 28px;font-size:15px;font-weight:700;border-radius:10px;border:2px solid rgba(96,165,250,0.5);background:linear-gradient(135deg,rgba(30,64,175,0.92),rgba(29,78,216,0.95));color:#93c5fd;cursor:pointer;font-family:Roboto,sans-serif;box-shadow:0 4px 16px rgba(37,99,235,0.35);backdrop-filter:blur(8px);transition:all 0.18s ease;white-space:nowrap;';
    btn.onmouseenter = function() { btn.style.background = 'linear-gradient(135deg,rgba(37,99,235,0.5),rgba(30,64,175,0.95))'; btn.style.color = '#bfdbfe'; };
    btn.onmouseleave = function() { btn.style.background = 'linear-gradient(135deg,rgba(30,64,175,0.92),rgba(29,78,216,0.95))'; btn.style.color = '#93c5fd'; };
    btn.onclick = function() { confirmABZone(); };
    btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    btn.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });
    document.getElementById('gps-container').appendChild(btn);
}

function confirmABZone() {
    var confirmBtn = document.getElementById('ab-zone-confirm-btn');
    if (confirmBtn) confirmBtn.remove();
    // Sync zone corners from polygon in case of drags
    if (abState.zonePolygon) {
        abState.zoneCorners = abState.zonePolygon.getLatLngs()[0].map(function(ll) {
            return { lat: ll.lat, lng: ll.lng };
        });
    }
    clearABZoneEditMarkers();
    if (abState.abLineFirst) {
        // AB line was defined first — zone now ready, build lines
        abState.abLineFirst = false;
        buildABLines();
        if (abState.workflow === 'line-guidance') {
            showLineGuidanceEntryPoints();
            showLineGuidanceButton(true);
        }
        showABConfigSaveButton(true);
        showNotification('Zone set. Lines ready!', 'success');
    } else {
        showABWorkflowPopup();
    }
}

// Show workflow selection popup: Path Generation vs Line Guidance
function showABWorkflowPopup() {
    let old = document.getElementById('ab-workflow-popup');
    if (old) old.remove();

    const popup = document.createElement('div');
    popup.id = 'ab-workflow-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:380px;border:1px solid rgba(255,255,255,0.12);';

    const title = document.createElement('div');
    title.textContent = 'AB Line Workflow';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = 'Choose how to use the AB lines';
    subtitle.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:20px;text-align:center;';
    popup.appendChild(subtitle);

    const optRow = document.createElement('div');
    optRow.style.cssText = 'display:flex;gap:10px;margin-bottom:20px;';

    // SVG for Path Generation
    var pathSvg = '<svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<polyline points="8,40 14,28 22,32 30,16 38,20 48,8" stroke="#4ade80" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<circle cx="8" cy="40" r="3" fill="#4ade80"/>'
        + '<circle cx="48" cy="8" r="3" fill="#4ade80"/>'
        + '<line x1="14" y1="8" x2="14" y2="40" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>'
        + '<line x1="22" y1="8" x2="22" y2="40" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>'
        + '<line x1="30" y1="8" x2="30" y2="40" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>'
        + '<line x1="38" y1="8" x2="38" y2="40" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>'
        + '</svg>';

    // SVG for Line Guidance
    var guidanceSvg = '<svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<line x1="10" y1="10" x2="10" y2="40" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 2"/>'
        + '<line x1="22" y1="10" x2="22" y2="40" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 2"/>'
        + '<line x1="34" y1="10" x2="34" y2="40" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round"/>'
        + '<line x1="46" y1="10" x2="46" y2="40" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 2"/>'
        + '<circle cx="34" cy="10" r="3" fill="#22c55e"/>'
        + '<circle cx="34" cy="40" r="3" fill="#22c55e"/>'
        + '<rect x="30" y="22" width="8" height="8" rx="2" fill="#60a5fa" opacity="0.8"/>'
        + '<text x="34" y="28.5" text-anchor="middle" fill="#fff" font-size="6" font-weight="700">R</text>'
        + '</svg>';

    function makeOptBtn(svg, label, desc, accentColor) {
        var btn = document.createElement('button');
        btn.style.cssText = 'flex:1;padding:14px 8px 10px;border-radius:10px;border:2px solid rgba(255,255,255,0.12);background:rgba(55,65,81,0.5);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;transition:all 0.15s;text-align:center;';
        btn.innerHTML = '<div style="display:flex;justify-content:center;margin-bottom:8px;">' + svg + '</div>'
            + '<div style="font-size:14px;font-weight:600;margin-bottom:2px;">' + label + '</div>'
            + '<div style="font-size:11px;color:#9ca3af;">' + desc + '</div>';
        btn.onmouseenter = function() { btn.style.borderColor = accentColor; btn.style.background = 'rgba(37,99,235,0.1)'; };
        btn.onmouseleave = function() { btn.style.borderColor = 'rgba(255,255,255,0.12)'; btn.style.background = 'rgba(55,65,81,0.5)'; };
        return btn;
    }

    var btnPathGen = makeOptBtn(pathSvg, 'Path Generation', 'Full path with U-turns', '#4ade80');
    var btnLineGuide = makeOptBtn(guidanceSvg, 'Line Guidance', 'Navigate one line at a time', '#f59e0b');

    btnPathGen.onclick = function() {
        abState.workflow = 'path-generation';
        popup.remove();
        showABModePopup();
    };

    btnLineGuide.onclick = function() {
        abState.workflow = 'line-guidance';
        popup.remove();
        showABModePopup();
    };

    optRow.appendChild(btnPathGen);
    optRow.appendChild(btnLineGuide);
    popup.appendChild(optRow);

    // Cancel button
    var cancelRow = document.createElement('div');
    cancelRow.style.cssText = 'display:flex;justify-content:center;';
    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'padding:8px 28px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); resetABState(); };
    cancelRow.appendChild(btnCancel);
    popup.appendChild(cancelRow);

    document.body.appendChild(popup);
}

// Show a custom popup for AB mode selection
function showABModePopup() {
    // Remove any existing popup
    let old = document.getElementById('ab-mode-popup');
    if (old) old.remove();

    const popup = document.createElement('div');
    popup.id = 'ab-mode-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:340px;border:1px solid rgba(255,255,255,0.12);';

    // Title
    const title = document.createElement('div');
    title.textContent = 'AB Line Mode';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = 'How do you want to define the AB line?';
    subtitle.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:20px;text-align:center;';
    popup.appendChild(subtitle);

    const optRow = document.createElement('div');
    optRow.style.cssText = 'display:flex;gap:10px;margin-bottom:20px;';

    // SVG for manual draw
    var drawSvg = '<svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<circle cx="12" cy="38" r="5" fill="#22c55e" stroke="#166534" stroke-width="1.5"/>'
        + '<circle cx="44" cy="10" r="5" fill="#ef4444" stroke="#991b1b" stroke-width="1.5"/>'
        + '<line x1="12" y1="38" x2="44" y2="10" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="6 3"/>'
        + '<text x="12" y="42" text-anchor="middle" fill="#fff" font-size="7" font-weight="700" dy="-1">A</text>'
        + '<text x="44" y="14" text-anchor="middle" fill="#fff" font-size="7" font-weight="700" dy="-1">B</text>'
        + '</svg>';



    function makeOptBtn(svg, label, desc, accentColor) {
        var btn = document.createElement('button');
        btn.style.cssText = 'flex:1;padding:14px 8px 10px;border-radius:10px;border:2px solid rgba(255,255,255,0.12);background:rgba(55,65,81,0.5);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;transition:all 0.15s;text-align:center;';
        btn.innerHTML = '<div style="display:flex;justify-content:center;margin-bottom:8px;">' + svg + '</div>'
            + '<div style="font-size:14px;font-weight:600;margin-bottom:2px;">' + label + '</div>'
            + '<div style="font-size:11px;color:#9ca3af;">' + desc + '</div>';
        btn.onmouseenter = function() { btn.style.borderColor = accentColor; btn.style.background = 'rgba(37,99,235,0.1)'; };
        btn.onmouseleave = function() { btn.style.borderColor = 'rgba(255,255,255,0.12)'; btn.style.background = 'rgba(55,65,81,0.5)'; };
        return btn;
    }

    var btnDraw = makeOptBtn(drawSvg, 'Draw AB Line', 'Click A & B on map', '#2563eb');

    // "From Robot" option SVG icon
    var robotSvg = '<svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<rect x="20" y="16" width="16" height="16" rx="3" fill="#60a5fa" stroke="#2563eb" stroke-width="1.5"/>'
        + '<text x="28" y="27" text-anchor="middle" fill="#fff" font-size="8" font-weight="700">R</text>'
        + '<circle cx="12" cy="38" r="4" fill="#22c55e" stroke="#166534" stroke-width="1.5"/>'
        + '<text x="12" y="41" text-anchor="middle" fill="#fff" font-size="6" font-weight="700">A</text>'
        + '<line x1="12" y1="34" x2="28" y2="20" stroke="#60a5fa" stroke-width="2" stroke-dasharray="4 3"/>'
        + '<circle cx="44" cy="10" r="4" fill="#ef4444" stroke="#991b1b" stroke-width="1.5"/>'
        + '<text x="44" y="13" text-anchor="middle" fill="#fff" font-size="6" font-weight="700">B</text>'
        + '<line x1="28" y1="20" x2="44" y2="10" stroke="#60a5fa" stroke-width="2" stroke-dasharray="4 3"/>'
        + '</svg>';
    // "From Robot" option — available in both path-generation and line-guidance
    var btnRobot = makeOptBtn(robotSvg, 'From Robot', 'Use robot position for A & B', '#60a5fa');
    btnRobot.onclick = function() {
        abState.abMode = 'manual';
        abState.pointA = null;
        abState.pointB = null;
        abState.abLineOffset = 0;
        if (abState.abLine) { map.removeLayer(abState.abLine); abState.abLine = null; }
        if (abState.pointAMarker) { map.removeLayer(abState.pointAMarker); abState.pointAMarker = null; }
        if (abState.pointBMarker) { map.removeLayer(abState.pointBMarker); abState.pointBMarker = null; }
        popup.remove();
        showABControls(false);
        document.getElementById('row-spacing-panel').style.display = 'flex';
        document.getElementById('row-spacing-input').value = abState.rowSpacing;
        startABFromRobot();
    };

    btnDraw.onclick = function() {
        abState.abMode = 'manual';
        abState.pointA = null;
        abState.pointB = null;
        abState.abLineOffset = 0;
        abState.step = 'select-a';
        if (abState.abLine) { map.removeLayer(abState.abLine); abState.abLine = null; }
        if (abState.pointAMarker) { map.removeLayer(abState.pointAMarker); abState.pointAMarker = null; }
        if (abState.pointBMarker) { map.removeLayer(abState.pointBMarker); abState.pointBMarker = null; }
        popup.remove();
        showABControls(false);
        document.getElementById('row-spacing-panel').style.display = 'flex';
        document.getElementById('row-spacing-input').value = abState.rowSpacing;
        window.setupABInteractive();
        showNotification('Click map to set A and B points.', 'info');
    };
    // "Import AB Line" option — available in both path-generation and line-guidance
    var importSvg = '<svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<rect x="12" y="8" width="32" height="32" rx="4" stroke="#a78bfa" stroke-width="1.5" fill="none"/>'
        + '<line x1="20" y1="20" x2="36" y2="20" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/>'
        + '<line x1="20" y1="28" x2="36" y2="28" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/>'
        + '<circle cx="16" cy="20" r="2.5" fill="#22c55e"/>'
        + '<circle cx="40" cy="20" r="2.5" fill="#ef4444"/>'
        + '<circle cx="16" cy="28" r="2.5" fill="#22c55e"/>'
        + '<circle cx="40" cy="28" r="2.5" fill="#ef4444"/>'
        + '<polyline points="28,36 28,42 34,39" stroke="#a78bfa" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';
    var btnImport = makeOptBtn(importSvg, 'Import AB Line', 'Choose from saved AB lines', '#a78bfa');
    btnImport.onclick = function() {
        popup.remove();
        showImportABLineSelector();
    };

    // Ensure setupABInteractive is globally available
    window.setupABInteractive = setupABInteractive;

    optRow.appendChild(btnDraw);
    if (btnImport) optRow.appendChild(btnImport);
    if (btnRobot) optRow.appendChild(btnRobot);
    popup.appendChild(optRow);

    // Cancel button
    var cancelRow = document.createElement('div');
    cancelRow.style.cssText = 'display:flex;justify-content:center;';
    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'padding:8px 28px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); resetABState(); };
    cancelRow.appendChild(btnCancel);
    popup.appendChild(cancelRow);

    document.body.appendChild(popup);
}

// ── Import AB Line selector popup for Line Guidance ──
async function showImportABLineSelector() {
    if (!token) {
        showNotification("Token not available.", "error");
        resetABState();
        return;
    }

    // Fetch available AB lines
    var apiEndpoint = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/keys/attributes';
    var keys = [];
    try {
        var response = await fetch(apiEndpoint, {
            headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token }
        });
        if (response.ok) {
            var data = await response.json();
            keys = data.filter(function(k) { return k.startsWith('abline_') && !k.includes(','); }).sort();
        }
    } catch (err) {
        console.error('Error fetching AB lines for import:', err);
    }

    if (keys.length === 0) {
        showNotification("No saved AB lines available. Import a KML first.", "info");
        resetABState();
        return;
    }

    // Build selection popup
    var old = document.getElementById('ab-import-popup');
    if (old) old.remove();

    var popup = document.createElement('div');
    popup.id = 'ab-import-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:340px;max-width:420px;border:1px solid rgba(255,255,255,0.12);';

    var title = document.createElement('div');
    title.textContent = 'Import AB Line';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    var subtitle = document.createElement('div');
    subtitle.textContent = 'Select an AB line to use';
    subtitle.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:16px;text-align:center;';
    popup.appendChild(subtitle);

    var listDiv = document.createElement('div');
    listDiv.style.cssText = 'max-height:240px;overflow-y:auto;margin-bottom:16px;';

    keys.forEach(function(key) {
        var displayName = key.replace('abline_', '');
        var item = document.createElement('button');
        item.textContent = '📏 ' + displayName;
        item.style.cssText = 'display:block;width:100%;padding:10px 14px;margin-bottom:4px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);background:rgba(55,65,81,0.5);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;font-size:14px;text-align:left;transition:all 0.15s;';
        item.onmouseenter = function() { item.style.borderColor = 'rgba(167,139,250,0.6)'; item.style.background = 'rgba(139,92,246,0.15)'; };
        item.onmouseleave = function() { item.style.borderColor = 'rgba(255,255,255,0.08)'; item.style.background = 'rgba(55,65,81,0.5)'; };
        item.onclick = function() {
            popup.remove();
            if (abState.workflow === 'line-guidance') {
                importABLineForGuidance(key);
            } else {
                importABLineForPathGeneration(key);
            }
        };
        listDiv.appendChild(item);

        // Fetch displayName from stored value if available
        (async () => {
            try {
                var ep = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/values/attributes/SHARED_SCOPE?keys=' + encodeURIComponent(key);
                var r = await fetch(ep, { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } });
                if (r.ok) {
                    var d = await r.json();
                    if (d && d[0] && d[0].value && d[0].value.displayName) {
                        item.textContent = '📏 ' + d[0].value.displayName.replace(/,/g, '_');
                    }
                }
            } catch(e) {}
        })();
    });


    popup.appendChild(listDiv);

    var cancelRow = document.createElement('div');
    cancelRow.style.cssText = 'display:flex;justify-content:center;';
    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'padding:8px 28px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); resetABState(); };
    cancelRow.appendChild(btnCancel);
    popup.appendChild(cancelRow);

    document.body.appendChild(popup);
}

// ── Fetch and apply an AB line for Line Guidance mode ──
async function importABLineForGuidance(fullKey) {
    if (!token) {
        showNotification("Token not available.", "error");
        return;
    }

    var apiEndpoint = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/values/attributes/SHARED_SCOPE?keys=' + encodeURIComponent(fullKey);

    try {
        var response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token }
        });

        if (!response.ok) {
            showNotification("Failed to fetch AB line.", "error");
            return;
        }

        var data = await response.json();
        if (!data || !data.length || !data[0]) {
            showNotification("AB line data not found.", "error");
            return;
        }
        var config = data[0].value;
        if (!config || !config.pointA || !config.pointB) {
            showNotification("Invalid AB line data.", "error");
            return;
        }

        // Set A/B in abState
        abState.abMode = 'manual';
        abState.pointA = L.latLng(config.pointA.lat, config.pointA.lng);
        abState.pointB = L.latLng(config.pointB.lat, config.pointB.lng);
        abState.abLineOffset = 0;
        abState.step = 'ab-set';

        // Compute angle from A→B
        var dx = abState.pointB.lng - abState.pointA.lng;
        var dy = abState.pointB.lat - abState.pointA.lat;
        abState.abAngleDeg = Math.atan2(dx, dy) * (180 / Math.PI);

        // Show row spacing panel
        document.getElementById('row-spacing-panel').style.display = 'flex';
        document.getElementById('row-spacing-input').value = abState.rowSpacing;

        // Draw A/B markers and line via setupABInteractive
        setupABInteractive();

        // Build parallel lines in the zone
        buildABLines();

        // Show entry points + generate button for line guidance
        showLineGuidanceEntryPoints();
        showLineGuidanceButton(true);
        showABConfigSaveButton(true);

        // Fit map
        var bounds = L.latLngBounds([abState.pointA, abState.pointB]);
        if (abState.zoneCorners.length >= 3) {
            abState.zoneCorners.forEach(function(c) { bounds.extend(c); });
        }
        map.fitBounds(bounds, { padding: [80, 80] });

        var displayName = (config.displayName) ? config.displayName : fullKey.replace('abline_', '');
        showNotification('AB line "' + displayName + '" imported. Select an entry point or generate waypoints.', 'success');
        if (abState.abLineFirst) showABLineFirstZonePrompt();
    } catch (error) {
        console.error('Error importing AB line:', error);
        showNotification("Error importing AB line.", "error");
    }
}

// ── Fetch and apply an AB line for Path Generation mode ──
async function importABLineForPathGeneration(fullKey) {
    if (!token) {
        showNotification("Token not available.", "error");
        return;
    }

    var apiEndpoint = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/values/attributes/SHARED_SCOPE?keys=' + encodeURIComponent(fullKey);

    try {
        var response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token }
        });

        if (!response.ok) {
            showNotification("Failed to fetch AB line.", "error");
            return;
        }

        var data = await response.json();
        if (!data || !data.length || !data[0]) {
            showNotification("AB line data not found.", "error");
            return;
        }
        var config = data[0].value;
        if (!config || !config.pointA || !config.pointB) {
            showNotification("Invalid AB line data.", "error");
            return;
        }

        // Set A/B in abState
        abState.abMode = 'manual';
        abState.pointA = L.latLng(config.pointA.lat, config.pointA.lng);
        abState.pointB = L.latLng(config.pointB.lat, config.pointB.lng);
        abState.abLineOffset = 0;
        abState.step = 'ab-set';

        // Compute angle from A→B
        var dx = abState.pointB.lng - abState.pointA.lng;
        var dy = abState.pointB.lat - abState.pointA.lat;
        abState.abAngleDeg = Math.atan2(dx, dy) * (180 / Math.PI);

        // Show row spacing panel
        document.getElementById('row-spacing-panel').style.display = 'flex';
        document.getElementById('row-spacing-input').value = abState.rowSpacing;

        // Draw A/B markers and line
        setupABInteractive();

        // Build parallel lines in the zone
        buildABLines();

        // Fit map
        var bounds = L.latLngBounds([abState.pointA, abState.pointB]);
        if (abState.zoneCorners.length >= 3) {
            abState.zoneCorners.forEach(function(c) { bounds.extend(c); });
        }
        map.fitBounds(bounds, { padding: [80, 80] });

        var displayName = (config.displayName) ? config.displayName : fullKey.replace('abline_', '');
        showNotification('AB line "' + displayName + '" imported. Click "Generate AB Path" to create the path.', 'success');
        if (abState.abLineFirst) showABLineFirstZonePrompt();
    } catch (error) {
        console.error('Error importing AB line for path generation:', error);
        showNotification("Error importing AB line.", "error");
    }
}

function showABControls(show) {
    // No-op: angle mode removed
}

function setupABInteractive() {
    // Remove old AB line if any
    // Always clear previous AB line and markers
    if (abState.abLine) { map.removeLayer(abState.abLine); abState.abLine = null; }
    if (abState.pointAMarker) { map.removeLayer(abState.pointAMarker); abState.pointAMarker = null; }
    if (abState.pointBMarker) { map.removeLayer(abState.pointBMarker); abState.pointBMarker = null; }
    if (abState.abMode === 'manual') {
        showABControls(false);
        // Ensure row spacing panel is visible in manual mode so user can adjust spacing
        try {
            showRowSpacingPanel(true);
            var _rsi = document.getElementById('row-spacing-input');
            if (_rsi) _rsi.value = abState.rowSpacing || 8.0;
        } catch (err) {}
        // In manual mode, only draw AB line if both A and B are set
        abState.abLineDraggable = false;
        // Only show A/B markers if set
        if (abState.pointA) abState.pointAMarker = setABPoint(abState.pointA, 'A');
        if (abState.pointB) abState.pointBMarker = setABPoint(abState.pointB, 'B');
        // Only draw AB line if both points are set
        if (abState.pointA && abState.pointB) {
            abState.abLine = L.polyline([abState.pointA, abState.pointB], { color: '#fbbf24', weight: 5, dashArray: '8 8', interactive: true }).addTo(map);
            // Enable right-click parallel drag in manual mode
            abState.abLine.on('contextmenu', function(e) {
                abState.abLineDraggable = true;
                window._abMoveParallelMode = true;
                abState.abLineDragStart = e.latlng;
                // record initial A/B so we can translate them (manual-style)
                abState._pointAStart = { ...abState.pointA };
                abState._pointBStart = { ...abState.pointB };
                // record midpoint start for simple delta translation
                abState._midDragStart = e.latlng;
                abState.abLineDragType = 'parallel';
                map.getContainer().style.cursor = 'grabbing';
                setCustomDragActive(true);
                touchOn(map, 'mousemove', abLineDragMoveHandler);
                touchOn(map, 'mouseup', abLineDragEndHandler);
                showNotification('Drag AB line to move parallel.', 'info');
            });
            // Add or update midpoint marker (uses Leaflet native drag for touch support)
            if (abState.abMidMarker) map.removeLayer(abState.abMidMarker);
            const midLat = (abState.pointA.lat + abState.pointB.lat) / 2;
            const midLng = (abState.pointA.lng + abState.pointB.lng) / 2;
            abState.abMidMarker = createManualMidMarker(midLat, midLng);
            updateABLinesFromAB();
        }
    }
}

// Duplicate abLineDragMoveHandler / abLineDragEndHandler removed —
// the canonical definitions (above) use eventToLatLng() for touch support.



function setABPoint(latlng, label) {
    const markerIcon = L.divIcon({
        className: 'ab-point-marker',
        html: '<div class="ab-point-label">' + label + '</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });

    const marker = L.marker([latlng.lat, latlng.lng], {
        icon: markerIcon,
        zIndexOffset: 1100,
        draggable: true  // Use Leaflet's native drag (works on touch like waypoints)
    }).addTo(map);

    // Native drag event — same approach as waypoint markers
    marker.on('drag', function(e) {
        if (abState.abMode === 'manual' && abState.step === 'lines-ready') {
            var pos = e.target.getLatLng();
            if (label === 'A') {
                abState.pointA = { lat: pos.lat, lng: pos.lng };
            } else {
                abState.pointB = { lat: pos.lat, lng: pos.lng };
            }
            // Update line in place (don't recreate markers)
            if (abState.abLine) {
                abState.abLine.setLatLngs([abState.pointA, abState.pointB]);
            }
            // Move midpoint to stay centered
            if (abState.abMidMarker) {
                var mLat = (abState.pointA.lat + abState.pointB.lat) / 2;
                var mLng = (abState.pointA.lng + abState.pointB.lng) / 2;
                abState.abMidMarker.setLatLng([mLat, mLng]);
            }
            updateABLinesFromAB();
        }
    });

    // Prevent clicks on A/B markers from creating waypoints
    marker.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
    });

    return marker;
}

// Helper: create a draggable midpoint marker for manual AB mode.
// Uses Leaflet's native drag (works on touch like waypoints).
function createManualMidMarker(midLat, midLng) {
    var marker = L.marker([midLat, midLng], {
        icon: L.divIcon({
            className: 'ab-point-marker',
            html: '<div class="ab-point-label">↔</div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        }),
        zIndexOffset: 1100,
        draggable: true
    }).addTo(map);

    marker.on('dragstart', function(e) {
        abState._draggingMidpoint = true;
        abState._midDragStartLatLng = e.target.getLatLng();
        abState._pointAStart = { lat: abState.pointA.lat, lng: abState.pointA.lng };
        abState._pointBStart = { lat: abState.pointB.lat, lng: abState.pointB.lng };
        _suppressNextMapClick = true;
    });

    marker.on('drag', function(e) {
        if (!abState._midDragStartLatLng) return;
        var curr = e.target.getLatLng();
        var dLat = curr.lat - abState._midDragStartLatLng.lat;
        var dLng = curr.lng - abState._midDragStartLatLng.lng;
        abState.pointA = { lat: abState._pointAStart.lat + dLat, lng: abState._pointAStart.lng + dLng };
        abState.pointB = { lat: abState._pointBStart.lat + dLat, lng: abState._pointBStart.lng + dLng };
        // Move A/B markers in place (don't recreate)
        if (abState.pointAMarker) abState.pointAMarker.setLatLng([abState.pointA.lat, abState.pointA.lng]);
        if (abState.pointBMarker) abState.pointBMarker.setLatLng([abState.pointB.lat, abState.pointB.lng]);
        // Update line in place
        if (abState.abLine) abState.abLine.setLatLngs([abState.pointA, abState.pointB]);
        updateABLinesFromAB();
    });

    marker.on('dragend', function() {
        abState._midDragStartLatLng = null;
        abState._pointAStart = null;
        abState._pointBStart = null;
        abState._draggingMidpoint = false;
        setTimeout(function() { _suppressNextMapClick = false; }, 300);
    });

    marker.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
    });

    return marker;
}

function handleABMapClick(latlng) {
    if (!abState.active) return false;
    if (abState._draggingMidpoint) return false; // Prevent waypoint creation while dragging midpoint
    if (abState.abMode === 'manual') {
        if (abState.step === 'draw-zone') {
            drawABZone(latlng);
            return true;
        }
        if (abState.step === 'select-a') {
            abState.pointA = latlng;
            if (abState.pointAMarker) map.removeLayer(abState.pointAMarker);
            abState.pointAMarker = setABPoint(latlng, 'A');
            abState.step = 'select-b';
            showNotification("Select Point B on the map.", "info");
            return true;
        }
        if (abState.step === 'select-b') {
            abState.pointB = latlng;
            if (abState.pointBMarker) map.removeLayer(abState.pointBMarker);
            abState.pointBMarker = setABPoint(latlng, 'B');
            abState.abLine = L.polyline([abState.pointA, abState.pointB], { color: '#fbbf24', weight: 5, dashArray: '8 8', interactive: false }).addTo(map);
            // Add midpoint marker immediately after B is set (uses Leaflet native drag)
            if (abState.abMidMarker) map.removeLayer(abState.abMidMarker);
            const midLat = (abState.pointA.lat + abState.pointB.lat) / 2;
            const midLng = (abState.pointA.lng + abState.pointB.lng) / 2;
            abState.abMidMarker = createManualMidMarker(midLat, midLng);
            abState.step = 'lines-ready';
            updateABLinesFromAB();
            showNotification("AB line set. Lines ready.", "success");
            showSaveABLineButton();
            if (abState.abLineFirst) showABLineFirstZonePrompt();
            return true;
        }
        return false;
    } else {
        if (abState.step === 'draw-zone') {
            drawABZone(latlng);
            return true;
        }
        // In angle mode, ignore map clicks for AB
        return false;
    }
}

// ══════════════════════════════════════════════════════════
// ── MATH UTILITIES (Coordinate & Vector Operations) ────────
// ══════════════════════════════════════════════════════════

function latLngToLocal(latlng, origin) {
    const R = 6378137;
    const dLat = (latlng.lat - origin.lat) * Math.PI / 180;
    const dLng = (latlng.lng - origin.lng) * Math.PI / 180;
    const cosLat = Math.cos(origin.lat * Math.PI / 180);
    return {
        x: dLng * R * cosLat,
        y: dLat * R
    };
}

function localToLatLng(point, origin) {
    const R = 6378137;
    const dLat = point.y / R;
    const dLng = point.x / (R * Math.cos(origin.lat * Math.PI / 180));
    return {
        lat: origin.lat + (dLat * 180 / Math.PI),
        lng: origin.lng + (dLng * 180 / Math.PI)
    };
}

function vecDot(a, b) {
    return a.x * b.x + a.y * b.y;
}

function vecLen(a) {
    return Math.sqrt(a.x * a.x + a.y * a.y);
}

function vecNormalize(a) {
    const length = vecLen(a);
    if (length === 0) return null;
    return { x: a.x / length, y: a.y / length };
}

function vecSub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
}

function vecAdd(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
}

function vecScale(a, s) {
    return { x: a.x * s, y: a.y * s };
}

function cross(a, b) {
    return a.x * b.y - a.y * b.x;
}

function lineSegmentIntersection(p0, d, a, b) {
    const v = vecSub(b, a);
    const denom = cross(d, v);
    if (Math.abs(denom) < 1e-9) return null;

    const ap = vecSub(a, p0);
    const t = cross(ap, v) / denom;
    const u = cross(ap, d) / denom;
    if (u < 0 || u > 1) return null;
    return {
        point: vecAdd(p0, vecScale(d, t)),
        t: t
    };
}

// ══════════════════════════════════════════════════════════
// ── AB PATH GENERATION (Popup, Options & Build) ────────────
// ══════════════════════════════════════════════════════════

function generateABPath() {
    if (!abState.lines || abState.lines.length === 0) {
        showNotification("Generate AB lines first.", "error");
        return;
    }

    // Build a styled popup for AB path options
    let oldPopup = document.getElementById('ab-path-popup');
    if (oldPopup) oldPopup.remove();

    const popup = document.createElement('div');
    popup.id = 'ab-path-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:360px;border:1px solid rgba(255,255,255,0.12);';

    // --- State ---
    let selectedDir = 'A';
    let selectedSnake = true;
    let selectedSensor = false;  // false = waypoints method, true = sensor row follow
    let spacingVal = abState.waypointSpacing || abState.rowSpacing || 1.0;

    // --- Title ---
    const title = document.createElement('div');
    title.textContent = 'Generate AB Path';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:22px;text-align:center;';
    popup.appendChild(title);

    // --- Start Direction ---
    const dirLabel = document.createElement('div');
    dirLabel.textContent = 'Start Direction';
    dirLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    popup.appendChild(dirLabel);

    const dirRow = document.createElement('div');
    dirRow.style.cssText = 'display:flex;gap:10px;margin-bottom:20px;';

    function makeDirBtn(label, desc, isSelected) {
        const btn = document.createElement('button');
        btn.style.cssText = 'flex:1;padding:12px 8px;border-radius:10px;border:2px solid ' + (isSelected ? '#2563eb' : 'rgba(255,255,255,0.12)') + ';background:' + (isSelected ? 'rgba(37,99,235,0.15)' : 'rgba(55,65,81,0.5)') + ';color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;transition:all 0.15s;text-align:center;';
        btn.innerHTML = '<div style="font-size:22px;font-weight:700;margin-bottom:4px;">' + label + '</div><div style="font-size:12px;color:#9ca3af;">' + desc + '</div>';
        btn.dataset.dir = label.includes('A → B') ? 'A' : 'B';
        return btn;
    }

    const btnAtoB = makeDirBtn('A → B', 'Start from A', true);
    const btnBtoA = makeDirBtn('B → A', 'Start from B', false);

    function updateDirBtns() {
        [btnAtoB, btnBtoA].forEach(function(b) {
            const sel = b.dataset.dir === selectedDir;
            b.style.borderColor = sel ? '#2563eb' : 'rgba(255,255,255,0.12)';
            b.style.background = sel ? 'rgba(37,99,235,0.15)' : 'rgba(55,65,81,0.5)';
        });
    }
    btnAtoB.onclick = function() { selectedDir = 'A'; updateDirBtns(); };
    btnBtoA.onclick = function() { selectedDir = 'B'; updateDirBtns(); };

    dirRow.appendChild(btnAtoB);
    dirRow.appendChild(btnBtoA);
    popup.appendChild(dirRow);

    // --- Pattern ---
    const patLabel = document.createElement('div');
    patLabel.textContent = 'Mowing Pattern';
    patLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    popup.appendChild(patLabel);

    const patRow = document.createElement('div');
    patRow.style.cssText = 'display:flex;gap:10px;margin-bottom:20px;';

    // SVG for snake (boustrophedon) pattern
    const snakeSvg = '<svg width="64" height="48" viewBox="0 0 64 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<path d="M8 8 L8 36 Q8 42 14 42 L20 42 Q26 42 26 36 L26 8 Q26 2 32 2 L38 2 Q44 2 44 8 L44 36 Q44 42 50 42 L56 42" stroke="#60a5fa" stroke-width="2.5" fill="none" stroke-linecap="round"/>'
        + '<circle cx="8" cy="8" r="3" fill="#22c55e"/>'
        + '<polygon points="56,38 56,46 60,42" fill="#ef4444"/>'
        + '</svg>';

    // SVG for one-way (same direction) pattern
    const oneWaySvg = '<svg width="64" height="48" viewBox="0 0 64 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<line x1="8" y1="8" x2="8" y2="40" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>'
        + '<line x1="26" y1="8" x2="26" y2="40" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>'
        + '<line x1="44" y1="8" x2="44" y2="40" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>'
        + '<polygon points="5,36 11,36 8,42" fill="#ef4444"/>'
        + '<polygon points="23,36 29,36 26,42" fill="#ef4444"/>'
        + '<polygon points="41,36 47,36 44,42" fill="#ef4444"/>'
        + '<circle cx="8" cy="8" r="3" fill="#22c55e"/>'
        + '<circle cx="26" cy="8" r="3" fill="#22c55e"/>'
        + '<circle cx="44" cy="8" r="3" fill="#22c55e"/>'
        + '</svg>';

    function makePatBtn(svg, label, isSnake, isSelected) {
        const btn = document.createElement('button');
        btn.style.cssText = 'flex:1;padding:12px 8px 8px;border-radius:10px;border:2px solid ' + (isSelected ? '#2563eb' : 'rgba(255,255,255,0.12)') + ';background:' + (isSelected ? 'rgba(37,99,235,0.15)' : 'rgba(55,65,81,0.5)') + ';color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;transition:all 0.15s;text-align:center;';
        btn.innerHTML = '<div style="display:flex;justify-content:center;margin-bottom:6px;">' + svg + '</div><div style="font-size:12px;color:#9ca3af;">' + label + '</div>';
        btn.dataset.snake = isSnake ? '1' : '0';
        return btn;
    }

    const btnSnake = makePatBtn(snakeSvg, 'Snake', true, true);
    const btnOneWay = makePatBtn(oneWaySvg, 'One-way', false, false);

    function updatePatBtns() {
        [btnSnake, btnOneWay].forEach(function(b) {
            const sel = (b.dataset.snake === '1') === selectedSnake;
            b.style.borderColor = sel ? '#2563eb' : 'rgba(255,255,255,0.12)';
            b.style.background = sel ? 'rgba(37,99,235,0.15)' : 'rgba(55,65,81,0.5)';
        });
    }
    btnSnake.onclick = function() { selectedSnake = true; updatePatBtns(); };
    btnOneWay.onclick = function() { selectedSnake = false; updatePatBtns(); };

    patRow.appendChild(btnSnake);
    patRow.appendChild(btnOneWay);
    popup.appendChild(patRow);

    // --- Row Following Method ---
    const rfLabel = document.createElement('div');
    rfLabel.textContent = 'Row Following Method';
    rfLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    popup.appendChild(rfLabel);

    const rfRow = document.createElement('div');
    rfRow.style.cssText = 'display:flex;gap:10px;margin-bottom:20px;';

    // SVG: dense waypoints along each row
    const wpMethodSvg = '<svg width="64" height="48" viewBox="0 0 64 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<line x1="6" y1="12" x2="58" y2="12" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" opacity="0.5"/>'
        + '<line x1="6" y1="24" x2="58" y2="24" stroke="#60a5fa" stroke-width="2" stroke-linecap="round"/>'
        + '<line x1="6" y1="36" x2="58" y2="36" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" opacity="0.5"/>'
        + '<circle cx="6"  cy="24" r="3" fill="#22c55e"/>'
        + '<circle cx="19" cy="24" r="2.5" fill="#60a5fa"/>'
        + '<circle cx="32" cy="24" r="2.5" fill="#60a5fa"/>'
        + '<circle cx="45" cy="24" r="2.5" fill="#60a5fa"/>'
        + '<circle cx="58" cy="24" r="3" fill="#ef4444"/>'
        + '</svg>';

    // SVG: only entry/exit per row, dashed orange (sensor)
    const sensorMethodSvg = '<svg width="64" height="48" viewBox="0 0 64 48" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<line x1="6" y1="12" x2="58" y2="12" stroke="#f97316" stroke-width="2.5" stroke-dasharray="6 4" stroke-linecap="round" opacity="0.55"/>'
        + '<line x1="6" y1="24" x2="58" y2="24" stroke="#f97316" stroke-width="2.5" stroke-dasharray="6 4" stroke-linecap="round"/>'
        + '<line x1="6" y1="36" x2="58" y2="36" stroke="#f97316" stroke-width="2.5" stroke-dasharray="6 4" stroke-linecap="round" opacity="0.55"/>'
        + '<circle cx="6"  cy="24" r="4" fill="#22c55e"/>'
        + '<circle cx="58" cy="24" r="4" fill="#ef4444"/>'
        + '</svg>';

    function makeRfBtn(svg, label, isSensor, isSelected) {
        const btn = document.createElement('button');
        const selColor = isSensor ? '#f97316' : '#2563eb';
        const selBg = isSensor ? 'rgba(249,115,22,0.13)' : 'rgba(37,99,235,0.15)';
        btn.style.cssText = 'flex:1;padding:12px 8px 8px;border-radius:10px;border:2px solid '
            + (isSelected ? selColor : 'rgba(255,255,255,0.12)')
            + ';background:'
            + (isSelected ? selBg : 'rgba(55,65,81,0.5)')
            + ';color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;transition:all 0.15s;text-align:center;';
        btn.innerHTML = '<div style="display:flex;justify-content:center;margin-bottom:6px;">' + svg + '</div>'
            + '<div style="font-size:12px;color:#9ca3af;">' + label + '</div>';
        btn.dataset.sensor = isSensor ? '1' : '0';
        return btn;
    }

    const btnWpMethod = makeRfBtn(wpMethodSvg, 'Waypoints', false, true);
    const btnSensorMethod = makeRfBtn(sensorMethodSvg, 'Sensor Row Follow', true, false);

    function updateRfBtns() {
        [btnWpMethod, btnSensorMethod].forEach(function(b) {
            const isSensor = b.dataset.sensor === '1';
            const sel = isSensor === selectedSensor;
            const selColor = isSensor ? '#f97316' : '#2563eb';
            const selBg = isSensor ? 'rgba(249,115,22,0.13)' : 'rgba(37,99,235,0.15)';
            b.style.borderColor = sel ? selColor : 'rgba(255,255,255,0.12)';
            b.style.background = sel ? selBg : 'rgba(55,65,81,0.5)';
        });
    }
    btnWpMethod.onclick = function() { selectedSensor = false; updateRfBtns(); };
    btnSensorMethod.onclick = function() { selectedSensor = true; updateRfBtns(); };

    rfRow.appendChild(btnWpMethod);
    rfRow.appendChild(btnSensorMethod);
    popup.appendChild(rfRow);

    // --- Action Buttons ---
    const actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'padding:10px 22px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); };

    const btnGenerate = document.createElement('button');
    btnGenerate.textContent = 'Generate Path';
    btnGenerate.style.cssText = 'padding:10px 22px;font-size:14px;font-weight:600;border-radius:8px;border:none;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;cursor:pointer;font-family:Roboto,sans-serif;';
    btnGenerate.onclick = function() {
        const sv = abState.waypointSpacing || spacingVal;
        // waypoint spacing only needed for waypoints method
        if (!selectedSensor && (!Number.isFinite(sv) || sv <= 0)) {
            showNotification("Invalid waypoint spacing.", "error");
            return;
        }

        const options = {
            startDirection: selectedDir,
            snake: selectedSnake,
            waypointSpacing: sv,
            addUTurns: false,
            sensorRowFollow: selectedSensor
        };

        abState.pathOptions = options;
        popup.remove();
        buildABPath(options);
    };

    actRow.appendChild(btnCancel);
    actRow.appendChild(btnGenerate);
    popup.appendChild(actRow);

    document.body.appendChild(popup);
}

function addABUTurns() {
    if (!abState.pathOptions) {
        showNotification("Generate an AB path first.", "error");
        return;
    }

    // Remove any existing popup
    var oldPopup = document.getElementById('ab-uturn-popup');
    if (oldPopup) oldPopup.remove();

    var popup = document.createElement('div');
    popup.id = 'ab-uturn-popup';
    popup.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#1f2937;color:#e2e8f0;padding:28px 28px 20px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.55);z-index:10010;font-family:Roboto,sans-serif;min-width:320px;border:1px solid rgba(255,255,255,0.12);';

    var title = document.createElement('div');
    title.textContent = 'U-Turn Radius';
    title.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:6px;text-align:center;';
    popup.appendChild(title);

    var subtitle = document.createElement('div');
    subtitle.textContent = 'Minimum turning radius for headland turns';
    subtitle.style.cssText = 'font-size:13px;color:#9ca3af;margin-bottom:20px;text-align:center;';
    popup.appendChild(subtitle);

    var inputLabel = document.createElement('div');
    inputLabel.textContent = 'Turning Radius (m)';
    inputLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    popup.appendChild(inputLabel);

    var rInput = document.createElement('input');
    rInput.type = 'number';
    rInput.min = '0.1';
    rInput.step = '0.1';
    rInput.value = abState.minTurningRadius;
    rInput.style.cssText = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(55,65,81,0.5);color:#e2e8f0;font-size:15px;font-family:Roboto,sans-serif;margin-bottom:22px;box-sizing:border-box;';
    popup.appendChild(rInput);

    var actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'padding:10px 22px;font-size:14px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(55,65,81,0.8);color:#e2e8f0;cursor:pointer;font-family:Roboto,sans-serif;';
    btnCancel.onclick = function() { popup.remove(); };

    var btnConfirm = document.createElement('button');
    btnConfirm.textContent = 'Add U-Turns';
    btnConfirm.style.cssText = 'padding:10px 22px;font-size:14px;font-weight:600;border-radius:8px;border:none;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;cursor:pointer;font-family:Roboto,sans-serif;';
    btnConfirm.onclick = function() {
        var radiusValue = parseFloat(rInput.value);
        if (!Number.isFinite(radiusValue) || radiusValue <= 0) {
            showNotification("Invalid turning radius.", "error");
            return;
        }
        abState.minTurningRadius = radiusValue;
        popup.remove();

        var options = Object.assign({}, abState.pathOptions, { addUTurns: true });
        buildABPath(options);
    };

    actRow.appendChild(btnCancel);
    actRow.appendChild(btnConfirm);
    popup.appendChild(actRow);

    document.body.appendChild(popup);
    rInput.focus();
    rInput.select();
}

// ══════════════════════════════════════════════════════════
// ── DUBINS CURVE (Fields2Cover-style U-turns) ──────────────
// ══════════════════════════════════════════════════════════

function mod2pi(angle) {
    var a = angle % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a;
}

function dubinsLSL(d, alpha, beta) {
    var tmp0 = d + Math.sin(alpha) - Math.sin(beta);
    var p_sq = 2 + d * d - 2 * Math.cos(alpha - beta) + 2 * d * (Math.sin(alpha) - Math.sin(beta));
    if (p_sq < 0) return null;
    var tmp1 = Math.atan2(Math.cos(beta) - Math.cos(alpha), tmp0);
    var t = mod2pi(-alpha + tmp1);
    var p = Math.sqrt(p_sq);
    var q = mod2pi(beta - tmp1);
    return { t: t, p: p, q: q, cost: t + p + q };
}

function dubinsRSR(d, alpha, beta) {
    var tmp0 = d - Math.sin(alpha) + Math.sin(beta);
    var p_sq = 2 + d * d - 2 * Math.cos(alpha - beta) + 2 * d * (Math.sin(beta) - Math.sin(alpha));
    if (p_sq < 0) return null;
    var tmp1 = Math.atan2(Math.cos(alpha) - Math.cos(beta), tmp0);
    var t = mod2pi(alpha - tmp1);
    var p = Math.sqrt(p_sq);
    var q = mod2pi(-beta + tmp1);
    return { t: t, p: p, q: q, cost: t + p + q };
}

function dubinsLSR(d, alpha, beta) {
    var p_sq = -2 + d * d + 2 * Math.cos(alpha - beta) + 2 * d * (Math.sin(alpha) + Math.sin(beta));
    if (p_sq < 0) return null;
    var p = Math.sqrt(p_sq);
    var tmp = Math.atan2(-Math.cos(alpha) - Math.cos(beta), d + Math.sin(alpha) + Math.sin(beta)) - Math.atan2(-2, p);
    var t = mod2pi(-alpha + tmp);
    var q = mod2pi(-mod2pi(beta) + tmp);
    return { t: t, p: p, q: q, cost: t + p + q };
}

function dubinsRSL(d, alpha, beta) {
    var p_sq = -2 + d * d + 2 * Math.cos(alpha - beta) - 2 * d * (Math.sin(alpha) + Math.sin(beta));
    if (p_sq < 0) return null;
    var p = Math.sqrt(p_sq);
    var tmp = Math.atan2(Math.cos(alpha) + Math.cos(beta), d - Math.sin(alpha) - Math.sin(beta)) - Math.atan2(2, p);
    var t = mod2pi(alpha - tmp);
    var q = mod2pi(mod2pi(beta) - tmp);
    return { t: t, p: p, q: q, cost: t + p + q };
}

function dubinsRLR(d, alpha, beta) {
    var tmp = (6 - d * d + 2 * Math.cos(alpha - beta) + 2 * d * (Math.sin(alpha) - Math.sin(beta))) / 8;
    if (Math.abs(tmp) > 1) return null;
    var p = mod2pi(2 * Math.PI - Math.acos(tmp));
    var t = mod2pi(alpha - Math.atan2(Math.cos(alpha) - Math.cos(beta), d - Math.sin(alpha) + Math.sin(beta)) + mod2pi(p / 2));
    var q = mod2pi(alpha - beta - t + mod2pi(p));
    return { t: t, p: p, q: q, cost: t + p + q };
}

function dubinsLRL(d, alpha, beta) {
    var tmp = (6 - d * d + 2 * Math.cos(alpha - beta) + 2 * d * (Math.sin(beta) - Math.sin(alpha))) / 8;
    if (Math.abs(tmp) > 1) return null;
    var p = mod2pi(2 * Math.PI - Math.acos(tmp));
    var t = mod2pi(-alpha + Math.atan2(-Math.cos(alpha) + Math.cos(beta), d + Math.sin(alpha) - Math.sin(beta)) + p / 2);
    var q = mod2pi(mod2pi(beta) - alpha - t + mod2pi(p));
    return { t: t, p: p, q: q, cost: t + p + q };
}

function dubinsShortestPath(startPose, endPose, R) {
    // startPose, endPose: {x, y, theta}
    // R: minimum turning radius
    var dx = endPose.x - startPose.x;
    var dy = endPose.y - startPose.y;
    var D = Math.sqrt(dx * dx + dy * dy);
    var d = D / R;
    var theta = Math.atan2(dy, dx);
    var alpha = mod2pi(startPose.theta - theta);
    var beta = mod2pi(endPose.theta - theta);

    var names = ['LSL', 'RSR', 'LSR', 'RSL', 'RLR', 'LRL'];
    var solvers = [dubinsLSL, dubinsRSR, dubinsLSR, dubinsRSL, dubinsRLR, dubinsLRL];
    var candidates = [];

    for (var i = 0; i < solvers.length; i++) {
        var result = solvers[i](d, alpha, beta);
        if (result && isFinite(result.cost) && result.cost >= 0) {
            result.type = names[i];
            candidates.push(result);
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort(function(a, b) { return a.cost - b.cost; });

    var best = candidates[0];
    return {
        type: best.type,
        t: best.t,
        p: best.p,
        q: best.q,
        cost: best.cost,
        R: R,
        startPose: startPose,
        endPose: endPose
    };
}

function sampleDubinsPath(pathDesc, waypointSpacing) {
    // Generate waypoints along a Dubins path
    // Returns array of {x, y} (excluding start, including end)
    var R = pathDesc.R;
    var segments = pathDesc.type.split('');
    var params = [pathDesc.t, pathDesc.p, pathDesc.q];
    var points = [];
    var x = pathDesc.startPose.x;
    var y = pathDesc.startPose.y;
    var theta = pathDesc.startPose.theta;

    for (var s = 0; s < 3; s++) {
        var seg = segments[s];
        var param = params[s];
        if (param < 1e-9) continue;

        if (seg === 'S') {
            // Straight segment, actual length = param * R
            var len = param * R;
            var n = Math.max(1, Math.ceil(len / waypointSpacing));
            for (var i = 1; i <= n; i++) {
                var frac = i / n;
                points.push({
                    x: x + frac * len * Math.cos(theta),
                    y: y + frac * len * Math.sin(theta)
                });
            }
            x += len * Math.cos(theta);
            y += len * Math.sin(theta);
        } else if (seg === 'L') {
            // Left (CCW) arc, angle = param radians
            var arcLen = param * R;
            var n = Math.max(4, Math.ceil(arcLen / waypointSpacing));
            var cx = x - R * Math.sin(theta);
            var cy = y + R * Math.cos(theta);
            for (var i = 1; i <= n; i++) {
                var a = param * i / n;
                points.push({
                    x: cx + R * Math.sin(theta + a),
                    y: cy - R * Math.cos(theta + a)
                });
            }
            x = cx + R * Math.sin(theta + param);
            y = cy - R * Math.cos(theta + param);
            theta += param;
        } else { // 'R'
            // Right (CW) arc, angle = param radians
            var arcLen = param * R;
            var n = Math.max(4, Math.ceil(arcLen / waypointSpacing));
            var cx = x + R * Math.sin(theta);
            var cy = y - R * Math.cos(theta);
            for (var i = 1; i <= n; i++) {
                var a = param * i / n;
                points.push({
                    x: cx - R * Math.sin(theta - a),
                    y: cy + R * Math.cos(theta - a)
                });
            }
            x = cx - R * Math.sin(theta - param);
            y = cy + R * Math.cos(theta - param);
            theta -= param;
        }
    }

    return points;
}

// ── End Dubins Curve Functions ──

function buildABPath(options) {
    if (!abState.pointA || !abState.pointB || abState.lines.length === 0) {
        showNotification("AB path cannot be created yet.", "error");
        return;
    }

    const origin = abState.pointA;
    const bLocal = latLngToLocal(abState.pointB, origin);
    const dir = vecNormalize(bLocal);
    if (!dir) {
        showNotification("Point A and B must be different.", "error");
        return;
    }

    const normal = { x: -dir.y, y: dir.x };

    clearAllWaypointsLoad();
    abState.pathLatLngs = [];

    for (let i = 0; i < abState.lines.length; i++) {
        let start = abState.lines[i].start;
        let end = abState.lines[i].end;

        const projStart = vecDot(start, dir);
        const projEnd = vecDot(end, dir);
        const forward = projStart <= projEnd;
        let useForward = options.startDirection === 'A';
        if (options.snake && i % 2 === 1) useForward = !useForward;

        if ((useForward && !forward) || (!useForward && forward)) {
            const temp = start;
            start = end;
            end = temp;
        }

        if (options.sensorRowFollow) {
            // Sensor row follow: only entry + exit waypoints per row.
            // The segment from entry→exit is marked followRow so the export
            // inserts <FollowRowUntilEndOfRow action_name="follow_row_to_end"/> there.
            const entryLatLng = localToLatLng(start, origin);
            const exitLatLng  = localToLatLng(end,   origin);
            const rowBearing  = computeBearingDegrees(entryLatLng.lat, entryLatLng.lng, exitLatLng.lat, exitLatLng.lng);
            const rowYaw      = (rowBearing - 90 + 360) % 360;
            // Entry point — not a follow-row link (headland/start connects here normally)
            abState.pathLatLngs.push({ lat: entryLatLng.lat, lng: entryLatLng.lng, yaw: rowYaw });
            // Exit point — follow-row link from entry to here
            abState.pathLatLngs.push({ lat: exitLatLng.lat,  lng: exitLatLng.lng,  yaw: rowYaw, followRow: true });
        } else {
            // Waypoints method: dense interpolated waypoints along the row
            const points = interpolateSegmentPoints(start, end, options.waypointSpacing);
            // Add yaw to each waypoint (bearing to next point, or from previous if last)
            // Apply -90° offset to match icon orientation (icon faces east at 0°)
            for (let j = 0; j < points.length; j++) {
                const curr = localToLatLng(points[j], origin);
                let bearing = 0;
                if (j < points.length - 1) {
                    const next = localToLatLng(points[j + 1], origin);
                    bearing = computeBearingDegrees(curr.lat, curr.lng, next.lat, next.lng);
                } else if (j > 0) {
                    const prev = localToLatLng(points[j - 1], origin);
                    bearing = computeBearingDegrees(prev.lat, prev.lng, curr.lat, curr.lng);
                } else if (abState.pathLatLngs.length > 0) {
                    const prev = abState.pathLatLngs[abState.pathLatLngs.length - 1];
                    bearing = computeBearingDegrees(prev.lat, prev.lng, curr.lat, curr.lng);
                }
                const yaw = (bearing - 90 + 360) % 360;
                abState.pathLatLngs.push({ lat: curr.lat, lng: curr.lng, yaw });
            }
        }

        if (options.addUTurns && i < abState.lines.length - 1) {
            // Direction the robot was traveling along this row
            const rowDir = vecNormalize(vecSub(end, start));
            if (!rowDir) continue;

            // Peek at next row's entry point (same swap logic)
            let nextStart = abState.lines[i + 1].start;
            let nextEnd = abState.lines[i + 1].end;
            const projNS = vecDot(nextStart, dir);
            const projNE = vecDot(nextEnd, dir);
            const nextFwd = projNS <= projNE;
            let nextUseFwd = options.startDirection === 'A';
            if (options.snake && (i + 1) % 2 === 1) nextUseFwd = !nextUseFwd;
            if ((nextUseFwd && !nextFwd) || (!nextUseFwd && nextFwd)) {
                const tmp = nextStart;
                nextStart = nextEnd;
                nextEnd = tmp;
            }

            const nextRowDir = vecNormalize(vecSub(nextEnd, nextStart));
            if (!nextRowDir) continue;

            // Dubins curve U-turn (Fields2Cover style)
            const exitHeading = Math.atan2(rowDir.y, rowDir.x);
            const entryHeading = Math.atan2(nextRowDir.y, nextRowDir.x);

            const startPose = { x: end.x, y: end.y, theta: exitHeading };
            const endPose = { x: nextStart.x, y: nextStart.y, theta: entryHeading };
            const R = abState.minTurningRadius;

            const dubinsResult = dubinsShortestPath(startPose, endPose, R);
            if (dubinsResult) {
                const turnPoints = sampleDubinsPathWithYaw(dubinsResult, options.waypointSpacing);
                turnPoints.forEach(function(pt) {
                    const latlng = localToLatLng(pt, origin);
                    abState.pathLatLngs.push({ lat: latlng.lat, lng: latlng.lng, yaw: pt.yaw });
                });
            }
        }
    }

    if (abState.pathLatLngs.length === 0) {
        showNotification("No path waypoints generated.", "error");
        return;
    }

    if (abState.pathLatLngs.length > 5000) {
        showNotification("Too many waypoints generated. Increase spacing.", "error");
        return;
    }

    addWaypointsBatch(abState.pathLatLngs, { skipZoneChecks: true });
    updatePath();
    showNotification("AB path created with " + abState.pathLatLngs.length + " waypoints.", "success");
        // Like sampleDubinsPath, but returns {x, y, yaw} for each point
        function sampleDubinsPathWithYaw(pathDesc, waypointSpacing) {
            var R = pathDesc.R;
            var segments = pathDesc.type.split('');
            var params = [pathDesc.t, pathDesc.p, pathDesc.q];
            var points = [];
            var x = pathDesc.startPose.x;
            var y = pathDesc.startPose.y;
            var theta = pathDesc.startPose.theta;
            for (var s = 0; s < 3; s++) {
                var seg = segments[s];
                var param = params[s];
                if (param < 1e-9) continue;
                if (seg === 'S') {
                    var len = param * R;
                    var n = Math.max(1, Math.ceil(len / waypointSpacing));
                    for (var i = 1; i <= n; i++) {
                        var frac = i / n;
                        points.push({
                            x: x + frac * len * Math.cos(theta),
                            y: y + frac * len * Math.sin(theta),
                            yaw: (-theta * 180 / Math.PI + 360) % 360
                        });
                    }
                    x += len * Math.cos(theta);
                    y += len * Math.sin(theta);
                } else if (seg === 'L') {
                    var arcLen = param * R;
                    var n = Math.max(4, Math.ceil(arcLen / waypointSpacing));
                    var cx = x - R * Math.sin(theta);
                    var cy = y + R * Math.cos(theta);
                    for (var i = 1; i <= n; i++) {
                        var a = param * i / n;
                        points.push({
                            x: cx + R * Math.sin(theta + a),
                            y: cy - R * Math.cos(theta + a),
                            yaw: (-(theta + a) * 180 / Math.PI + 360) % 360
                        });
                    }
                    x = cx + R * Math.sin(theta + param);
                    y = cy - R * Math.cos(theta + param);
                    theta += param;
                } else { // 'R'
                    var arcLen = param * R;
                    var n = Math.max(4, Math.ceil(arcLen / waypointSpacing));
                    var cx = x + R * Math.sin(theta);
                    var cy = y - R * Math.cos(theta);
                    for (var i = 1; i <= n; i++) {
                        var a = param * i / n;
                        points.push({
                            x: cx - R * Math.sin(theta - a),
                            y: cy + R * Math.cos(theta - a),
                            yaw: (-(theta - a) * 180 / Math.PI + 360) % 360
                        });
                    }
                    x = cx - R * Math.sin(theta - param);
                    y = cy + R * Math.cos(theta - param);
                    theta -= param;
                }
            }
            return points;
        }
}

// ══════════════════════════════════════════════════════════
// ── MODE SWITCHING (Waypoint / Polygon / Exclusion) ────────
// ══════════════════════════════════════════════════════════

function setMode(mode) {
    var btnWp = document.getElementById('mode-btn-waypoint');
    var btnInc = document.getElementById('mode-btn-inclusion');
    var btnExc = document.getElementById('mode-btn-exclusion');
    // Toggle off if the same mode is clicked again
    if (currentMode === mode) {
        currentMode = null;
        if (btnWp) btnWp.classList.remove('active');
        if (btnInc) btnInc.classList.remove('active');
        if (btnExc) btnExc.classList.remove('active');
        markers.forEach(function(m) { if (m.dragging) m.dragging.disable(); });
        return;
    }
    currentMode = mode;
    // Update active button styling
    if (btnWp) btnWp.classList.toggle('active', mode === 'waypoint');
    if (btnInc) btnInc.classList.toggle('active', mode === 'polygon');
    if (btnExc) btnExc.classList.toggle('active', mode === 'exclusion-zone');
    // Enable waypoint dragging only in waypoint mode
    markers.forEach(function(m) {
        if (m.dragging) {
            if (mode === 'waypoint') m.dragging.enable();
            else m.dragging.disable();
        }
    });
    if (mode === 'waypoint') {
        showNotification("Now in Waypoint mode. Click to add waypoints.", "success");
    } else if (mode === 'polygon') {
        showNotification("Now in Inclusion Zone mode. Click to draw a polygon.", "success");
    } else if (mode === 'exclusion-zone') {
        showNotification("Now in Exclusion Zone mode. Click to draw a polygon.", "success");
    }
}
// Keep toggleMode as alias for backwards compatibility
function toggleMode() {
    if (currentMode === 'waypoint') setMode('polygon');
    else if (currentMode === 'polygon') setMode('exclusion-zone');
    else setMode('waypoint');
}

// ══════════════════════════════════════════════════════════
// ── API: FETCH INITIAL COORDINATES & MAP INIT ──────────────
// ══════════════════════════════════════════════════════════

async function fetchInitialCoordinates() {
    if (!token) {
        showNotification("Token not available. Please log in first. pushToMap", "error");
        return null; // Explicitly return null if token is not available
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/timeseries?keys=initial_latitude%2Cinitial_longitude`;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (!response.ok) {
            if (response.status === 401) { showJwtExpiredPopup(); return null; }
        }

        const data = await response.json();
        //alert("Telemetry Data: " + JSON.stringify(data, null, 2));
        
        // Extract latitude and longitude with error handling
        const latitude = parseFloat(data.initial_latitude?.[0]?.value || 0).toFixed(7);
        const longitude = parseFloat(data.initial_longitude?.[0]?.value || 0).toFixed(7);

        //alert("Latitude: " + latitude + ", Longitude: " + longitude);

        return {
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
        };
    } catch (error) {
        //alert("Failed to initialize coordinates. Error: " + error.message);
        return null; // Return null if an error occurs
    }
}
    
async function initializeMap() {
    if (!isAlive() || _isInitializing) return;
    _isInitializing = true;
    try {
    // Hide row spacing panel
    var rowSpacingPanel = document.getElementById('row-spacing-panel');
    if (rowSpacingPanel) rowSpacingPanel.style.display = 'none';

    token = localStorage.jwt_token;
      
    if(!token){console.error("Login failed"); return;}

    const coordinates = await fetchInitialCoordinates();
    if (!isAlive()) return; // check after await
    if (!coordinates) {
        showNotification("Coordinates were not fetched correctly.", "error");
        return;
    }

    const { latitude, longitude } = coordinates;
    initialLatLng = {
        lat: latitude,
        lng: longitude
    };

    // Preserve existing waypoints across re-initialization
    const savedWaypoints = latlngs.slice();

    if (map) {
        resetABState();
        map.remove();
        markers = [];
        latlngs = [];
        inclusionZones = [];
        exclusionZones = [];
        polygonCorners = [];
        boundingPolygon = null;
    }

    map = L.map('map', {
        zoomSnap: 0.25,
        zoomDelta: 0.25,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 120,
        // disable default zoom control so we can place it at bottomleft
        zoomControl: false
    }).setView([latitude, longitude], 19);

    // ─── TOUCH: prevent browser scroll/zoom during custom drags ───
    map.getContainer().style.touchAction = 'none';
    map.getContainer().addEventListener('touchmove', function(e) {
        if (_customDragActive) e.preventDefault();
    }, { passive: false });

    const MAPTILER_KEY = "MKqfdLHsCMXLLmGajzHQ";        

    //L.tileLayer(
    //  `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=` + MAPTILER_KEY,
    //  {
    //    tileSize: 256,
    //    maxNativeZoom: 22,
    //    maxZoom: 24,
    //    attribution:
    //      '© MapTiler © OpenStreetMap contributors'
    //  }
    //).addTo(map);
    
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 25,
        maxNativeZoom: 19,
        attribution: ''
    }).addTo(map);

    L.control.scale({
        position: 'bottomleft',
        metric: true,
        imperial: false
    }).addTo(map);

    // Add zoom control at bottom-left instead of the default top-left
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    const initialIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/6153/6153347.png',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
        popupAnchor: [0, 0],
    });

    const initialMarker = L.marker([latitude, longitude], {
        icon: initialIcon,
        interactive: false
    }).addTo(map);
    markers.push(initialMarker);

    distanceControl = L.control({
        position: 'topright'
    });
    distanceControl.onAdd = function () {
        this._div = L.DomUtil.create('div', 'distance-info');
        this.update();
        return this._div;
    };
    distanceControl.update = function (distance) {
        this._div.innerHTML = '<strong>Total Distance:</strong> ' + (distance ? distance.toFixed(0).toLocaleString() + ' meters' : '0 meters');
    };
    distanceControl.addTo(map);

    if (savedWaypoints.length > 0) {
        addWaypointsBatch(savedWaypoints, { skipZoneChecks: true });
    } else {
        await loadTempPath();
        if (!isAlive()) return; // check after await
    }

    widgetIntervals.push(setInterval(UpdateRobotLocation, 500));

    map.on('click', async function (e) {
        // Suppress click that follows a long-press on a waypoint (touch devices)
        if (_suppressNextMapClick) {
            _suppressNextMapClick = false;
            return;
        }
        if (handleABMapClick(e.latlng)) {
            return;
        }
        // Block waypoint/polygon creation while Click & Go is picking A or B
        if (clickGoState.active || clickGoState.picking) {
            return;
        }
        if (navigationMode === 'row-follow') {
            showNotification('Switch to GPS Navigation mode to add waypoints or zones.', 'error');
            return;
        }
        if (currentMode === 'waypoint') {
            // If we're awaiting orientation for the last added waypoint, use this click to set orientation
            if (window._pendingOrientationIndex != null) {
                const idx = window._pendingOrientationIndex;
                setWaypointOrientation(idx, e.latlng);
                window._pendingOrientationIndex = null;
                stopOrientationPreview();
            } else {
                // Add waypoint position and then wait for a second click to set orientation
                const newIdx = await addWaypoint(e.latlng.lat, e.latlng.lng);
                // addWaypoint returns marker index; mark it pending for orientation
                if (typeof newIdx === 'number') {
                    window._pendingOrientationIndex = newIdx;
                    showNotification('Click again to set orientation for waypoint ' + newIdx + '.', 'info');
                    startOrientationPreview(newIdx);
                }
            }
        } else if (currentMode === 'polygon' || currentMode === 'exclusion-zone') {
            drawPolygon(e.latlng);
        }
    });

    map.on('contextmenu', function () {
        // Cancel any pending orientation preview on contextmenu
        if (window._pendingOrientationIndex != null) {
            window._pendingOrientationIndex = null;
            stopOrientationPreview();
        }
        if (abState.active && abState.step === 'draw-zone') {
            finalizeABZone();
            return;
        }
        if (currentMode === 'polygon' || currentMode === 'exclusion-zone') {
            finalizePolygon();
        }
    });

    updatePath();
    updateTBZone();

    robotMarker = null;
    isMapInitialized = true;

    // Fetch saved lists once on map init
    fetchSavedPaths();
    fetchSavedZones();
    fetchSavedABLines();
    fetchSavedABConfigs();
    loadNavigationMode();

    // Fire status polling immediately now that token is available
    updateConnectivityStatus();
    updateStatusBar();
    } finally {
        _isInitializing = false;
    }
}

       async function loadTempPath() {
    if (!token) {
        showNotification("Token not available. Please log in first. pushToMap", "error");
        return;
    }

    const apiEndpoint = "https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=temp";

    try {
        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            const data = await response.json();
            const tempPath = data[0].value;

            latlngs.length = 0; // Clear the latlngs array

            const newLatLngs = [];

            tempPath.forEach((waypoint, index) => {
                const { lat, lng } = waypoint;

                const exists = newLatLngs.some(coord => coord.lat === lat && coord.lng === lng);
                if (exists) return;

                if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(lat, lng, zone.getLatLngs()[0]))) {
                    return;
                }
                if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(lat, lng, zone.getLatLngs()[0]))) {
                    return;
                }

                // preserve yaw if present in temp path
                const yawSrc = (waypoint && (waypoint.yaw || waypoint.y || waypoint.heading || waypoint.orientation));
                const yawVal = (yawSrc !== undefined && yawSrc !== null && yawSrc !== '') ? parseFloat(yawSrc) : null;
                newLatLngs.push({ lat, lng, yaw: yawVal, followRow: !!waypoint.followRow });

                const waypointNumber = (index + 1).toString();
                const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
const imgStyle = 'position:absolute;left:8px;top:8px;width:48px;height:48px;' + (yawVal !== null ? ('transform: rotate(' + yawVal + 'deg);') : '') + 'filter:drop-shadow(0 3px 6px rgba(0,0,0,0.7));';
                const waypointIcon = L.divIcon({
                    className: 'waypoint-icon',
                    html: '<div style="position:relative;width:64px;height:64px">' +
                          '<img src="' + imgSrc + '" style="' + imgStyle + '">' +
                          '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:20px;background:rgba(0,0,0,0.55);color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;border:2px solid rgba(255,255,255,0.7)">' + waypointNumber + '</div>' +
                          '</div>',
                    iconSize: [64, 64],
                    iconAnchor: [32, 32]
                });

                const waypointMarker = L.marker([lat, lng], {
                    icon: waypointIcon,
                    draggable: currentMode === 'waypoint'
                }).addTo(map);

                markers.push(waypointMarker);

                waypointMarker.on('contextmenu', function () {
                    if (currentMode === 'waypoint') {
                        map.removeLayer(waypointMarker);
                        const index = markers.indexOf(waypointMarker);
                        if (index !== -1) {
                            markers.splice(index, 1);
                            newLatLngs.splice(index - 1, 1);
                            latlngs.splice(index - 1, 1);
                            updateWaypointLabels();
                        }
                        updatePath();
                    }
                });

                // Long-press to remove waypoint on touch devices
                attachLongPress(waypointMarker, function() {
                    if (currentMode === 'waypoint') {
                        map.removeLayer(waypointMarker);
                        const index = markers.indexOf(waypointMarker);
                        if (index !== -1) {
                            markers.splice(index, 1);
                            newLatLngs.splice(index - 1, 1);
                            latlngs.splice(index - 1, 1);
                            updateWaypointLabels();
                        }
                        updatePath();
                    }
                });

                waypointMarker.on('drag', function (e) {
                    if (lockMode) { waypointMarker.setLatLng(latlngs[markers.indexOf(waypointMarker) - 1]); return; }
                    const newLatLng = e.target.getLatLng();
                    const index = markers.indexOf(waypointMarker);

                    if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
                        waypointMarker.setLatLng(latlngs[index - 1]);
                        showNotification("Waypoint cannot be moved outside the inclusion zone.", "error");
                        return;
                    }
                    if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
                        waypointMarker.setLatLng(latlngs[index - 1]);
                        showNotification("Waypoint cannot be moved inside the exclusion zone.", "error");
                        return;
                    }

                    if (index > -1) {
                        const prev = latlngs[index - 1] || {};
                        latlngs[index - 1] = {
                            lat: newLatLng.lat,
                            lng: newLatLng.lng,
                            yaw: prev.yaw || null,
                            followRow: !!prev.followRow
                        };
                        updatePath();
                    }
                });

            });

            latlngs.push(...newLatLngs);
            updatePath();
        } else {
            showNotification("Failed to fetch temp path. Error code: " + response.status, "error");
        }
    } catch (error) {
        showNotification("Error fetching temp path: " + error.message, "error");
    }
}

// ══════════════════════════════════════════════════════════
// ── POLYGON DRAWING & ZONE MANAGEMENT ──────────────────────
// ══════════════════════════════════════════════════════════

function drawPolygon(latlng) {
    if (lockMode) return;
    if (polygonCorners.length === 0) {
        polygonCorners.push(latlng);

        const polygonColor = currentMode === 'exclusion-zone' ? "#FF0000" : "#32CD32"; // Red for exclusion, green for inclusion

        boundingPolygon = L.polygon([polygonCorners], {
            color: polygonColor,
            weight: 4,
            fillOpacity: 0.25,
        }).addTo(map);
        
        touchOn(map, 'mousemove', updatePolygon);  // Add mousemove/touchmove event to update polygon dynamically
    } else {
        polygonCorners.push(latlng);
        boundingPolygon.setLatLngs(polygonCorners);
    }
}

function updatePolygon(e) {
    if (polygonCorners.length > 0) {
        const tempCorners = [...polygonCorners, e.latlng];  // Temporarily add the current mouse position
        boundingPolygon.setLatLngs(tempCorners);  // Update the polygon dynamically
    }
}

function finalizePolygon() {
    if (polygonCorners.length < 3) {
        showNotification("A zone must have at least 3 corners to be valid.", "error");

        // Remove the invalid polygon from the map if it exists
        if (boundingPolygon) {
            map.removeLayer(boundingPolygon);
            boundingPolygon = null;
        }

        polygonCorners = [];
        return;
    }

    if (boundingPolygon) {
        boundingPolygon.setLatLngs(polygonCorners);
    }

    // Save the polygon corners for the save button
    savedPolygon = polygonCorners.map(function(corner) {
        return { lat: corner.lat, lng: corner.lng };
    });

    // Capture polygon reference before nulling boundingPolygon
    var thePolygon = boundingPolygon;

    if (currentMode === 'exclusion-zone') {
        savedPolygonType = 'exclusion';
        exclusionZones.push(thePolygon); // Save exclusion zone
        // Make polygon clickable for editing
        thePolygon.on('click', function(e) {
            if (abState.active) { map.fire('click', e); return; } // Pass click through during AB drawing
            enableZoneEditing(thePolygon, 'exclusion');
            savedPolygonType = 'exclusion';
            showNotification("Editing exclusion zone. Drag corners to modify.", "info");
        });
        enableZoneEditing(thePolygon, 'exclusion');
        showNotification("Exclusion Zone ready. Drag corners to edit, click Save to store.", "success");
    } else if (currentMode === 'polygon') {
        savedPolygonType = 'inclusion';
        inclusionZones.push(thePolygon); // Save inclusion zone
        // Make polygon clickable for editing
        thePolygon.on('click', function(e) {
            if (abState.active) { map.fire('click', e); return; } // Pass click through during AB drawing
            enableZoneEditing(thePolygon, 'inclusion');
            savedPolygonType = 'inclusion';
            showNotification("Editing inclusion zone. Drag corners to modify.", "info");
        });
        enableZoneEditing(thePolygon, 'inclusion');
        showNotification("Inclusion Zone ready. Drag corners to edit, click Save to store.", "success");
    }

    polygonCorners = [];
    boundingPolygon = null; // Reset for the next polygon

    updateTBZone();
}

// Zone Editing Functions
function clearEditMarkers() {
    cornerMarkers.forEach(m => map.removeLayer(m));
    midpointMarkers.forEach(m => map.removeLayer(m));
    cornerMarkers = [];
    midpointMarkers = [];
}

function clearZoneMarkers(polygon) {
    if (!polygon) return;
    if (polygon._cornerMarkers) {
        polygon._cornerMarkers.forEach(m => map.removeLayer(m));
        polygon._cornerMarkers = [];
    }
    if (polygon._midpointMarkers) {
        polygon._midpointMarkers.forEach(m => map.removeLayer(m));
        polygon._midpointMarkers = [];
    }
}

function enableZoneEditing(polygon, zoneType) {
    // Clear markers for this specific polygon before recreating
    clearZoneMarkers(polygon);
    
    activeEditZone = polygon;
    activeEditZoneType = zoneType;
    
    // Store zone type on polygon for later reference
    polygon._zoneType = zoneType;
    
    const corners = polygon.getLatLngs()[0];
    createEditMarkers(corners);
}

function createEditMarkers(corners) {
    // Clear markers for the active zone only
    if (activeEditZone) {
        clearZoneMarkers(activeEditZone);
        activeEditZone._cornerMarkers = [];
        activeEditZone._midpointMarkers = [];
    }
    
    const isExclusion = activeEditZoneType === 'exclusion';
    const cornerColor = isExclusion ? '#ef4444' : '#22c55e';
    const midColor = isExclusion ? '#fca5a5' : '#86efac';
    
    // Create corner markers
    corners.forEach((corner, index) => {
        const cornerIcon = L.divIcon({
            className: 'zone-corner-marker',
            html: '<div style="width:14px;height:14px;background:' + cornerColor + ';border:2px solid white;border-radius:50%;cursor:move;box-shadow:0 2px 4px rgba(0,0,0,0.4);"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });
        
        const marker = L.marker([corner.lat, corner.lng], {
            icon: cornerIcon,
            draggable: true,
            zIndexOffset: 1000
        }).addTo(map);
        
        marker._cornerIndex = index;
        marker._parentZone = activeEditZone;
        
        marker.on('drag', function(e) {
            const zone = marker._parentZone;
            const newLatLng = e.target.getLatLng();
            const corners = zone.getLatLngs()[0];
            corners[marker._cornerIndex] = newLatLng;
            zone.setLatLngs(corners);
            updateMidpointMarkersForZone(zone, corners);
            if (zone === activeEditZone) updateSavedPolygon();
        });
        
        marker.on('dragend', function() {
            const zone = marker._parentZone;
            activeEditZone = zone;
            activeEditZoneType = zone._zoneType;
            const corners = zone.getLatLngs()[0];
            createEditMarkers(corners);
            updateTBZone();
        });
        
        // Right-click to delete corner (if more than 3 corners)
        marker.on('contextmenu', function() {
            const zone = marker._parentZone;
            const corners = zone.getLatLngs()[0];
            if (corners.length > 3) {
                corners.splice(marker._cornerIndex, 1);
                zone.setLatLngs(corners);
                activeEditZone = zone;
                activeEditZoneType = zone._zoneType;
                createEditMarkers(corners);
                if (zone === activeEditZone) updateSavedPolygon();
                updateTBZone();
                showNotification("Corner removed.", "info");
            } else {
                showNotification("Zone must have at least 3 corners.", "error");
            }
        });
        
        if (activeEditZone._cornerMarkers) {
            activeEditZone._cornerMarkers.push(marker);
        }
        cornerMarkers.push(marker);
    });
    
    // Create midpoint markers
    createMidpointMarkers(corners);
}

function createMidpointMarkers(corners) {
    // Midpoints are stored on the zone
    if (activeEditZone && !activeEditZone._midpointMarkers) {
        activeEditZone._midpointMarkers = [];
    }
    
    const isExclusion = activeEditZoneType === 'exclusion';
    const midColor = isExclusion ? '#fca5a5' : '#86efac';
    
    for (let i = 0; i < corners.length; i++) {
        const nextIndex = (i + 1) % corners.length;
        const midLat = (corners[i].lat + corners[nextIndex].lat) / 2;
        const midLng = (corners[i].lng + corners[nextIndex].lng) / 2;
        
        const midIcon = L.divIcon({
            className: 'zone-midpoint-marker',
            html: '<div style="width:8px;height:8px;background:' + midColor + ';border:1px solid white;border-radius:50%;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,0.3);opacity:0.7;"></div>',
            iconSize: [8, 8],
            iconAnchor: [4, 4]
        });
        
        const marker = L.marker([midLat, midLng], {
            icon: midIcon,
            draggable: true,
            zIndexOffset: 900
        }).addTo(map);
        
        marker._segmentIndex = i;
        marker._parentZone = activeEditZone;
        
        marker.on('dragstart', function() {
            const zone = marker._parentZone;
            activeEditZone = zone;
            activeEditZoneType = zone._zoneType;
            // Convert midpoint to a new corner
            const corners = zone.getLatLngs()[0];
            const insertIndex = marker._segmentIndex + 1;
            corners.splice(insertIndex, 0, marker.getLatLng());
            zone.setLatLngs(corners);
        });
        
        marker.on('drag', function(e) {
            const zone = marker._parentZone;
            const newLatLng = e.target.getLatLng();
            const corners = zone.getLatLngs()[0];
            const insertIndex = marker._segmentIndex + 1;
            corners[insertIndex] = newLatLng;
            zone.setLatLngs(corners);
        });
        
        marker.on('dragend', function() {
            const zone = marker._parentZone;
            activeEditZone = zone;
            activeEditZoneType = zone._zoneType;
            const corners = zone.getLatLngs()[0];
            createEditMarkers(corners);
            if (zone === activeEditZone) updateSavedPolygon();
            updateTBZone();
            showNotification("New corner added.", "success");
        });
        
        if (activeEditZone._midpointMarkers) {
            activeEditZone._midpointMarkers.push(marker);
        }
        midpointMarkers.push(marker);
    }
}

function updateMidpointMarkers(corners) {
    for (let i = 0; i < midpointMarkers.length && i < corners.length; i++) {
        const nextIndex = (i + 1) % corners.length;
        const midLat = (corners[i].lat + corners[nextIndex].lat) / 2;
        const midLng = (corners[i].lng + corners[nextIndex].lng) / 2;
        midpointMarkers[i].setLatLng([midLat, midLng]);
    }
}

function updateMidpointMarkersForZone(zone, corners) {
    if (!zone._midpointMarkers) return;
    for (let i = 0; i < zone._midpointMarkers.length && i < corners.length; i++) {
        const nextIndex = (i + 1) % corners.length;
        const midLat = (corners[i].lat + corners[nextIndex].lat) / 2;
        const midLng = (corners[i].lng + corners[nextIndex].lng) / 2;
        zone._midpointMarkers[i].setLatLng([midLat, midLng]);
    }
}

function updateSavedPolygon() {
    if (activeEditZone) {
        const corners = activeEditZone.getLatLngs()[0];
        savedPolygon = corners.map(function(corner) {
            return { lat: corner.lat, lng: corner.lng };
        });
    }
}

function disableZoneEditing() {
    // Only clear global references, don't remove markers
    activeEditZone = null;
    activeEditZoneType = null;
}

function removeAllZoneMarkers() {
    // Clear all zone markers (used when reinitializing map)
    inclusionZones.forEach(zone => clearZoneMarkers(zone));
    exclusionZones.forEach(zone => clearZoneMarkers(zone));
    clearEditMarkers();
}
        
function isPointInPolygon(lat, lon, polygon) {
    let numVertices = polygon.length;
    let inside = false;

    let x = lon, y = lat; // Convert to (x, y) for easier comparison
    for (let i = 0; i < numVertices; i++) {
        let { lat: y1, lng: x1 } = polygon[i];
        let { lat: y2, lng: x2 } = polygon[(i + 1) % numVertices];

        // Check if the point is within the y-range of the edge
        if (y > Math.min(y1, y2) && y <= Math.max(y1, y2) && x <= Math.max(x1, x2)) {
            if (y1 !== y2) { // Calculate the intersection point's x-coordinate
                let xIntersection = (y - y1) * (x2 - x1) / (y2 - y1) + x1;
                if (x1 === x2 || x <= xIntersection) { // Check if the ray intersects the edge
                    inside = !inside;
                }
            }
        }
    }
    return inside;
}


// ══════════════════════════════════════════════════════════
// ── WAYPOINT CRUD (Add, Remove, Orientation, Batch) ────────
// ══════════════════════════════════════════════════════════

async function addWaypoint(lat, lng, yaw) {
    // yaw optional (degrees)
    if (lockMode) { showNotification('Widget is locked. Unlock to edit.', 'error'); return null; }
    const exists = latlngs.some(coord => coord.lat === lat && coord.lng === lng && (coord.yaw === yaw || (!coord.yaw && !yaw)));
    if (exists) return null;

    if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(lat, lng, zone.getLatLngs()[0]))) {
        showNotification("Waypoint must be inside the inclusion zone.", "error");
        return null;
    }

    if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(lat, lng, zone.getLatLngs()[0]))) {
        showNotification("Waypoint cannot be inside the exclusion zone.", "error");
        return null;
    }

    const waypointNumber = (latlngs.length + 1).toString();
    const yawDeg = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : null;
    const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
    const imgStyle = 'position:absolute;left:8px;top:8px;width:48px;height:48px;' + (yawDeg !== null ? ('transform: rotate(' + yawDeg + 'deg);') : '') + 'filter:drop-shadow(0 3px 6px rgba(0,0,0,0.7));';
    const waypointIcon = L.divIcon({
        className: 'waypoint-icon',
        html: '<div style="position:relative;width:64px;height:64px">' +
              '<img src="' + imgSrc + '" style="' + imgStyle + '">' +
              '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:20px;background:rgba(0,0,0,0.55);color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;border:2px solid rgba(255,255,255,0.7)">' + waypointNumber + '</div>' +
              '</div>',
        iconSize: [64, 64],
        iconAnchor: [32, 32]
    });

    const waypointMarker = L.marker([lat, lng], {
        icon: waypointIcon,
        draggable: currentMode === 'waypoint',
        zIndexOffset: 200
    }).addTo(map);

    markers.push(waypointMarker);
    // Mark the segment leading into this waypoint as follow-row if mode is active
    const isFollowRowSegment = followRowMode && latlngs.length > 0;
    latlngs.push({ lat, lng, yaw: yawDeg, followRow: isFollowRowSegment });

    waypointMarker.on('contextmenu', function () {
        if (lockMode) return;
        if (currentMode === 'waypoint') {
            map.removeLayer(waypointMarker);
            const index = markers.indexOf(waypointMarker);
            if (index !== -1) {
                markers.splice(index, 1);
                latlngs.splice(index - 1, 1);
                updateWaypointLabels();
            }
            updatePath();
        }
    });

    // Long-press to remove waypoint on touch devices
    attachLongPress(waypointMarker, function() {
        if (lockMode) return;
        if (currentMode === 'waypoint') {
            map.removeLayer(waypointMarker);
            const index = markers.indexOf(waypointMarker);
            if (index !== -1) {
                markers.splice(index, 1);
                latlngs.splice(index - 1, 1);
                updateWaypointLabels();
            }
            updatePath();
        }
    });

    waypointMarker.on('drag', function (e) {
        if (lockMode) { waypointMarker.setLatLng(latlngs[markers.indexOf(waypointMarker) - 1]); return; }
        const newLatLng = e.target.getLatLng();
        const index = markers.indexOf(waypointMarker);

        if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
            waypointMarker.setLatLng(latlngs[index - 1]);
            showNotification("Waypoint cannot be moved outside the inclusion zone.", "error");
            return;
        }

        if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
            waypointMarker.setLatLng(latlngs[index - 1]);
            showNotification("Waypoint cannot be moved inside the exclusion zone.", "error");
            return;
        }

        if (index > 0) {
            // preserve yaw and followRow if present
            const prev = latlngs[index - 1] || {};
            latlngs[index - 1] = { lat: newLatLng.lat, lng: newLatLng.lng, yaw: prev.yaw || null, followRow: !!prev.followRow };
            updatePath();
        }
    });

    updatePath();
    // return 1-based index for pending orientation selection
    return latlngs.length;
}

// Compute bearing (degrees, 0 = north, clockwise) from (lat1,lng1) to (lat2,lng2)
function computeBearingDegrees(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

// Set orientation for waypoint given 1-based index and a latlng target
function setWaypointOrientation(index1based, latlng) {
    const idx = index1based - 1;
    if (idx < 0 || idx >= latlngs.length) return;
    const wp = latlngs[idx];
    // Adjust by -90° to align the icon's graphic forward direction
    let yawDeg = computeBearingDegrees(wp.lat, wp.lng, latlng.lat, latlng.lng);
    yawDeg = (yawDeg - 90 + 360) % 360;
    wp.yaw = yawDeg;
    const marker = markers[idx + 1];
    if (marker) {
        // Build icon: image rotated by yaw, number stays unrotated on top
        const waypointNumber = (idx + 1).toString();
        const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
        // Larger waypoint icon for better visibility
        const imgStyle = 'position:absolute;left:8px;top:8px;width:48px;height:48px;transform: rotate(' + yawDeg + 'deg);filter:drop-shadow(0 3px 6px rgba(0,0,0,0.7));';
        const waypointIcon = L.divIcon({
            className: 'waypoint-icon',
            html: '<div style="position:relative;width:64px;height:64px">' +
                  '<img src="' + imgSrc + '" style="' + imgStyle + '">' +
                  '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:20px;background:rgba(0,0,0,0.55);color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;border:2px solid rgba(255,255,255,0.7)">' + waypointNumber + '</div>' +
                  '</div>',
            iconSize: [64, 64],
            iconAnchor: [32, 32]
        });
        marker.setIcon(waypointIcon);
    }
    updatePath();
    showNotification('Orientation set for waypoint ' + (idx + 1) + ' (' + Math.round(yawDeg) + '°).', 'success');
}

// Orientation preview while awaiting second click: show arrow pointing to mouse
function startOrientationPreview(index1based) {
    const idx = index1based - 1;
    if (idx < 0 || idx >= latlngs.length) return;
    const wp = latlngs[idx];
    const lat = wp.lat, lng = wp.lng;
    stopOrientationPreview();
    const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
    // Use a larger, crisp GREEN SVG arrow for the orientation preview
    const icon = L.divIcon({
        className: 'waypoint-preview-icon',
            html: '<div style="position:relative;width:56px;height:56px">' +
                '<svg id="__wp_preview_img" viewBox="-28 -28 56 56" xmlns="http://www.w3.org/2000/svg" style="width:56px;height:56px;transform: rotate(0deg);opacity:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.45));">' +
                '<g transform="translate(0,0)">' +
                '<path d="M0 -20 L9 -3 L4 -3 L4 20 L-4 20 L-4 -3 L-9 -3 Z" fill="#22c55e" stroke="#065f46" stroke-width="0.8"/> ' +
                '<circle cx="0" cy="0" r="4" fill="#ffffff" stroke="#065f46" stroke-width="0.8"/> ' +
                '</g>' +
                '</svg>' +
                '</div>',
        iconSize: [56, 56],
        iconAnchor: [28, 28]
    });
    // remember preview index and hide the underlying waypoint marker for clarity while previewing
    window._orientationPreview_index = index1based;
    const markerToHide = markers[idx + 1];
    if (markerToHide) {
        try { window._orientationPreview_origOpacity = markerToHide.options && markerToHide.options.opacity != null ? markerToHide.options.opacity : markerToHide._icon && markerToHide._icon.style.opacity ? parseFloat(markerToHide._icon.style.opacity) : 1; } catch(e) { window._orientationPreview_origOpacity = 1; }
        try { markerToHide.setOpacity(0); } catch (e) { if (markerToHide._icon) markerToHide._icon.style.opacity = 0; }
    }
    window._orientationPreviewMarker = L.marker([lat, lng], { icon: icon, interactive: false }).addTo(map);
    // attach mousemove handler to update rotation
    window._orientationPreviewHandler = function(e) {
        if (!window._pendingOrientationIndex) return;
        const wp = latlngs[window._pendingOrientationIndex - 1];
        if (!wp) return;
        // Compute bearing and apply same -90° correction as stored yaw
        let bearing = computeBearingDegrees(wp.lat, wp.lng, e.latlng.lat, e.latlng.lng);
        bearing = (bearing + 360) % 360;
        const img = document.getElementById('__wp_preview_img');
        if (img) img.style.transform = 'rotate(' + bearing + 'deg)';
    };
    touchOn(map, 'mousemove', window._orientationPreviewHandler);
}

function stopOrientationPreview() {
    try {
        if (window._orientationPreviewMarker) { map.removeLayer(window._orientationPreviewMarker); window._orientationPreviewMarker = null; }
        if (window._orientationPreviewHandler) { touchOff(map, 'mousemove', window._orientationPreviewHandler); window._orientationPreviewHandler = null; }
        // restore any hidden waypoint marker
        if (window._orientationPreview_index) {
            const restoreIdx1 = window._orientationPreview_index;
            const idx = restoreIdx1 - 1;
            const markerToRestore = markers[idx + 1];
            if (markerToRestore) {
                try { markerToRestore.setOpacity(window._orientationPreview_origOpacity != null ? window._orientationPreview_origOpacity : 1); } catch (e) { if (markerToRestore._icon) markerToRestore._icon.style.opacity = window._orientationPreview_origOpacity != null ? window._orientationPreview_origOpacity : 1; }
            }
            window._orientationPreview_origOpacity = null;
            window._orientationPreview_index = null;
        }
    } catch (e) { console.warn('Error stopping orientation preview', e); }
}

function addWaypointsBatch(points, options) {
    if (!points || points.length === 0) return;
    const settings = Object.assign({ skipZoneChecks: false }, options || {});
    const existing = new Set(latlngs.map(coord => coord.lat + ',' + coord.lng));
    const newLatLngs = [];

    points.forEach(point => {
        const key = point.lat + ',' + point.lng;
        if (existing.has(key)) return;

        if (!settings.skipZoneChecks) {
            if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(point.lat, point.lng, zone.getLatLngs()[0]))) {
                return;
            }
            if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(point.lat, point.lng, zone.getLatLngs()[0]))) {
                return;
            }
        }

        existing.add(key);
        newLatLngs.push(point);
    });

    newLatLngs.forEach(point => {
        const waypointNumber = (latlngs.length + 1).toString();
        const yawDeg = (point && typeof point.yaw === 'number' && isFinite(point.yaw)) ? point.yaw : null;
        const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
        const imgStyle = 'position:absolute;left:8px;top:8px;width:48px;height:48px;' + (yawDeg !== null ? ('transform: rotate(' + yawDeg + 'deg);') : '') + 'filter:drop-shadow(0 3px 6px rgba(0,0,0,0.7));';
        const waypointIcon = L.divIcon({
            className: 'waypoint-icon',
            html: '<div style="position:relative;width:64px;height:64px">' +
                  '<img src="' + imgSrc + '" style="' + imgStyle + '">' +
                  '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:20px;background:rgba(0,0,0,0.55);color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;border:2px solid rgba(255,255,255,0.7)">' + waypointNumber + '</div>' +
                  '</div>',
            iconSize: [64, 64],
            iconAnchor: [32, 32]
        });

        const waypointMarker = L.marker([point.lat, point.lng], {
            icon: waypointIcon,
            draggable: currentMode === 'waypoint',
            zIndexOffset: 200
        }).addTo(map);

        markers.push(waypointMarker);
        latlngs.push({ lat: point.lat, lng: point.lng, yaw: yawDeg, followRow: !!point.followRow });

        waypointMarker.on('contextmenu', function () {
            if (currentMode === 'waypoint') {
                map.removeLayer(waypointMarker);
                const index = markers.indexOf(waypointMarker);
                if (index !== -1) {
                    markers.splice(index, 1);
                    latlngs.splice(index - 1, 1);
                    updateWaypointLabels();
                }
                updatePath();
            }
        });

        // Long-press to remove waypoint on touch devices
        attachLongPress(waypointMarker, function() {
            if (currentMode === 'waypoint') {
                map.removeLayer(waypointMarker);
                const index = markers.indexOf(waypointMarker);
                if (index !== -1) {
                    markers.splice(index, 1);
                    latlngs.splice(index - 1, 1);
                    updateWaypointLabels();
                }
                updatePath();
            }
        });

        waypointMarker.on('drag', function (e) {
            if (lockMode) { waypointMarker.setLatLng(latlngs[markers.indexOf(waypointMarker) - 1]); return; }
            const newLatLng = e.target.getLatLng();
            const index = markers.indexOf(waypointMarker);

            if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
                waypointMarker.setLatLng(latlngs[index - 1]);
                showNotification("Waypoint cannot be moved outside the inclusion zone.", "error");
                return;
            }

            if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
                waypointMarker.setLatLng(latlngs[index - 1]);
                showNotification("Waypoint cannot be moved inside the exclusion zone.", "error");
                return;
            }

            if (index > 0) {
                const prev = latlngs[index - 1] || {};
                latlngs[index - 1] = { lat: newLatLng.lat, lng: newLatLng.lng, yaw: prev.yaw || null, followRow: !!prev.followRow };
                updatePath();
            }
        });
    });
}

// ══════════════════════════════════════════════════════════
// ── ROUTE & ZONE SAVE / LOAD / DELETE (ThingsBoard API) ────
// ══════════════════════════════════════════════════════════

async function saveRoute() {
    if (currentMode === 'waypoint') {
        if (latlngs.length === 0) {
            showNotification("No waypoints to save.", "info");
            return;
        }
        
        const routeName = prompt("Enter the name for this route:");
        if (!routeName) {
            showNotification("Route name is required to save.", "error");
            return;
        }
        
        // Concatenate the route name with 'pathfile_'
        const attributeData = {};
        attributeData['pathfile_' + routeName] = latlngs;  // Concatenating the key
    
        const apiEndpoint = "https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE";
    
        if (!token) {
            showNotification("Token not available. Please log in first.", "error");
            return;
        }
    
        try {
            const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(attributeData)
            });
        
            if (response.ok) {
                showNotification("Route Added to Dashboard Successfully", "success");
                fetchSavedPaths();
            } else {
                const errorData = await response.json(); // Read the response body
                showNotification("Failed to update ThingsBoard. Error: " , "error");
            }
        } catch (error) {
            console.error("Error updating ThingsBoard:", error);
            showNotification("Error updating ThingsBoard.", "error");
        }
    } 
    
    else {
        // polygon saving
        if (savedPolygon.length == 0) {
            showNotification("No zone to save. Draw a zone first and right-click to finalize.", "info");
            return;
        }
        
        // Determine zone type prefix
        const zoneTypePrefix = savedPolygonType === 'exclusion' ? 'exclusionzone_' : 'inclusionzone_';
        const zoneTypeLabel = savedPolygonType === 'exclusion' ? 'exclusion' : 'inclusion';
        
        const zoneName = prompt("Enter the name for this " + zoneTypeLabel + " zone:");
        
        if (!zoneName) {
            showNotification("Zone name is required to save.", "error");
            return;
        }
    
        // Save with zone type prefix
        const attributeData = {};
        attributeData[zoneTypePrefix + zoneName] = savedPolygon;
        
        //alert("Attribute data being sent: " + JSON.stringify(attributeData)); // Debug: Show the attribute data being sent
        
        const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`;
        //alert("API Endpoint: " + apiEndpoint);  // Debug: Show the API endpoint
        
        if (!token) {
            alert("Token is missing. Please log in first.");
            return;
        }
    
        try {
            const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(attributeData)
            });
    
            if (response.ok) {
                showNotification(savedPolygonType.charAt(0).toUpperCase() + savedPolygonType.slice(1) + " zone saved successfully.", "success");
                disableZoneEditing(); // Clear edit markers
                savedPolygon = []; // Clear after saving
                savedPolygonType = null; // Clear type after saving
                fetchSavedZones(); // Refresh the zones list
            } else {
                const errorData = await response.json();
                showNotification("Failed to save zone. Error: " + response.status, "error");
            }
        } catch (error) {
            //alert("Error during fetch: " + error.message);  // Show the error message
        }
    }
}

function loadRoute(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const text = e.target.result;

        // Detect KML files by extension or content
        if (file.name.toLowerCase().endsWith('.kml') || text.trimStart().startsWith('<?xml') && text.includes('<kml')) {
            importKML(text);
            return;
        }

        try {
            const yamlData = jsyaml.load(text);
            if (!yamlData || !yamlData.waypoints) {
                showNotification("Invalid YAML format.", "error");
                return;
            }

            clearAllWaypointsLoad();
            yamlData.waypoints.forEach(waypoint => {
                const { latitude, longitude, yaw } = waypoint;
                // Add waypoint to map using the loaded coordinates (include yaw if present)
                const yawVal = yaw !== undefined && yaw !== null ? parseFloat(yaw) : undefined;
                addWaypoint(parseFloat(latitude), parseFloat(longitude), yawVal);
            });
            showNotification("Route loaded successfully.", "success");
        } catch (error) {
            showNotification("Error loading YAML: ", "error");
            console.error(error);
        }
    };
    reader.readAsText(file);
    // Reset value so same file can be loaded again
    event.target.value = '';
}

// ══════════════════════════════════════════════
// ── KML Import ──
// ══════════════════════════════════════════════

async function importKML(text) {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }

    var parser = new DOMParser();
    var xmlDoc = parser.parseFromString(text, 'text/xml');

    if (xmlDoc.querySelector('parsererror')) {
        showNotification("Invalid KML file.", "error");
        return;
    }

    // Helper: parse "lng,lat,alt" coordinate string into array of {lat, lng}
    function parseCoordinates(coordText) {
        return coordText.trim().split(/\s+/).map(function(c) {
            var parts = c.split(',');
            if (parts.length < 2) return null;
            return { lat: parseFloat(parts[1]), lng: parseFloat(parts[0]) };
        }).filter(function(p) { return p !== null && !isNaN(p.lat) && !isNaN(p.lng); });
    }

    // Helper: get ExtendedData value by name
    function getExtData(placemark, name) {
        var dataEls = placemark.querySelectorAll('ExtendedData Data');
        for (var i = 0; i < dataEls.length; i++) {
            if (dataEls[i].getAttribute('name') === name) {
                var val = dataEls[i].querySelector('value');
                return val ? val.textContent.trim() : null;
            }
        }
        return null;
    }

    // Helper: get styleUrl text (without leading #)
    function getStyleUrl(placemark) {
        var su = placemark.querySelector('styleUrl');
        return su ? su.textContent.trim().replace(/^#/, '') : '';
    }

    // Collect all Placemarks
    var allPlacemarks = xmlDoc.querySelectorAll('Placemark');

    var routes = [];        // {name, waypoints: [{lat,lng}]}
    var inclusionZonesKml = []; // {name, corners: [{lat,lng}]}
    var exclusionZonesKml = []; // {name, corners: [{lat,lng}]}

    // Track AB lines extracted from wayline placemarks
    var abLines = [];

    for (var i = 0; i < allPlacemarks.length; i++) {
        var pm = allPlacemarks[i];
        var styleUrl = getStyleUrl(pm);
        var mapType = getExtData(pm, 'MapType');
        var nameEl = pm.querySelector('name');
        var pmName = nameEl ? nameEl.textContent.trim() : '';

        // ── Boundary (MapType=5, BoundaryStyle) → inclusion zone ──
        if (mapType === '5' || styleUrl === 'BoundaryStyle') {
            var lineStr = pm.querySelector('LineString coordinates');
            if (lineStr) {
                var corners = parseCoordinates(lineStr.textContent);
                // Remove duplicate closing point if present
                if (corners.length > 1 &&
                    corners[0].lat === corners[corners.length - 1].lat &&
                    corners[0].lng === corners[corners.length - 1].lng) {
                    corners.pop();
                }
                if (corners.length >= 3) {
                    inclusionZonesKml.push({
                        name: pmName || 'Boundary_' + (inclusionZonesKml.length + 1),
                        corners: corners
                    });
                }
            }
        }

        // ── AreaObstacle (MapType=3, AreaObstacleStyle) → exclusion zone ──
        else if (mapType === '3' || styleUrl === 'AreaObstacleStyle') {
            var polyCoords = pm.querySelector('Polygon outerBoundaryIs LinearRing coordinates');
            if (polyCoords) {
                var corners = parseCoordinates(polyCoords.textContent);
                // Remove duplicate closing point
                if (corners.length > 1 &&
                    corners[0].lat === corners[corners.length - 1].lat &&
                    corners[0].lng === corners[corners.length - 1].lng) {
                    corners.pop();
                }
                if (corners.length >= 3) {
                    exclusionZonesKml.push({
                        name: pmName || 'Obstacle_' + (exclusionZonesKml.length + 1),
                        corners: corners
                    });
                }
            }
        }

        // ── Wayline routes (MapType=1, WaylineStyle) ──
        else if (mapType === '1' || styleUrl === 'WaylineStyle') {
            var waylineType = getExtData(pm, 'WaylineType');
            // Skip WaylineType 3 (drainage/obstacle waylines — not needed)
            if (waylineType === '3') continue;

            var lineCoords = pm.querySelector('LineString coordinates');
            if (lineCoords) {
                var waypoints = parseCoordinates(lineCoords.textContent);
                // WaylineType 0 with 4 waypoints → AB line from first 2 points
                if (waylineType === '0' && waypoints.length >= 4) {
                    abLines.push({
                        name: pmName || 'AB_' + (abLines.length + 1),
                        pointA: waypoints[0],
                        pointB: waypoints[1]
                    });
                }
                // WaylineType 2 → AB line from first 2 coordinates
                else if (waylineType === '2' && waypoints.length >= 2) {
                    abLines.push({
                        name: pmName || 'AB_' + (abLines.length + 1),
                        pointA: waypoints[0],
                        pointB: waypoints[1]
                    });
                }
                // All other waylines with >=2 points → route
                else if (waypoints.length >= 2) {
                    routes.push({
                        name: pmName || 'Route_' + (routes.length + 1),
                        waypoints: waypoints
                    });
                }
            }
        }

        // ── Headland (MapType=6) → extract interior/exterior as zones ──
        else if (mapType === '6') {
            var multiGeo = pm.querySelector('MultiGeometry');
            if (multiGeo) {
                var lineStrings = multiGeo.querySelectorAll('LineString');
                for (var ls = 0; ls < lineStrings.length; ls++) {
                    var lsId = lineStrings[ls].getAttribute('id') || '';
                    var coordsEl = lineStrings[ls].querySelector('coordinates');
                    if (!coordsEl) continue;
                    var hCorners = parseCoordinates(coordsEl.textContent);
                    if (hCorners.length > 1 &&
                        hCorners[0].lat === hCorners[hCorners.length - 1].lat &&
                        hCorners[0].lng === hCorners[hCorners.length - 1].lng) {
                        hCorners.pop();
                    }
                    if (hCorners.length >= 3) {
                        if (lsId.indexOf('Interior') >= 0) {
                            inclusionZonesKml.push({
                                name: (pmName || 'Headland') + '_Interior',
                                corners: hCorners
                            });
                        } else if (lsId.indexOf('Exterior') >= 0) {
                            inclusionZonesKml.push({
                                name: (pmName || 'Headland') + '_Exterior',
                                corners: hCorners
                            });
                        }
                    }
                }
            }
        }
    }

    // ── Also check Folder-level Placemarks for routes ──
    var folders = xmlDoc.querySelectorAll('Folder');
    for (var f = 0; f < folders.length; f++) {
        var folderNameEl = folders[f].querySelector(':scope > name');
        var folderName = folderNameEl ? folderNameEl.textContent.trim() : 'Folder_' + (f + 1);
        var folderPlacemarks = folders[f].querySelectorAll(':scope > Placemark');
        for (var fp = 0; fp < folderPlacemarks.length; fp++) {
            var fpm = folderPlacemarks[fp];
            var fStyle = getStyleUrl(fpm);
            if (fStyle === 'WaylineStyle') {
                // Skip WaylineType 3 in folders too
                var fWaylineType = getExtData(fpm, 'WaylineType');
                if (fWaylineType === '3') continue;
                var fNameEl = fpm.querySelector('name');
                var fName = fNameEl ? fNameEl.textContent.trim() : '';
                var fCoords = fpm.querySelector('LineString coordinates');
                if (fCoords) {
                    var fWaypoints = parseCoordinates(fCoords.textContent);
                    if (fWaypoints.length >= 2) {
                        // Use folder name + segment name for uniqueness
                        var routeName = folderName + ' - ' + (fName || 'Segment_' + (fp + 1));
                        // Check not already added (top-level scan may have caught it)
                        var alreadyAdded = routes.some(function(r) {
                            return r.waypoints.length === fWaypoints.length &&
                                   r.waypoints[0].lat === fWaypoints[0].lat &&
                                   r.waypoints[0].lng === fWaypoints[0].lng;
                        });
                        if (!alreadyAdded) {
                            routes.push({ name: routeName, waypoints: fWaypoints });
                        }
                    }
                }
            }
        }
    }

    // ── Get KML document name for prefix ──
    var docNameEl = xmlDoc.querySelector('Document > name');
    var docName = docNameEl ? docNameEl.textContent.trim() : 'KML';

    // ── Save everything to ThingsBoard ──
    var apiEndpoint = 'https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/' + _widgetDeviceId + '/SHARED_SCOPE';
    var attributeData = {};
    var routeCount = 0, zoneCount = 0;

    // Deduplicate routes by name - keep first occurrence
    var seenRouteNames = {};
    var uniqueRoutes = [];
    routes.forEach(function(r) {
        // Sanitize name for attribute key
        var safeName = r.name.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
        if (!safeName) safeName = 'Route_' + (uniqueRoutes.length + 1);
        if (!seenRouteNames[safeName]) {
            seenRouteNames[safeName] = true;
            uniqueRoutes.push({ name: safeName, waypoints: r.waypoints });
        }
    });

    // Routes → pathfile_<name>
    uniqueRoutes.forEach(function(r) {
        attributeData['pathfile_' + r.name] = r.waypoints;
        routeCount++;
    });

    // Inclusion zones → inclusionzone_<name>
    inclusionZonesKml.forEach(function(z) {
        var safeName = z.name.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim() || ('Zone_' + (zoneCount + 1));
        attributeData['inclusionzone_' + safeName] = z.corners;
        zoneCount++;
    });

    // Exclusion zones → exclusionzone_<name>
    exclusionZonesKml.forEach(function(z) {
        var safeName = z.name.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim() || ('Obstacle_' + (zoneCount + 1));
        attributeData['exclusionzone_' + safeName] = z.corners;
        zoneCount++;
    });

    // AB lines → abline_<name> (just A/B points, no zone)
    var abLineCount = 0;
    var seenABNames = {};
    abLines.forEach(function(ab) {
        var displayName = ab.name.replace(/[^a-zA-Z0-9_\-\s.,]/g, '').trim();
        if (!displayName) displayName = 'AB_' + (abLineCount + 1);
        // Key-safe name: no commas (ThingsBoard splits on commas in keys param)
        var safeName = displayName.replace(/,/g, '_');
        // Deduplicate names
        if (seenABNames[safeName]) {
            var idx = 2;
            while (seenABNames[safeName + '_' + idx]) idx++;
            safeName = safeName + '_' + idx;
        }
        seenABNames[safeName] = true;
        attributeData['abline_' + safeName] = {
            displayName: displayName,
            pointA: ab.pointA,
            pointB: ab.pointB
        };
        abLineCount++;
    });

    if (Object.keys(attributeData).length === 0) {
        showNotification("No routes, zones, or AB configs found in KML.", "info");
        return;
    }

    try {
        var response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(attributeData)
        });

        if (response.ok) {
            var summary = 'KML imported: ' + routeCount + ' routes, ' + zoneCount + ' zones, ' + abLineCount + ' AB lines.';
            showNotification(summary, 'success');
            // Refresh all lists
            fetchSavedPaths();
            fetchSavedZones();
            fetchSavedABLines();
            fetchSavedABConfigs();
        } else {
            showNotification("Failed to save KML data. Error: " + response.status, "error");
        }
    } catch (error) {
        console.error("Error importing KML:", error);
        showNotification("Error importing KML: " + error.message, "error");
    }
}

async function saveTempPath() {
    //if (latlngs.length === 0) {
    //    console.log("No waypoints to save as temp path.");
    //    return;
    //}

    const attributeData = {
        temp: latlngs // Save the current GPS path as 'tempPath'
    };
    
    const apiEndpoint = "https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE";

    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(attributeData)
        });

        if (response.ok) {
            //console.log("Temp path saved successfully.");
        } else {
            const errorData = await response.json();
            console.error("Failed to save temp path. Error:", errorData);
        }
    } catch (error) {
        console.error("Error saving temp path:", error);
    }
}

// ══════════════════════════════════════════════════════════
// ── PATH RENDERING & DISTANCE CALCULATION ──────────────────
// ══════════════════════════════════════════════════════════

function updatePath() {
    if (polyline) {
        try { map.removeLayer(polyline); } catch (e) {}
        polyline = null;
    }
    if (robotPathOutlineLayer) {
        try { map.removeLayer(robotPathOutlineLayer); } catch (e) {}
        robotPathOutlineLayer = null;
    }
    // Remove any previous per-segment layers
    pathSegmentLayers.forEach(function(l) { try { map.removeLayer(l); } catch(e) {} });
    pathSegmentLayers = [];

    // In row-follow mode, don't render waypoints/paths on the map
    if (navigationMode === 'row-follow') {
        const totalDistance = calculateTotalDistance();
        distanceControl.update(totalDistance);
        return;
    }

    const pathPoints = [...latlngs];
    if (pathPoints.length > 1) {
        // Check if any segment uses follow-row so we can decide whether to draw per-segment
        const hasFollowRow = pathPoints.some(function(p) { return p.followRow; });
        if (!hasFollowRow) {
            // Fast path: draw a single polyline as before
            const latlngsPath = pathPoints.map(function(coord) { return [coord.lat, coord.lng]; });
            robotPathOutlineLayer = L.polyline(latlngsPath, {
                color: '#0b3b0b', weight: 7, opacity: 0.9, interactive: false
            }).addTo(map);
            polyline = L.polyline(latlngsPath, {
                color: '#52e3e1', weight: 3, opacity: 1, interactive: false
            }).addTo(map);
        } else {
            // Draw each segment individually with the appropriate style
            for (var i = 0; i < pathPoints.length - 1; i++) {
                var segCoords = [
                    [pathPoints[i].lat, pathPoints[i].lng],
                    [pathPoints[i + 1].lat, pathPoints[i + 1].lng]
                ];
                var isFollowSeg = !!pathPoints[i + 1].followRow;
                if (isFollowSeg) {
                    // Follow-row: orange dashed with dark amber outline
                    pathSegmentLayers.push(L.polyline(segCoords, {
                        color: '#7c3b00', weight: 7, opacity: 0.9, interactive: false
                    }).addTo(map));
                    pathSegmentLayers.push(L.polyline(segCoords, {
                        color: '#f97316', weight: 3, opacity: 1,
                        dashArray: '10 6', interactive: false
                    }).addTo(map));
                } else {
                    // Normal: cyan with dark outline
                    pathSegmentLayers.push(L.polyline(segCoords, {
                        color: '#0b3b0b', weight: 7, opacity: 0.9, interactive: false
                    }).addTo(map));
                    pathSegmentLayers.push(L.polyline(segCoords, {
                        color: '#52e3e1', weight: 3, opacity: 1, interactive: false
                    }).addTo(map));
                }
            }
        }
    }

    const totalDistance = calculateTotalDistance();
    distanceControl.update(totalDistance);

    //updateWaypointLabels(); // Update the labels dynamically
    saveTempPath(); // Automatically save the current path as a temp path
    updateThingsBoard(); // Automatically update ThingsBoard when path changes

    // Update waypoint count in status bar immediately
    if (typeof updateWaypointCount === 'function') updateWaypointCount();
}

function calculateTotalDistance() {
    if (latlngs.length < 1) return 0;
    let totalDistance = 0;

    for (let i = 0; i < latlngs.length - 1; i++) {
        totalDistance += haversineDistance(latlngs[i], latlngs[i + 1]);
    }

    return totalDistance;
}

function haversineDistance(coord1, coord2) {
    const R = 6371000; // Radius of the Earth in meters
    const lat1 = coord1.lat * Math.PI / 180;
    const lat2 = coord2.lat * Math.PI / 180;
    const deltaLat = (coord2.lat - coord1.lat) * Math.PI / 180;
    const deltaLng = (coord2.lng - coord1.lng) * Math.PI / 180;

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Returns the distance in meters
}

// ══════════════════════════════════════════════════════════
// ── WAYPOINT ACTIONS (Clear, Undo, Reverse) ────────────────
// ══════════════════════════════════════════════════════════

function clearAllWaypoints() {
    if (lockMode) { showNotification('Widget is locked. Unlock to edit.', 'error'); return; }
    if (currentMode === 'waypoint') {
        markers.slice(1).forEach(marker => map.removeLayer(marker));
        markers = markers.slice(0, 1);
        latlngs = [];
        updatePath();
    } else if (currentMode === 'exclusion-zone'){
        exclusionZones.forEach(zone => {
            clearZoneMarkers(zone);
            map.removeLayer(zone);
        });
        exclusionZones = [];
        polygonCorners = [];
        boundingPolygon = null;
        updateTBZone();
    }
    else {
        inclusionZones.forEach(zone => {
            clearZoneMarkers(zone);
            map.removeLayer(zone);
        });
        inclusionZones = [];
        polygonCorners = [];
        boundingPolygon = null;
        updateTBZone();
    }
}

function clearAllWaypointsLoad() {
        markers.slice(1).forEach(marker => map.removeLayer(marker));
        markers = markers.slice(0, 1);
        latlngs = [];
        updatePath();
}

function reversePath() {
    if (lockMode) { showNotification('Widget is locked. Unlock to edit.', 'error'); return; }
    if (latlngs.length < 2) {
        showNotification("Need at least 2 waypoints to reverse.", "info");
        return;
    }

    // Snapshot followRow flags before reversing so we can remap them.
    // followRow[i] = true means the segment (i-1)→i was follow-row.
    // After reversal, element at new index j was originally at index n-1-j.
    // The segment new[j-1]→new[j] was originally old[n-j]→old[n-1-j],
    // which had followRow flag stored on old[n-j] (not n-1-j).
    // So new[j].followRow = old[n-j].followRow  (for j >= 1).
    const n = latlngs.length;
    const origFollowRow = latlngs.map(function(wp) { return !!wp.followRow; });

    // Reverse the latlngs array
    latlngs.reverse();

    // Remap followRow flags to match the reversed segment directions
    latlngs[0].followRow = false;
    for (var j = 1; j < n; j++) {
        latlngs[j].followRow = origFollowRow[n - j];
    }

    // Flip each waypoint's orientation by 180°
    for (var k = 0; k < latlngs.length; k++) {
        if (typeof latlngs[k].yaw === 'number') {
            latlngs[k].yaw = (latlngs[k].yaw + 180) % 360;
        }
    }

    // Remove all waypoint markers (keep initial marker at index 0)
    markers.slice(1).forEach(marker => map.removeLayer(marker));
    var waypointMarkers = markers.slice(1);
    waypointMarkers.reverse();

    // Re-add reversed markers and update their positions/icons with flipped orientation
    for (var i = 0; i < waypointMarkers.length; i++) {
        var wp = latlngs[i];
        waypointMarkers[i].setLatLng([wp.lat, wp.lng]);
        // Update marker icon rotation if it has one
        if (typeof wp.yaw === 'number' && waypointMarkers[i].setRotationAngle) {
            waypointMarkers[i].setRotationAngle(wp.yaw);
        } else if (typeof wp.yaw === 'number') {
            // Update icon rotation via style transform
            var el = waypointMarkers[i].getElement && waypointMarkers[i].getElement();
            if (el) {
                el.style.transform = el.style.transform.replace(/rotate\([^)]*\)/, '') + ' rotate(' + wp.yaw + 'deg)';
            }
        }
        waypointMarkers[i].addTo(map);
    }
    markers = [markers[0]].concat(waypointMarkers);

    updateWaypointLabels();
    updatePath();
    showNotification("Path reversed. (" + latlngs.length + " waypoints)", "success");
}

function undoLastWaypoint() {
    if (lockMode) { showNotification('Widget is locked. Unlock to edit.', 'error'); return; }
    if (currentMode === 'waypoint') {
        // Undo the last waypoint
        if (markers.length > 1) {
            const lastMarker = markers.pop();
            map.removeLayer(lastMarker);
            latlngs.pop();
            updateWaypointLabels();
            updatePath();
        }
    } else if (currentMode === 'exclusion-zone') {
        // Undo the last exclusion zone
        if (exclusionZones.length > 0) {
            const lastExclusionZone = exclusionZones.pop();
            clearZoneMarkers(lastExclusionZone); // Clear markers for this zone
            map.removeLayer(lastExclusionZone);
            updateTBZone(); // Update ThingsBoard after removing the exclusion zone
            showNotification("Last exclusion zone removed.", "success");
        } else {
            showNotification("No exclusion zones to remove.", "info");
        }
    } else if (currentMode === 'polygon') {
        // Undo the last inclusion zone
        if (inclusionZones.length > 0) {
            const lastInclusionZone = inclusionZones.pop();
            clearZoneMarkers(lastInclusionZone); // Clear markers for this zone
            map.removeLayer(lastInclusionZone);
            updateTBZone(); // Update ThingsBoard after removing the inclusion zone
            showNotification("Last inclusion zone removed.", "success");
        } else {
            showNotification("No inclusion zones to remove.", "info");
        }
    }
}

// ══════════════════════════════════════════════════════════
// ── THINGSBOARD SYNC (Zones, Path, Attributes) ─────────────
// ══════════════════════════════════════════════════════════

async function updateTBZone() {
    const gpsZone = inclusionZones.map(zone => zone.getLatLngs()[0]); // Get coordinates of inclusion zones
    const gpsexZones = exclusionZones.map(zone => zone.getLatLngs()[0]); // Get coordinates of exclusion zones

    const attributeData = {
        gpsZone: gpsZone,
        gpsexZones: gpsexZones,
    };

    console.log("Prepared attributeData:", JSON.stringify(attributeData)); // Debugging: Log the data being sent

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`;

    if (!token) {
        showNotification("Token not available. Please log in first. updateTBZone", "error");
        console.error("Token not available.");
        return;
    }

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(attributeData)
        });

        console.log("API Response Status:", response.status); // Debugging: Log the response status

        if (response.ok) {
            //showNotification("Zones updated successfully in ThingsBoard.", "success");
            console.log("Zones updated successfully.");
        } else {
            const errorData = await response.json();
            console.error("Failed to update ThingsBoard. Error:", errorData);
            showNotification("Failed to update ThingsBoard. Error: " + response.status, "error");
        }
    } catch (error) {
        console.error("Error updating ThingsBoard:", error);
        showNotification("Error updating ThingsBoard.", "error");
    }
}

async function updateThingsBoard() {
    //if (latlngs.length === 0) {
        //alert("No coordinates available in latlngs.");
    //    return;
    //}

    const gpsPath = latlngs;
    const gpsPathCount = gpsPath.length
    const attributeData = {
        gpsPath: gpsPath,
        gpsPathCount: gpsPathCount
    };
    //alert("Prepared attributeData: " + JSON.stringify(attributeData));

    const apiEndpoint = "https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE";

    if (!token) {
        //alert("Token not available. Please log in first.");
        showNotification("Token not available. Please log in first. updateThingsBoard", "error");
        return;
    }

    try {
        //alert("Sending request to API endpoint: " + apiEndpoint);

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(attributeData)
        });

        //alert("Received response. Status: " + response.status);

        if (response.ok) {
            //alert("Successfully updated ThingsBoard.");
            //showNotification("Successfully updated ThingsBoard.", "success");
        } else {
            const errorData = await response.json(); // Read the response body
            //alert("Failed to update ThingsBoard. Error: " + response.status + ", " + JSON.stringify(errorData));
            showNotification("Failed to update ThingsBoard. Error: " + response.status + ", " + JSON.stringify(errorData), "error");
        }
    } catch (error) {
        //alert("Error occurred while updating ThingsBoard: " + error.message);
        showNotification("Error updating ThingsBoard. Details: " + error.message, "error");
    }
}


function updateMarkerLabel(marker, labelNumber) {
    marker.bindPopup(labelNumber.toString(), {
        offset: [0, -10], // Adjust position
    });
}   

function updateWaypointLabels() {
    markers.forEach((marker, index) => {
        if (index > 0) { // Skip the initial marker
            const waypointNumber = index.toString();
            const wp = latlngs[index - 1] || {};
            const yawDeg = (typeof wp.yaw === 'number' && isFinite(wp.yaw)) ? wp.yaw : null;
            const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
            const imgStyle = 'position:absolute;left:8px;top:8px;width:48px;height:48px;' + (yawDeg !== null ? ('transform: rotate(' + yawDeg + 'deg);') : '') + 'filter:drop-shadow(0 3px 6px rgba(0,0,0,0.7));';
            const waypointIcon = L.divIcon({
                className: 'waypoint-icon',
                html: '<div style="position:relative;width:64px;height:64px">' +
                      '<img src="' + imgSrc + '" style="' + imgStyle + '">' +
                      '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:20px;background:rgba(0,0,0,0.55);color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;border:2px solid rgba(255,255,255,0.7)">' + waypointNumber + '</div>' +
                      '</div>',
                iconSize: [64, 64],
                iconAnchor: [32, 32]
            });
            marker.setIcon(waypointIcon); // Update the marker's icon (with rotation if available)
        }
    });
}


// ══════════════════════════════════════════════════════════
// ── LIST ITEM NAME TOOLTIP (mouse hover + touch long-press) ──
// ══════════════════════════════════════════════════════════
(function() {
    var _tt = null;
    var _ttTimer = null;

    function showListTooltip(text, refEl) {
        hideListTooltip();
        var el = document.createElement('div');
        el.id = '_list-name-tt';
        el.textContent = text;
        el.style.cssText = 'position:fixed;z-index:99999;background:#111827;color:#e2e8f0;padding:7px 13px;border-radius:8px;font-size:13px;font-family:Roboto,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.55);pointer-events:none;max-width:260px;word-break:break-word;border:1px solid rgba(255,255,255,0.12);transition:opacity 0.15s;opacity:0;';
        document.body.appendChild(el);
        _tt = el;
        requestAnimationFrame(function() {
            if (!_tt) return;
            var rect = refEl.getBoundingClientRect();
            var top = rect.top - _tt.offsetHeight - 8;
            if (top < 6) top = rect.bottom + 8;
            var left = rect.left;
            if (left + _tt.offsetWidth > window.innerWidth - 8) left = window.innerWidth - _tt.offsetWidth - 8;
            _tt.style.top = top + 'px';
            _tt.style.left = left + 'px';
            _tt.style.opacity = '1';
        });
    }

    function hideListTooltip() {
        if (_ttTimer) { clearTimeout(_ttTimer); _ttTimer = null; }
        var old = document.getElementById('_list-name-tt');
        if (old) old.remove();
        _tt = null;
    }

    window.addListNameTooltip = function(el, text) {
        // Store/update text in data attribute — always update even if already attached
        el.dataset.listTtText = text;
        if (el._listTtAttached) return; // listeners already registered
        el._listTtAttached = true;

        // Mouse
        el.addEventListener('mouseenter', function() {
            _ttTimer = setTimeout(function() { showListTooltip(el.dataset.listTtText, el); }, 500);
        });
        el.addEventListener('mouseleave', hideListTooltip);
        // Touch long-press
        var touchTimer = null;
        el.addEventListener('touchstart', function() {
            touchTimer = setTimeout(function() { showListTooltip(el.dataset.listTtText, el); }, 600);
        }, { passive: true });
        el.addEventListener('touchend', function() {
            clearTimeout(touchTimer); touchTimer = null;
            setTimeout(hideListTooltip, 1800);
        }, { passive: true });
        el.addEventListener('touchmove', function() {
            clearTimeout(touchTimer); touchTimer = null;
            hideListTooltip();
        }, { passive: true });
    };
})();

// ══════════════════════════════════════════════════════════
// ── SAVED PATHS LIST (Fetch, Display, Push, Delete) ────────
// ══════════════════════════════════════════════════════════

async function fetchSavedPaths() {
    if (!isAlive()) return;
    if (!token) {
        //showNotification("Token not available. Please log in first. fetchSavedPaths", "error");
        return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/keys/attributes`;

    try {
        const response = await fetch(apiEndpoint, {
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });
        if (!isAlive()) return;

        if (response.ok) {
            const data = await response.json();
            if (!isAlive()) return;
            const filteredKeys = data.filter(key => key.startsWith("pathfile_") && !key.includes(','));
            filteredKeys.sort();
            updatePathsList(filteredKeys);
        } else {
            console.error("Failed to fetch paths. Error code:", response.status);
        }
    } catch (error) {
        console.error("Error fetching paths:", error);
    }
}

function updatePathsList(keys) {
    if (!isAlive()) return;
    const pathsList = document.getElementById('paths-list');
    if (!pathsList) return;
    pathsList.innerHTML = '';

    if (keys.length === 0) {
        const noPathsMessage = document.createElement('li');
        noPathsMessage.textContent = "No saved paths available.";
        noPathsMessage.className = 'path-item';
        pathsList.appendChild(noPathsMessage);
    } else {
        keys.forEach(key => {
            const listItem = document.createElement('li');
            listItem.className = 'path-item';

            const displayKey = key.replace("pathfile_", "");
            const pathText = document.createElement('span');
            pathText.textContent = displayKey;
            addListNameTooltip(pathText, displayKey);

            // Push button with stable dimensions
            const pushButton = document.createElement('button');
            pushButton.className = 'list-btn push-btn';
            pushButton.innerHTML = '<i class="fas fa-map-marker-alt"></i>'; // Map icon
            pushButton.onclick = () => pushToMap(displayKey);

            // Delete button with stable dimensions
            const deleteButton = document.createElement('button');
            deleteButton.className = 'list-btn delete-btn';
            deleteButton.innerHTML = '<i class="fas fa-trash"></i>'; // Trash icon
            deleteButton.onclick = () => deletePath(displayKey);

            // Append text and buttons to list item
            listItem.appendChild(pathText);
            listItem.appendChild(pushButton);
            listItem.appendChild(deleteButton);

            pathsList.appendChild(listItem);
        });
    }
}



async function pushToMap(key) {
    if (!token) {
        showNotification("Token not available. Please log in first. pushToMap", "error");
        return;
    }
    if (navigationMode === 'row-follow') {
        showNotification('Switch to GPS Navigation mode to load routes.', 'error');
        return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=` + encodeURIComponent('pathfile_' + key);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            const data = await response.json();
            const pathData = data[0].value;

            latlngs.length = 0;
            markers.slice(1).forEach(marker => map.removeLayer(marker));
            markers = markers.slice(0, 1);

            const newLatLngs = [];

            pathData.forEach((waypoint, index) => {
                const { lat, lng } = waypoint;

                const exists = newLatLngs.some(coord => coord.lat === lat && coord.lng === lng);
                if (exists) return;

                if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(lat, lng, zone.getLatLngs()[0]))) {
                    return;
                }
                if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(lat, lng, zone.getLatLngs()[0]))) {
                    return;
                }

                // preserve yaw and followRow if present in stored path
                const yawSrc = (waypoint && (waypoint.yaw || waypoint.y || waypoint.heading || waypoint.orientation));
                const yawVal = (yawSrc !== undefined && yawSrc !== null && yawSrc !== '') ? parseFloat(yawSrc) : null;
                newLatLngs.push({ lat, lng, yaw: yawVal, followRow: !!waypoint.followRow });

                const waypointNumber = (index + 1).toString();
                const imgSrc = '/api/images/public/6obSad2rmNknBqnbjfFizlzn4ASjtbx3';
                const imgStyle = 'position:absolute;left:8px;top:8px;width:48px;height:48px;' + (yawVal !== null ? ('transform: rotate(' + yawVal + 'deg);') : '') + 'filter:drop-shadow(0 3px 6px rgba(0,0,0,0.7));';
                const waypointIcon = L.divIcon({
                    className: 'waypoint-icon',
                    html: '<div style="position:relative;width:64px;height:64px">' +
                          '<img src="' + imgSrc + '" style="' + imgStyle + '">' +
                          '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:20px;background:rgba(0,0,0,0.55);color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;border:2px solid rgba(255,255,255,0.7)">' + waypointNumber + '</div>' +
                          '</div>',
                    iconSize: [64, 64],
                    iconAnchor: [32, 32]
                });

                const waypointMarker = L.marker([lat, lng], {
                    icon: waypointIcon,
                    draggable: currentMode === 'waypoint'
                }).addTo(map);

                markers.push(waypointMarker);

                waypointMarker.on('contextmenu', function () {
                    if (currentMode === 'waypoint') {
                        map.removeLayer(waypointMarker);
                        const index = markers.indexOf(waypointMarker);
                        if (index !== -1) {
                            markers.splice(index, 1);
                            newLatLngs.splice(index - 1, 1);
                            latlngs.splice(index - 1, 1);
                            updateWaypointLabels();
                        }
                        updatePath();
                    }
                });

                // Long-press to remove waypoint on touch devices
                attachLongPress(waypointMarker, function() {
                    if (currentMode === 'waypoint') {
                        map.removeLayer(waypointMarker);
                        const index = markers.indexOf(waypointMarker);
                        if (index !== -1) {
                            markers.splice(index, 1);
                            newLatLngs.splice(index - 1, 1);
                            latlngs.splice(index - 1, 1);
                            updateWaypointLabels();
                        }
                        updatePath();
                    }
                });

                waypointMarker.on('drag', function (e) {
                    if (lockMode) { waypointMarker.setLatLng(latlngs[markers.indexOf(waypointMarker) - 1]); return; }
                    const newLatLng = e.target.getLatLng();
                    const index = markers.indexOf(waypointMarker);

                    if (inclusionZones.length > 0 && !inclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
                        waypointMarker.setLatLng(latlngs[index - 1]);
                        showNotification("Waypoint cannot be moved outside the inclusion zone.", "error");
                        return;
                    }
                    if (exclusionZones.length > 0 && exclusionZones.some(zone => isPointInPolygon(newLatLng.lat, newLatLng.lng, zone.getLatLngs()[0]))) {
                        waypointMarker.setLatLng(latlngs[index - 1]);
                        showNotification("Waypoint cannot be moved inside the exclusion zone.", "error");
                        return;
                    }

                    if (index > -1) {
                        const prev = latlngs[index - 1] || {};
                        latlngs[index - 1] = {
                            lat: newLatLng.lat,
                            lng: newLatLng.lng,
                            yaw: prev.yaw || null,
                            followRow: !!prev.followRow
                        };
                        updatePath();
                    }
                });

            });

            latlngs.push(...newLatLngs);
            updatePath();

            showNotification("Route loaded successfully.", "success");
        } else {
            showNotification("Failed to fetch paths. Error code: " + response.status, "error");
        }
    } catch (error) {
        showNotification("Error fetching path data: " + error.message, "error");
    }
}

async function deletePath(key) {
    // Add the code here to delete the path from the server and update the list
    if (!token) {
        showNotification("Token not available. Please log in first. deletePath", "error");
        return;
    }
    
    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/${deviceID}/SHARED_SCOPE?keys=` + encodeURIComponent('pathfile_' + key);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            fetchSavedPaths();
        } else {
            //alert("Failed to fetch paths. Error code:" + response.status);
        }
    } catch (error) {
        //alert("Failed to fetch paths. Error code:" + response.status);
    }
}

async function fetchSavedZones() {
    if (!isAlive()) return;
    if (!token) {
// showNotification("Token not available. Please log in first.", "error");
return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/keys/attributes`;

    try {
const response = await fetch(apiEndpoint, {
    headers: {
        'Accept': 'application/json',
        'X-Authorization': 'Bearer ' + token
    }
});
if (!isAlive()) return;

if (response.ok) {
    const data = await response.json();
    if (!isAlive()) return;
    // Filter for both inclusion and exclusion zones, plus legacy zonefile_
    const filteredKeys = data.filter(key => 
        key.startsWith("inclusionzone_") || 
        key.startsWith("exclusionzone_") ||
        key.startsWith("zonefile_")
    ).filter(key => !key.includes(','));
    filteredKeys.sort();
    updateZonesList(filteredKeys);
} else {
    console.error("Failed to fetch zones. Error code:", response.status);
}
    } catch (error) {
console.error("Error fetching zones:", error);
    }
}

function updateZonesList(keys) {
    if (!isAlive()) return;
    const zonesList = document.getElementById('zones-list');
    if (!zonesList) return;
    zonesList.innerHTML = '';

    if (keys.length === 0) {
const noZonesMessage = document.createElement('li');
noZonesMessage.textContent = "No saved zones available.";
noZonesMessage.className = 'zone-item';
zonesList.appendChild(noZonesMessage);
    } else {
keys.forEach(key => {
    const listItem = document.createElement('li');
    listItem.className = 'zone-item';

    // Determine zone type and display name
    let displayKey, zoneType, fullKey;
    if (key.startsWith("inclusionzone_")) {
        displayKey = key.replace("inclusionzone_", "");
        zoneType = 'inclusion';
        fullKey = key;
    } else if (key.startsWith("exclusionzone_")) {
        displayKey = key.replace("exclusionzone_", "");
        zoneType = 'exclusion';
        fullKey = key;
    } else {
        displayKey = key.replace("zonefile_", "");
        zoneType = 'legacy';
        fullKey = key;
    }

    const zoneText = document.createElement('span');
    // Add colored indicator for zone type
    const typeIndicator = zoneType === 'exclusion' ? '🔴 ' : (zoneType === 'inclusion' ? '🟢 ' : '⚪ ');
    zoneText.textContent = typeIndicator + displayKey;
    addListNameTooltip(zoneText, displayKey);

    // Push button with stable dimensions
    const pushButton = document.createElement('button');
    pushButton.className = 'list-btn push-btn';
    pushButton.innerHTML = '<i class="fa-solid fa-vector-square"></i>';
    pushButton.onclick = () => pushZoneToMap(fullKey, zoneType);

    // Delete button with stable dimensions
    const deleteButton = document.createElement('button');
    deleteButton.className = 'list-btn delete-btn';
    deleteButton.innerHTML = '<i class="fas fa-trash"></i>';
    deleteButton.onclick = () => deleteZone(fullKey);

    // Append text and buttons to list item
    listItem.appendChild(zoneText);
    listItem.appendChild(pushButton);
    listItem.appendChild(deleteButton);

    zonesList.appendChild(listItem);
});
    }
}

async function pushZoneToMap(fullKey, zoneType) {
    if (!token) {
alert("Token not available. Please log in first. pushZoneToMap");
return;
    }
    if (navigationMode === 'row-follow') {
showNotification('Switch to GPS Navigation mode to load zones.', 'error');
return;
    }

    // Check if zone is already loaded on the map
    var existingZone = null;
    var allZones = inclusionZones.concat(exclusionZones);
    for (var i = 0; i < allZones.length; i++) {
if (allZones[i]._zoneKey === fullKey) {
    existingZone = allZones[i];
    break;
}
    }
    
    if (existingZone) {
// Zone already loaded - just pan to it and enable editing
var corners = existingZone.getLatLngs()[0];
var bounds = L.latLngBounds(corners);
map.fitBounds(bounds, { padding: [50, 50] });
enableZoneEditing(existingZone, existingZone._zoneType);
savedPolygon = corners.map(function(corner) {
    return { lat: corner.lat, lng: corner.lng };
});
savedPolygonType = existingZone._zoneType;
showNotification("Zone already loaded. Panning to view.", "info");
return;
    }

    // API endpoint for fetching the zone data
    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=` + encodeURIComponent(fullKey);

    try {
const response = await fetch(apiEndpoint, {
    method: 'GET',
    headers: {
        'Accept': 'application/json',
        'X-Authorization': 'Bearer ' + token
    }
});

if (response.ok) {
    const data = await response.json();
    const zoneData = data[0].value;

    // Clear existing polygon, if any
    polygonCorners = [];
    if (boundingPolygon) {
        map.removeLayer(boundingPolygon);
    }

    // Check if zoneData is valid
    if (!zoneData || zoneData.length === 0) {
        //alert("Zone data is empty or invalid.");
        return;
    }

    // Temporarily set mode based on zone type for correct color
    const originalMode = currentMode;
    if (zoneType === 'exclusion') {
        currentMode = 'exclusion-zone';
    } else {
        currentMode = 'polygon';
    }

    // Draw the polygon from the fetched zone data
    zoneData.forEach(waypoint => {
        const { lat, lng } = waypoint;
        const latlng = { lat, lng };

        // Use the drawPolygon function for each point
        drawPolygon(latlng);
    });

    // Finalize the polygon after adding all points
    finalizePolygon();
    
    // Store the zone key on the newly created polygon for tracking
    var targetZones = zoneType === 'exclusion' ? exclusionZones : inclusionZones;
    if (targetZones.length > 0) {
        targetZones[targetZones.length - 1]._zoneKey = fullKey;
    }

    // Restore original mode
    currentMode = originalMode;

    // Ensure there are valid polygon corners
    if (savedPolygon.length > 0) {
        const bounds = L.latLngBounds(savedPolygon); // Create bounds from polygon corners
        map.fitBounds(bounds, { padding: [50, 50] }); // Adjust map view to fit bounds with padding

        // Debugging: Log the polygon corners and bounds
        console.log("Polygon Corners:", savedPolygon);
        console.log("Bounds:", bounds);
    } else {
        //alert("No valid polygon corners to fit map bounds.");
    }

    //alert("Zone loaded successfully.");
} else {
    //alert("Failed to fetch zone data. Error code: " + response.status);
}
    } catch (error) {
//alert("Error fetching zone data: " + error.message);
    }
}


async function deleteZone(fullKey) {
    if (!token) {
showNotification("Token not available. Please log in first. deleteZone", "error");
return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/${deviceID}/SHARED_SCOPE?keys=` + encodeURIComponent(fullKey);

    try {
const response = await fetch(apiEndpoint, {
    method: 'DELETE',
    headers: {
        'Accept': 'application/json',
        'X-Authorization': 'Bearer ' + token
    }
});

if (response.ok) {
    // Remove zone from local arrays and map
    var removeFrom = function(arr) {
        for (var i = arr.length - 1; i >= 0; i--) {
            if (arr[i]._zoneKey === fullKey) {
                clearZoneMarkers(arr[i]);
                if (map) map.removeLayer(arr[i]);
                arr.splice(i, 1);
            }
        }
    };
    removeFrom(inclusionZones);
    removeFrom(exclusionZones);
    savedPolygon = [];
    savedPolygonType = null;
    showNotification("Zone deleted successfully.", "success");
    fetchSavedZones(); // Refresh the zones list
} else {
    showNotification("Failed to delete zone. Error code:" + response.status, "error");
}
    } catch (error) {
showNotification("Error deleting zone: " + error.message, "error");
    }
}

// ══════════════════════════════════════════════
// ── AB Line Save (individual A/B point pair) ──
// ══════════════════════════════════════════════

async function saveIndividualABLine() {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }
    if (!abState.pointA || !abState.pointB) {
        showNotification("Set both A and B points before saving.", "info");
        return;
    }

    const lineName = prompt("Enter a name for this AB line:");
    if (!lineName || !lineName.trim()) {
        showNotification("AB line name is required.", "error");
        return;
    }

    const safeName = lineName.trim().replace(/,/g, '_');
    const lineData = {
        displayName: safeName,
        pointA: { lat: abState.pointA.lat, lng: abState.pointA.lng },
        pointB: { lat: abState.pointB.lat, lng: abState.pointB.lng }
    };

    const attributeData = {};
    attributeData['abline_' + safeName] = lineData;

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(attributeData)
        });

        if (response.ok) {
            showNotification('AB line "' + safeName + '" saved to AB Lines list.', 'success');
            fetchSavedABLines();
        } else {
            showNotification("Failed to save AB line. Error: " + response.status, "error");
        }
    } catch (error) {
        console.error("Error saving AB line:", error);
        showNotification("Error saving AB line.", "error");
    }
}

function showSaveABLineButton() {
    var existing = document.getElementById('ab-save-line-btn');
    if (existing) existing.remove();

    var btn = document.createElement('button');
    btn.id = 'ab-save-line-btn';
    btn.innerHTML = '<i class="fas fa-save" style="margin-right:8px;"></i>Save AB Line';
    btn.style.cssText = 'position:absolute;bottom:185px;left:50%;transform:translateX(-50%);z-index:10010;padding:8px 18px;font-size:13px;font-weight:700;border-radius:9px;border:2px solid rgba(139,92,246,0.6);background:linear-gradient(135deg,rgba(91,33,182,0.92),rgba(76,29,149,0.95));color:#c4b5fd;cursor:pointer;font-family:Roboto,sans-serif;box-shadow:0 3px 12px rgba(91,33,182,0.3);backdrop-filter:blur(8px);white-space:nowrap;transition:all 0.18s ease;';
    btn.onmouseenter = function() { btn.style.background = 'linear-gradient(135deg,rgba(109,40,217,0.95),rgba(91,33,182,0.98))'; btn.style.color = '#ddd6fe'; };
    btn.onmouseleave = function() { btn.style.background = 'linear-gradient(135deg,rgba(91,33,182,0.92),rgba(76,29,149,0.95))'; btn.style.color = '#c4b5fd'; };
    btn.onclick = function() { saveIndividualABLine(); };
    btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    btn.addEventListener('touchstart', function(e) { e.stopPropagation(); }, { passive: true });

    document.getElementById('gps-container').appendChild(btn);
}

// ══════════════════════════════════════════════
// ── AB Config Save / Load / Delete ──
// ══════════════════════════════════════════════

async function saveABConfig() {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }
    if (!abState.zoneCorners || abState.zoneCorners.length === 0) {
        showNotification("No AB zone to save. Draw a zone first.", "info");
        return;
    }
    if (!abState.pointA || !abState.pointB) {
        showNotification("No AB line to save. Set A and B points first.", "info");
        return;
    }

    const configName = prompt("Enter a name for this AB config:");
    if (!configName) {
        showNotification("AB config name is required to save.", "error");
        return;
    }

    const configData = {
        zoneCorners: abState.zoneCorners,
        pointA: { lat: abState.pointA.lat, lng: abState.pointA.lng },
        pointB: { lat: abState.pointB.lat, lng: abState.pointB.lng },
        rowSpacing: abState.rowSpacing
    };

    const attributeData = {};
    attributeData['abconfig_' + configName] = configData;

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(attributeData)
        });

        if (response.ok) {
            showNotification("AB config saved successfully.", "success");
            fetchSavedABConfigs();
        } else {
            showNotification("Failed to save AB config. Error: " + response.status, "error");
        }
    } catch (error) {
        console.error("Error saving AB config:", error);
        showNotification("Error saving AB config.", "error");
    }
}

async function fetchSavedABConfigs() {
    if (!isAlive()) return;
    if (!token) return;

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/keys/attributes`;

    try {
        const response = await fetch(apiEndpoint, {
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });
        if (!isAlive()) return;

        if (response.ok) {
            const data = await response.json();
            if (!isAlive()) return;
            const filteredKeys = data.filter(key => key.startsWith("abconfig_") && !key.includes(','));
            filteredKeys.sort();
            updateABConfigsList(filteredKeys);
        } else {
            console.error("Failed to fetch AB configs. Error code:", response.status);
        }
    } catch (error) {
        console.error("Error fetching AB configs:", error);
    }
}

function updateABConfigsList(keys) {
    if (!isAlive()) return;
    const listEl = document.getElementById('ab-configs-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (keys.length === 0) {
        const noMsg = document.createElement('li');
        noMsg.textContent = "No saved AB configs available.";
        noMsg.className = 'path-item';
        listEl.appendChild(noMsg);
    } else {
        keys.forEach(key => {
            const listItem = document.createElement('li');
            listItem.className = 'path-item';

            const displayKey = key.replace("abconfig_", "");
            const textSpan = document.createElement('span');
            textSpan.textContent = '📐 ' + displayKey;
            addListNameTooltip(textSpan, displayKey);

            const pushButton = document.createElement('button');
            pushButton.className = 'list-btn push-btn';
            pushButton.innerHTML = '<i class="fas fa-drafting-compass"></i>';
            pushButton.onclick = () => pushABConfigToMap(key);

            const deleteButton = document.createElement('button');
            deleteButton.className = 'list-btn delete-btn';
            deleteButton.innerHTML = '<i class="fas fa-trash"></i>';
            deleteButton.onclick = () => deleteABConfig(key);

            listItem.appendChild(textSpan);
            listItem.appendChild(pushButton);
            listItem.appendChild(deleteButton);
            listEl.appendChild(listItem);
        });
    }
}

async function pushABConfigToMap(fullKey) {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }
    if (navigationMode === 'row-follow') {
        showNotification('Switch to GPS Navigation mode to load AB configs.', 'error');
        return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=` + encodeURIComponent(fullKey);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            const data = await response.json();
            const config = data[0].value;

            if (!config || !config.pointA || !config.pointB) {
                showNotification("Invalid AB config data.", "error");
                return;
            }

            // Reset any existing AB state
            resetABState();

            // Restore zone corners and draw polygon
            abState.active = true;
            abState.workflow = 'line-guidance';
            abState.zoneCorners = config.zoneCorners || [];
            abState.rowSpacing = config.rowSpacing || 8.0;

            // Update the row spacing input
            var rowInput = document.getElementById('row-spacing-input');
            if (rowInput) rowInput.value = abState.rowSpacing;

            // Draw bounding polygon only if zone corners exist
            var hasZone = abState.zoneCorners.length >= 3;
            if (hasZone) {
                var polyCorners = abState.zoneCorners.map(c => L.latLng(c.lat, c.lng));
                abState.zonePolygon = L.polygon(polyCorners, {
                    color: '#00e5ff', weight: 2, fillColor: '#00e5ff', fillOpacity: 0.10, dashArray: '6,6'
                }).addTo(map);
            }

            // Set A and B
            abState.pointA = L.latLng(config.pointA.lat, config.pointA.lng);
            abState.pointB = L.latLng(config.pointB.lat, config.pointB.lng);

            // Compute angle
            var dx = abState.pointB.lng - abState.pointA.lng;
            var dy = abState.pointB.lat - abState.pointA.lat;
            abState.abAngleDeg = Math.atan2(dx, dy) * (180 / Math.PI);
            abState.step = 'ab-set';

            if (hasZone) {
                // Build parallel lines (triggers entry points + generate btn via line-guidance workflow)
                buildABLines();

                // Fit map to zone
                var bounds = L.latLngBounds(polyCorners);
                map.fitBounds(bounds, { padding: [50, 50] });
                showNotification("AB config loaded: " + fullKey.replace("abconfig_", ""), "success");
            } else {
                // No zone — show A/B markers and the AB line so the user sees the reference
                var markerA = L.marker(abState.pointA, {
                    icon: L.divIcon({
                        className: '',
                        html: '<div style="background:#22c55e;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);">A</div>',
                        iconSize: [28, 28], iconAnchor: [14, 14]
                    })
                }).addTo(map);
                abState.lineLayers.push(markerA);

                var markerB = L.marker(abState.pointB, {
                    icon: L.divIcon({
                        className: '',
                        html: '<div style="background:#ef4444;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);">B</div>',
                        iconSize: [28, 28], iconAnchor: [14, 14]
                    })
                }).addTo(map);
                abState.lineLayers.push(markerB);

                var abLine = L.polyline([abState.pointA, abState.pointB], {
                    color: '#f59e0b', weight: 3, dashArray: '8 6'
                }).addTo(map);
                abState.lineLayers.push(abLine);

                // Fit map to A/B points
                var bounds = L.latLngBounds([abState.pointA, abState.pointB]);
                map.fitBounds(bounds, { padding: [80, 80] });
                showNotification("AB config loaded (no zone). Draw a zone to generate parallel lines.", "info");
            }
        } else {
            showNotification("Failed to fetch AB config. Error: " + response.status, "error");
        }
    } catch (error) {
        console.error("Error loading AB config:", error);
        showNotification("Error loading AB config.", "error");
    }
}

async function deleteABConfig(fullKey) {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/${deviceID}/SHARED_SCOPE?keys=` + encodeURIComponent(fullKey);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            showNotification("AB config deleted.", "success");
            fetchSavedABConfigs();
        } else {
            showNotification("Failed to delete AB config. Error: " + response.status, "error");
        }
    } catch (error) {
        showNotification("Error deleting AB config.", "error");
    }
}

// ══════════════════════════════════════════════
// ── AB Lines (KML-imported A/B point pairs) ──
// ══════════════════════════════════════════════

async function fetchSavedABLines() {
    if (!isAlive()) return;
    if (!token) return;

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/keys/attributes`;

    try {
        const response = await fetch(apiEndpoint, {
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });
        if (!isAlive()) return;

        if (response.ok) {
            const data = await response.json();
            if (!isAlive()) return;
            const filteredKeys = data.filter(key => key.startsWith("abline_") && !key.includes(','));
            filteredKeys.sort();
            updateABLinesList(filteredKeys);
        } else {
            console.error("Failed to fetch AB lines. Error code:", response.status);
        }
    } catch (error) {
        console.error("Error fetching AB lines:", error);
    }
}

function updateABLinesList(keys) {
    if (!isAlive()) return;
    const listEl = document.getElementById('ab-lines-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (keys.length === 0) {
        const noMsg = document.createElement('li');
        noMsg.textContent = "No saved AB lines available.";
        noMsg.className = 'path-item';
        listEl.appendChild(noMsg);
    } else {
        keys.forEach(key => {
            const listItem = document.createElement('li');
            listItem.className = 'path-item';

            const displayKey = key.replace("abline_", "");
            const textSpan = document.createElement('span');
            textSpan.textContent = '📏 ' + displayKey;
            addListNameTooltip(textSpan, displayKey);

            // Fetch displayName from value if available (shows original name with commas)
            (async () => {
                try {
                    const ep = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=` + encodeURIComponent(key);
                    const r = await fetch(ep, { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } });
                    if (r.ok) {
                        const d = await r.json();
                        if (d && d[0] && d[0].value && d[0].value.displayName) {
                            const fetchedName = d[0].value.displayName.replace(/,/g, '_');
                            textSpan.textContent = '📏 ' + fetchedName;
                            addListNameTooltip(textSpan, fetchedName);
                        }
                    }
                } catch(e) {}
            })();

            const pushButton = document.createElement('button');
            pushButton.className = 'list-btn push-btn';
            pushButton.innerHTML = '<i class="fas fa-map-marker-alt"></i>';
            pushButton.onclick = () => pushABLineToMap(key);

            const deleteButton = document.createElement('button');
            deleteButton.className = 'list-btn delete-btn';
            deleteButton.innerHTML = '<i class="fas fa-trash"></i>';
            deleteButton.onclick = () => deleteABLine(key);

            listItem.appendChild(textSpan);
            listItem.appendChild(pushButton);
            listItem.appendChild(deleteButton);
            listEl.appendChild(listItem);
        });
    }
}

async function pushABLineToMap(fullKey) {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }
    if (navigationMode === 'row-follow') {
        showNotification('Switch to GPS Navigation mode to load AB lines.', 'error');
        return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=` + encodeURIComponent(fullKey);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (!data || !data.length || !data[0]) {
                showNotification("AB line data not found.", "error");
                return;
            }
            const config = data[0].value;

            if (!config || !config.pointA || !config.pointB) {
                showNotification("Invalid AB line data.", "error");
                return;
            }

            // Reset any existing AB state
            resetABState();

            abState.active = true;
            abState.workflow = 'line-guidance';
            abState.zoneCorners = [];
            abState.rowSpacing = 8.0;

            var rowInput = document.getElementById('row-spacing-input');
            if (rowInput) rowInput.value = abState.rowSpacing;

            // Set A and B
            abState.pointA = L.latLng(config.pointA.lat, config.pointA.lng);
            abState.pointB = L.latLng(config.pointB.lat, config.pointB.lng);

            var dx = abState.pointB.lng - abState.pointA.lng;
            var dy = abState.pointB.lat - abState.pointA.lat;
            abState.abAngleDeg = Math.atan2(dx, dy) * (180 / Math.PI);
            abState.step = 'ab-set';

            // Show A/B markers and the AB line
            var markerA = L.marker(abState.pointA, {
                icon: L.divIcon({
                    className: '',
                    html: '<div style="background:#22c55e;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);">A</div>',
                    iconSize: [28, 28], iconAnchor: [14, 14]
                })
            }).addTo(map);
            abState.lineLayers.push(markerA);

            var markerB = L.marker(abState.pointB, {
                icon: L.divIcon({
                    className: '',
                    html: '<div style="background:#ef4444;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);">B</div>',
                    iconSize: [28, 28], iconAnchor: [14, 14]
                })
            }).addTo(map);
            abState.lineLayers.push(markerB);

            var abLine = L.polyline([abState.pointA, abState.pointB], {
                color: '#f59e0b', weight: 3, dashArray: '8 6'
            }).addTo(map);
            abState.lineLayers.push(abLine);

            // Fit map to A/B points
            var bounds = L.latLngBounds([abState.pointA, abState.pointB]);
            map.fitBounds(bounds, { padding: [80, 80] });
            showNotification("AB line loaded: " + (config.displayName || fullKey.replace("abline_", "")) + ". Draw a zone to generate parallel lines.", "info");
        } else {
            showNotification("Failed to fetch AB line. Error: " + response.status, "error");
        }
    } catch (error) {
        console.error("Error loading AB line:", error);
        showNotification("Error loading AB line.", "error");
    }
}

async function deleteABLine(fullKey) {
    if (!token) {
        showNotification("Token not available. Please log in first.", "error");
        return;
    }

    const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/${deviceID}/SHARED_SCOPE?keys=` + encodeURIComponent(fullKey);

    try {
        const response = await fetch(apiEndpoint, {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                'X-Authorization': 'Bearer ' + token
            }
        });

        if (response.ok) {
            showNotification("AB line deleted.", "success");
            fetchSavedABLines();
        } else {
            showNotification("Failed to delete AB line. Error: " + response.status, "error");
        }
    } catch (error) {
        showNotification("Error deleting AB line.", "error");
    }
}

        // --- Export Mission XML (missionXml attribute) ---
        (function(){
                const btn = document.getElementById('bottom-export-btn');
                if (!btn) return;
                btn.addEventListener('click', async function () {
                        if (!token) { showNotification('Token not available. Please log in first.', 'error'); return; }
                        btn.disabled = true;
                        var _origExportHtml = btn.innerHTML;
                        var _exportSuccess = null;
                        btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i><span>Exporting…</span>';
                        try {

                        // ── Row-follow mode: export fixed BT mission ──
                        if (navigationMode === 'row-follow') {
                            const rfLines = [];
                            rfLines.push('<?xml version="1.0" encoding="UTF-8"?>');
                            rfLines.push('<root BTCPP_format="4"');
                            rfLines.push('  main_tree_to_execute="RootTree">');
                            rfLines.push('  <BehaviorTree ID="RootTree">');
                            rfLines.push('    <ReactiveSequence>');
                            rfLines.push('      <Fallback>');
                            rfLines.push('        <ReadPanel light="{lightStatus}"');
                            rfLines.push('                   button="{buttonStatus}"');
                            rfLines.push('                   potentiometer="{potentiometerStatus}"');
                            rfLines.push('                   notaus="{notausStatus}"');
                            rfLines.push('                   button_duration="{buttonDuration}"/>');
                            rfLines.push('        <ForceFailure>');
                            rfLines.push('          <ManualMode light="{lightStatus}"/>');
                            rfLines.push('        </ForceFailure>');
                            rfLines.push('      </Fallback>');
                            rfLines.push('');
                            rfLines.push('      <Fallback>');
                            rfLines.push('        <SubTree ID="isSensorOk"');
                            rfLines.push('                 _autoremap="true"/>');
                            rfLines.push('        <Inverter>');
                            rfLines.push('          <ForceManualMode button="{buttonStatus}"/>');
                            rfLines.push('        </Inverter>');
                            rfLines.push('      </Fallback>');
                            rfLines.push('');
                            rfLines.push('      <Fallback>');
                            rfLines.push('        <IsStopRequested topic_name="/stop_requested" invert="false"/>');
                            rfLines.push('        <Inverter>');
                            rfLines.push('          <ForceManualMode button="{buttonStatus}"/>');
                            rfLines.push('        </Inverter>');
                            rfLines.push('      </Fallback>');
                            rfLines.push('');
                            rfLines.push('      <ReactiveSequence>');
                            rfLines.push('        <IsStopRequested topic_name="/navigation_button" invert="false"/>');
                            rfLines.push('        <SequenceWithMemory>');
                            rfLines.push('          <FollowRowUntilEndOfRow action_name="follow_row_to_end"/>');
                            rfLines.push('          <RetryUntilSuccessful num_attempts="-1">');
                            rfLines.push('            <Sequence>');
                            rfLines.push('              <Delay delay_msec="100">');
                            rfLines.push('                <ForceManualMode button="{buttonStatus}"/>');
                            rfLines.push('              </Delay>');
                            rfLines.push('              <Inverter>');
                            rfLines.push('                <ReadPanel light="{lightStatus}"');
                            rfLines.push('                      button="{buttonStatus}"');
                            rfLines.push('                      potentiometer="{potentiometerStatus}"');
                            rfLines.push('                      notaus="{notausStatus}"');
                            rfLines.push('                      button_duration="{buttonDuration}"/>');
                            rfLines.push('              </Inverter>');
                            rfLines.push('            </Sequence>');
                            rfLines.push('          </RetryUntilSuccessful>');
                            rfLines.push('        </SequenceWithMemory>');
                            rfLines.push('      </ReactiveSequence>');
                            rfLines.push('    </ReactiveSequence>');
                            rfLines.push('  </BehaviorTree>');
                            rfLines.push('');
                            rfLines.push('  <BehaviorTree ID="initialization">');
                            rfLines.push('    <Sequence>');
                            rfLines.push('      <RetryUntilSuccessful num_attempts="-1">');
                            rfLines.push('        <Sequence>');
                            rfLines.push('          <SetLightMode light="51"/>');
                            rfLines.push('          <SubTree ID="isSensorOk"');
                            rfLines.push('                   _autoremap="true"/>');
                            rfLines.push('          <Delay delay_msec="100">');
                            rfLines.push('            <ForceManualMode button="{buttonStatus}"/>');
                            rfLines.push('          </Delay>');
                            rfLines.push('          <Inverter>');
                            rfLines.push('            <ReadPanel light="{lightStatus}"');
                            rfLines.push('                       button="{buttonStatus}"');
                            rfLines.push('                       potentiometer="{potentiometerStatus}"');
                            rfLines.push('                       notaus="{notausStatus}"');
                            rfLines.push('                       button_duration="{buttonDuration}"/>');
                            rfLines.push('          </Inverter>');
                            rfLines.push('        </Sequence>');
                            rfLines.push('      </RetryUntilSuccessful>');
                            rfLines.push('      <Fallback>');
                            rfLines.push('        <RetryUntilSuccessful num_attempts="5">');
                            rfLines.push('          <Inverter>');
                            rfLines.push('            <SetLightMode light="52"/>');
                            rfLines.push('          </Inverter>');
                            rfLines.push('        </RetryUntilSuccessful>');
                            rfLines.push('        <AlwaysSuccess/>');
                            rfLines.push('      </Fallback>');
                            rfLines.push('    </Sequence>');
                            rfLines.push('  </BehaviorTree>');
                            rfLines.push('  <BehaviorTree ID="isSensorOk">');
                            rfLines.push('    <Sequence>');
                            rfLines.push('      <IsLidarOk topic_name="/valera/front/lidar"/>');
                            rfLines.push('    </Sequence>');
                            rfLines.push('  </BehaviorTree>');
                            rfLines.push('  <TreeNodesModel>');
                            rfLines.push('    <Action ID="FollowRowUntilEndOfRow"');
                            rfLines.push('            editable="true">');
                            rfLines.push('      <input_port name="action_name"');
                            rfLines.push('                  default="follow_row_to_end"/>');
                            rfLines.push('    </Action>');
                            rfLines.push('    <Action ID="ForceManualMode"');
                            rfLines.push('            editable="true">');
                            rfLines.push('      <input_port name="button"');
                            rfLines.push('                  default="{buttonStatus}"/>');
                            rfLines.push('    </Action>');
                            rfLines.push('    <Action ID="ManualMode"');
                            rfLines.push('            editable="true">');
                            rfLines.push('      <input_port name="light"/>');
                            rfLines.push('    </Action>');
                            rfLines.push('    <Action ID="ReadPanel"');
                            rfLines.push('            editable="true">');
                            rfLines.push('      <output_port name="light"/>');
                            rfLines.push('      <output_port name="button"/>');
                            rfLines.push('      <output_port name="potentiometer"/>');
                            rfLines.push('      <output_port name="notaus"/>');
                            rfLines.push('      <output_port name="button_duration"/>');
                            rfLines.push('    </Action>');
                            rfLines.push('    <Action ID="SetLightMode"');
                            rfLines.push('            editable="true">');
                            rfLines.push('      <input_port name="light"');
                            rfLines.push('                  default="52"/>');
                            rfLines.push('    </Action>');
                            rfLines.push('    <Condition ID="IsLidarOk"');
                            rfLines.push('               editable="true"/>');
                            rfLines.push('  </TreeNodesModel>');
                            rfLines.push('</root>');
                            const rfXml = rfLines.join('\n');
                            try {
                                const resp = await fetch(`https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`, {
                                    method: 'POST',
                                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Authorization': 'Bearer ' + token },
                                    body: JSON.stringify({ missionXml: rfXml })
                                });
                                if (resp.ok) {
                                    showNotification('Row following mission exported — syncing with robot...', 'success');
                                    _exportSuccess = await sendNavRpc('syncPlan', 'Sync mission') === true;
                                } else {
                                    showNotification('Failed to export row following mission', 'error');
                                    _exportSuccess = false;
                                }
                            } catch (err) {
                                showNotification('Error exporting row following mission', 'error');
                                _exportSuccess = false;
                            }
                            return;
                        }

                        // ── GPS Navigation mode: normal waypoint-based export ──

                        // Try to fetch waypoints from device attribute 'gpsPath'
                        let waypoints = [];
                        try {
                            const apiEndpoint = `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=gpsPath`;
                            const r = await fetch(apiEndpoint, {
                                method: 'GET',
                                headers: {
                                    'Accept': 'application/json',
                                    'X-Authorization': 'Bearer ' + token
                                }
                            });
                            if (r.ok) {
                                const data = await r.json();
                                if (data && data[0] && data[0].value && Array.isArray(data[0].value) && data[0].value.length > 0) {
                                    waypoints = data[0].value;
                                }
                            } else {
                                console.warn('Failed to fetch gpsPath attribute, status=', r.status);
                            }
                        } catch (err) {
                            console.error('Error fetching gpsPath attribute:', err);
                        }

                        // Fallback to local latlngs if attribute empty
                        if ((!waypoints || waypoints.length === 0) && latlngs && latlngs.length > 0) {
                            waypoints = latlngs.slice();
                        }

                        if (!waypoints || waypoints.length === 0) {
                            showNotification('No saved waypoints to export (gpsPath empty).', 'error');
                            return;
                        }

                        function fmt(n){ return Number(n).toFixed(12); }

                        // Build nicely formatted XML lines
                        const lines = [];
                        lines.push('<?xml version="1.0" encoding="UTF-8"?>');
                        lines.push('<root BTCPP_format="4"');
                        lines.push('  main_tree_to_execute="RootTree">');
                        lines.push('  <BehaviorTree ID="RootTree">');
                        lines.push('    <ReactiveSequence>');
                        lines.push('      <Fallback>');
                        lines.push('        <ReadPanel light="{lightStatus}"');
                        lines.push('                   button="{buttonStatus}"');
                        lines.push('                   potentiometer="{potentiometerStatus}"');
                        lines.push('                   notaus="{notausStatus}"');
                        lines.push('                   button_duration="{buttonDuration}"/>');
                        lines.push('        <ForceFailure>');
                        lines.push('          <ManualMode light="{lightStatus}"/>');
                        lines.push('        </ForceFailure>');
                        lines.push('      </Fallback>');
                        lines.push('');
                        lines.push('      <Fallback>');
                        lines.push('        <SubTree ID="isSensorOk"');
                        lines.push('                 _autoremap="true"/>');
                        lines.push('        <Inverter>');
                        lines.push('          <ForceManualMode button="{buttonStatus}"/>');
                        lines.push('        </Inverter>');
                        lines.push('      </Fallback>');
                        lines.push('');
                        lines.push('      <IsRTKOK topic_name="/gpsfix" delay_sec="1"/>');
                        lines.push('');
                        lines.push('      <Fallback>');
                        lines.push('        <IsStopRequested topic_name="/stop_requested" invert="false"/>');
                        lines.push('        <Inverter>');
                        lines.push('          <ForceManualMode button="{buttonStatus}"/>');
                        lines.push('        </Inverter>');
                        lines.push('      </Fallback>');

                        lines.push('      <!-- GNSS stuff here -->');
                        //lines.push('      <Sequence>');
                        lines.push('      <ReactiveSequence>');
                        lines.push('');
                        lines.push('        <IsStopRequested topic_name="/navigation_button" invert="false"/>');
                        lines.push('');
                        lines.push('        <SequenceWithMemory>');

                        // // Per-waypoint Convert + GoTo
                        // for (let i = 0; i < waypoints.length; i++) {
                        //     const p = waypoints[i];
                        //     // compute quaternion from yaw if provided
                        //     // Note: `p.yaw` is stored as the icon rotation (display yaw),
                        //     // which was adjusted by -90° to align the graphic. Convert
                        //     // it back to north-referenced yaw for the mission XML.
                        //     const storedYaw = (p && typeof p.yaw === 'number') ? p.yaw : 0.0;
                        //     // const yawDeg = (90 - storedYaw + 360) % 360;
                        //     const yawDeg = storedYaw;
                        //     const yawRad = yawDeg * Math.PI / 180.0;
                        //     const yawCentered = Math.atan2(Math.sin(-yawRad),Math.cos(yawRad));
                        //     const qx = 0.0;
                        //     const qy = 0.0;
                        //     const qz = Math.sin(yawCentered / 2.0);
                        //     const qw = Math.cos(yawCentered / 2.0);
                        //     lines.push('         <ConvertGnssPointToLocal latitude="' + fmt(p.lat) + '" longitude="' + fmt(p.lng) + '" altitude="0.0" Qx="' + fmt(qx) + '" Qy="' + fmt(qy) + '" Qz="' + fmt(qz) + '" Qw="' + fmt(qw) + '" ' +
                        //               '\n                                   pose="{wp_pose}" position_x="{x}" position_y="{y}" position_z="{z}" orientation_x="{qx}" orientation_y="{qy}" orientation_z="{qz}" orientation_w="{qw}"/>');
                        //     lines.push('         <GoTo position_x="{x}" position_y="{y}" position_z="{z}" orientation_x="{qx}" orientation_y="{qy}" orientation_z="{qz}" orientation_w="{qw}" frame_id="map"/>');
                        // }
                        // ConvertGnssPointsToLocal + GoThrough, split at follow-row segment boundaries
                        {
                            // Build groups: each follow-row waypoint starts a new group
                            const wpGroups = [];
                            let gStart = 0;
                            for (let gi = 1; gi < waypoints.length; gi++) {
                                if (waypoints[gi].followRow) {
                                    wpGroups.push(waypoints.slice(gStart, gi));
                                    gStart = gi;
                                }
                            }
                            wpGroups.push(waypoints.slice(gStart));

                            const multiGroup = wpGroups.length > 1;

                            for (let g = 0; g < wpGroups.length; g++) {
                                if (g > 0) {
                                    lines.push('            <FollowRowUntilEndOfRow action_name="follow_row_to_end"/>');
                                }
                                const group = wpGroups[g];
                                const gFirst = group[0];
                                const gLast  = group[group.length - 1];
                                const posesVar = multiGroup ? '{poses_' + g + '}' : '{poses}';

                                lines.push('            <ConvertGnssPointsToLocal');
                                if (group.length === 1) {
                                    lines.push('            gnss_points="' + fmt(gFirst.lat) + ', ' + fmt(gFirst.lng) + ',0.0"');
                                } else {
                                    lines.push('            gnss_points="' + fmt(gFirst.lat) + ', ' + fmt(gFirst.lng) + ',0.0;');
                                    for (let j = 1; j < group.length - 1; j++) {
                                        lines.push('                         ' + fmt(group[j].lat) + ', ' + fmt(group[j].lng) + ',0.0;');
                                    }
                                    lines.push('                         ' + fmt(gLast.lat) + ', ' + fmt(gLast.lng) + ',0.0"');
                                }
                                const storedYaw = (gLast && typeof gLast.yaw === 'number') ? gLast.yaw : 0.0;
                                const yawRad = storedYaw * Math.PI / 180.0;
                                const yawCentered = Math.atan2(Math.sin(-yawRad), Math.cos(yawRad));
                                const qx = 0.0, qy = 0.0;
                                const qz = Math.sin(yawCentered / 2.0);
                                const qw = Math.cos(yawCentered / 2.0);
                                lines.push('            last_qx="' + fmt(qx) + '"');
                                lines.push('            last_qy="' + fmt(qy) + '"');
                                lines.push('            last_qz="' + fmt(qz) + '"');
                                lines.push('            last_qw="' + fmt(qw) + '"');
                                lines.push('            poses="' + posesVar + '" />');
                                lines.push('            <GoThrough poses="' + posesVar + '"/>');
                            }
                        }
                        lines.push('            <RetryUntilSuccessful num_attempts="-1">');
                        lines.push('              <Sequence>');
                        lines.push('                <Delay delay_msec="100">');
                        lines.push('                  <ForceManualMode button="{buttonStatus}"/>');
                        lines.push('                </Delay>');
                        lines.push('                <Inverter>');
                        lines.push('                  <ReadPanel light="{lightStatus}"');
                        lines.push('                        button="{buttonStatus}"');
                        lines.push('                        potentiometer="{potentiometerStatus}"');
                        lines.push('                        notaus="{notausStatus}"');
                        lines.push('                        button_duration="{buttonDuration}"/>');
                        lines.push('                </Inverter>');
                        lines.push('              </Sequence>');
                        lines.push('            </RetryUntilSuccessful>');
                        lines.push('        </SequenceWithMemory>');
                        lines.push('      </ReactiveSequence>');
                        lines.push('');
                        lines.push('    </ReactiveSequence>');
                        lines.push('');
                        lines.push('  </BehaviorTree>');
                        lines.push('');
                        lines.push('');
                        lines.push('  <BehaviorTree ID="initialization">');
                        lines.push('    <Sequence>');
                        lines.push('      <RetryUntilSuccessful num_attempts="-1">');
                        lines.push('        <Sequence>');
                        lines.push('          <SetLightMode light="51"/>');
                        lines.push('          <SubTree ID="isSensorOk"');
                        lines.push('                   _autoremap="true"/>');
                        lines.push('          <Delay delay_msec="100">');
                        lines.push('            <ForceManualMode button="{buttonStatus}"/>');
                        lines.push('          </Delay>');
                        lines.push('          <Inverter>');
                        lines.push('            <ReadPanel light="{lightStatus}"');
                        lines.push('                       button="{buttonStatus}"');
                        lines.push('                       potentiometer="{potentiometerStatus}"');
                        lines.push('                       notaus="{notausStatus}"');
                        lines.push('                       button_duration="{buttonDuration}"/>');
                        lines.push('          </Inverter>');
                        lines.push('');
                        lines.push('        </Sequence>');
                        lines.push('      </RetryUntilSuccessful>');
                        lines.push('      <Fallback>');
                        lines.push('        <RetryUntilSuccessful num_attempts="5">');
                        lines.push('          <Inverter>');
                        lines.push('            <SetLightMode light="52"/>');
                        lines.push('          </Inverter>');
                        lines.push('        </RetryUntilSuccessful>');
                        lines.push('        <AlwaysSuccess/>');
                        lines.push('      </Fallback>');
                        lines.push('    </Sequence>');
                        lines.push('  </BehaviorTree>');
                        lines.push('  <BehaviorTree ID="isSensorOk">');
                        lines.push('    <Sequence>');
                        lines.push('      <IsLidarOk topic_name="/valera/front/lidar"/>');
                        lines.push('    </Sequence>');
                        lines.push('  </BehaviorTree>');
                        lines.push('  <!-- Description of Node Models (used by Groot) -->');
                        lines.push('  <TreeNodesModel>');
                        lines.push('    <Action ID="FollowRowUntilEndOfRow"');
                        lines.push('            editable="true">');
                        lines.push('      <input_port name="action_name"');
                        lines.push('                  default="follow_row_to_end"/>');
                        lines.push('    </Action>');
                        lines.push('    <Action ID="StartLight"');
                        lines.push('            editable="true">');
                        lines.push('      <input_port name="topic_name"');
                        lines.push('                  default="/light_command"/>');
                        lines.push('       <input_port name="light"');
                        lines.push('                  default="3"/>');
                        lines.push('    </Action>');
                        lines.push('    <Action ID="ForceManualMode"');
                        lines.push('            editable="true">');
                        lines.push('      <input_port name="button"');
                        lines.push('                  default="{buttonStatus}"/>');
                        lines.push('    </Action>');
                        lines.push('    <Condition ID="IsCameraOk"');
                        lines.push('               editable="true"/>');
                        lines.push('    <Condition ID="IsLidarOk"');
                        lines.push('               editable="true"/>');
                        lines.push('    <Action ID="ManualMode"');
                        lines.push('            editable="true">');
                        lines.push('      <input_port name="light"/>');
                        lines.push('    </Action>');
                        lines.push('    <Action ID="ReadPanel"');
                        lines.push('            editable="true">');
                        lines.push('      <output_port name="light"/>');
                        lines.push('      <output_port name="button"/>');
                        lines.push('      <output_port name="potentiometer"/>');
                        lines.push('      <output_port name="notaus"/>');
                        lines.push('      <output_port name="button_duration"/>');
                        lines.push('    </Action>');
                        lines.push('    <Action ID="SetLightMode"');
                        lines.push('            editable="true">');
                        lines.push('      <input_port name="light"');
                        lines.push('                  default="52"/>');
                        lines.push('    </Action>');
                        lines.push('  </TreeNodesModel>');
                        lines.push('</root>');

                        const xml = lines.join('\n');

                        try {
                                const resp = await fetch(`https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`, {
                                        method: 'POST',
                                        headers: {
                                                'Accept': 'application/json',
                                                'Content-Type': 'application/json',
                                                'X-Authorization': 'Bearer ' + token
                                        },
                                        body: JSON.stringify({ missionXml: xml })
                                });
                                if (resp.ok) {
                                        showNotification('Mission exported — syncing with robot...', 'success');
                                        try { fetchSavedPaths(); } catch (e) {}
                                        // Sync mission to robot via RPC
                                        _exportSuccess = await sendNavRpc('syncPlan', 'Sync mission') === true;
                                } else {
                                        console.error('Failed to push mission XML:', await resp.text());
                                        showNotification('Failed to export Mission XML', 'error');
                                        _exportSuccess = false;
                                }
                        } catch (err) {
                                console.error('Error pushing mission XML:', err);
                                showNotification('Error pushing mission XML', 'error');
                                _exportSuccess = false;
                        }

                        } finally {
                            if (_exportSuccess === true) {
                                btn.innerHTML = '<i class="fas fa-check" style="color:#4ade80;"></i><span>Exporting Mission Done</span>';
                                setTimeout(function() { btn.disabled = false; btn.innerHTML = _origExportHtml; }, 1500);
                            } else if (_exportSuccess === false) {
                                btn.innerHTML = '<i class="fas fa-times" style="color:#f87171;"></i><span>Exporting Mission Failed</span>';
                                setTimeout(function() { btn.disabled = false; btn.innerHTML = _origExportHtml; }, 1500);
                            } else {
                                btn.disabled = false;
                                btn.innerHTML = _origExportHtml;
                            }
                        }
                });
        })();

widgetIntervals.push(setInterval(initializeMapIfNeeded, 1000));

// ══════════════════════════════════════════════
// ── Status Bar Telemetry Polling ──
// ══════════════════════════════════════════════

// Connectivity (same as map.html — uses telemetry_time)
async function fetchConnectivityTime() {
    try {
        const res = await fetch(
            `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/timeseries?keys=telemetry_time`,
            { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } }
        );
        if (!res.ok) { if (res.status === 401) showJwtExpiredPopup(); return null; }
        const data = await res.json();
        if (data.telemetry_time && data.telemetry_time[0]) {
            return parseInt(data.telemetry_time[0].value);
        }
        return null;
    } catch (err) {
        console.error('Error fetching telemetry_time:', err);
        return null;
    }
}

async function updateConnectivityStatus() {
    if (!isAlive() || !token) return;
    const telemetryTime = await fetchConnectivityTime();
    if (!isAlive()) return;
    const connectivityEl = document.getElementById('connectivity-status');
    const activityDot = document.getElementById('activity-dot');
    const connBlock = document.getElementById('connectivity-block');
    if (!connectivityEl || !activityDot) return;
    activityDot.classList.remove('online', 'intermittent', 'offline');
    if (connBlock) connBlock.classList.remove('conn-online', 'conn-intermittent', 'conn-offline');
    if (telemetryTime) {
        const timeDiff = Math.floor(Date.now() / 1000) - telemetryTime;
        if (timeDiff < 10) {
            connectivityEl.textContent = 'ONLINE';
            connectivityEl.style.color = '';
            activityDot.classList.add('online');
            if (connBlock) connBlock.classList.add('conn-online');
        } else if (timeDiff < 20) {
            connectivityEl.textContent = 'INTERMITTENT';
            connectivityEl.style.color = '';
            activityDot.classList.add('intermittent');
            if (connBlock) connBlock.classList.add('conn-intermittent');
        } else {
            connectivityEl.textContent = 'OFFLINE';
            connectivityEl.style.color = '';
            activityDot.classList.add('offline');
            if (connBlock) connBlock.classList.add('conn-offline');
        }
    } else {
        connectivityEl.textContent = 'UNKNOWN';
        connectivityEl.style.color = 'gray';
    }
}

widgetIntervals.push(setInterval(updateConnectivityStatus, 5000));

// Status bar telemetry: batteryVoltage, navigation_state, mode, emergencyButton, gpsPathCount
async function updateStatusBar() {
    if (!isAlive() || !token) return;
    try {
        const keys = 'batteryVoltage,navigation_state,mode,emergencyButton';
        const res = await fetch(
            `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/timeseries?keys=${encodeURIComponent(keys)}`,
            { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } }
        );
        if (!res.ok || !isAlive()) { if (res.status === 401) showJwtExpiredPopup(); return; }
        const data = await res.json();
        if (!isAlive()) return;

        // Battery Voltage
        const voltage = data.batteryVoltage?.[0]?.value;
        if (voltage !== undefined) {
            const v = parseFloat(voltage);
            const voltEl = document.getElementById('voltage-value');
            const batEl = document.getElementById('battery-value');
            if (!voltEl || !batEl) return; // DOM removed during await
            voltEl.textContent = v.toFixed(1) + 'V';
            // Estimate battery % (adjust range to your battery: e.g. 22V=0%, 29.4V=100%)
            const minV = 22, maxV = 29.4;
            const pct = Math.max(0, Math.min(100, Math.round(((v - minV) / (maxV - minV)) * 100)));
            batEl.textContent = pct + '%';
            // Update battery icon
            const batIcon = document.querySelector('#bottom-status-bar .status-block:nth-child(3) .status-icon');
            if (batIcon) {
                batIcon.className = 'fas status-icon';
                if (pct > 75) batIcon.classList.add('fa-battery-full');
                else if (pct > 50) batIcon.classList.add('fa-battery-three-quarters');
                else if (pct > 25) batIcon.classList.add('fa-battery-half');
                else if (pct > 10) batIcon.classList.add('fa-battery-quarter');
                else batIcon.classList.add('fa-battery-empty');
                batIcon.style.color = pct <= 15 ? '#ef4444' : pct <= 30 ? '#f59e0b' : '';
            }
        }

        // GPS / Navigation State
        const navState = data.navigation_state?.[0]?.value;
        if (navState !== undefined) {
            const gpsEl = document.getElementById('gps-status');
            const gpsBlock = document.getElementById('gps-block');
            if (!gpsEl) return; // DOM removed during await
            gpsEl.textContent = navState || 'Idle';
            gpsEl.style.color = '';
            if (gpsBlock) gpsBlock.classList.remove('gps-running', 'gps-paused', 'gps-error');
            if (navState === 'RUNNINGS' || navState === 'RUNNING' || navState === 'READY' || navState === 'GPS_READY' || navState === 'GPS READY') {
                if (gpsBlock) gpsBlock.classList.add('gps-running');
            } else if (navState === 'PAUSED') {
                if (gpsBlock) gpsBlock.classList.add('gps-paused');
            } else if (navState === 'ABORTED' || navState === 'UNAVAILABLE') {
                if (gpsBlock) gpsBlock.classList.add('gps-error');
            }
        }

        // Autonomy Mode
        const modeVal = data.mode?.[0]?.value;
        if (modeVal !== undefined) {
            const autonomyEl = document.getElementById('autonomy-value');
            const autonomyIcon = document.getElementById('autonomy-icon');
            const autonomyBlock = document.getElementById('autonomy-block');
            if (!autonomyEl) return; // DOM removed during await
            const isAuto = modeVal === 'autonomous' || modeVal === 'auto' || modeVal === '1' || modeVal === 'true';
            autonomyEl.textContent = isAuto ? 'Auto' : 'Manual';
            autonomyEl.className = 'status-value';
            if (autonomyBlock) {
                autonomyBlock.classList.remove('autonomy-auto', 'autonomy-manual');
                autonomyBlock.classList.add(isAuto ? 'autonomy-auto' : 'autonomy-manual');
            }
            if (autonomyIcon) {
                autonomyIcon.className = 'fas fa-robot status-icon';
            }
        }

        // Emergency Button
        const emergencyVal = data.emergencyButton?.[0]?.value;
        if (emergencyVal !== undefined) {
            const emergencyBlock = document.getElementById('emergency-block');
            const emergencyEl = document.getElementById('emergency-value');
            if (!emergencyEl) return; // DOM removed during await
            const isPressed = emergencyVal === '1' || emergencyVal === 'true' || emergencyVal === 'pressed';
            emergencyEl.textContent = isPressed ? 'PRESSED' : 'NOT PRESSED';
            if (isPressed) {
                emergencyBlock.classList.add('emergency-active');
            } else {
                emergencyBlock.classList.remove('emergency-active');
            }
        }

    } catch (err) {
        console.error('Error updating status bar:', err);
    }
}

widgetIntervals.push(setInterval(updateStatusBar, 3000));

// Waypoint count — fetched from shared attributes and also updated locally
async function updateWaypointCount() {
    // Update immediately from local state
    const el = document.getElementById('waypoint-count');
    if (el) el.textContent = latlngs.length;

    // Also sync from server attribute
    if (!isAlive() || !token) return;
    try {
        const res = await fetch(
            `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=gpsPathCount`,
            { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } }
        );
        if (res.ok && isAlive()) {
            const data = await res.json();
            const val = data?.[0]?.value;
            if (val !== undefined && el) {
                el.textContent = val;
            }
        }
    } catch (e) { /* ignore */ }
}

widgetIntervals.push(setInterval(updateWaypointCount, 5000));

// ── ab_gps trigger: when telemetry ab_gps=true, run Generate Line and reset to false ──
let _abGpsTriggerInFlight = false;
async function checkAbGpsTrigger() {
    if (!isAlive() || !token || _abGpsTriggerInFlight) return;
    try {
        const res = await fetch(
            `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/timeseries?keys=ab_gps`,
            { headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token } }
        );
        if (!res.ok || !isAlive()) {
            if (res.status === 401) showJwtExpiredPopup();
            return;
        }
        const data = await res.json();
        if (!isAlive()) return;
        const raw = data?.ab_gps?.[0]?.value;
        const ts  = data?.ab_gps?.[0]?.ts;
        const isTrue = raw === true || raw === 'true' || raw === '1' || raw === 1;
        if (!isTrue) return;

        console.log('[ab_gps] TRIGGER fired (raw=', raw, ', ts=', ts, ') — running generateLineGuidanceWaypoints()');
        _abGpsTriggerInFlight = true;
        try {
            if (typeof generateLineGuidanceWaypoints === 'function') {
                generateLineGuidanceWaypoints();
                console.log('[ab_gps] generateLineGuidanceWaypoints() returned');
            } else {
                console.error('[ab_gps] generateLineGuidanceWaypoints is not defined');
            }
            console.log('[ab_gps] POSTing ab_gps=false to reset trigger');
            const postRes = await fetch(
                `https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/timeseries/ANY`,
                {
                    method: 'POST',
                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ ab_gps: false })
                }
            );
            console.log('[ab_gps] reset POST status=', postRes.status, postRes.ok ? 'OK' : 'FAILED');
        } catch (postErr) {
            console.error('[ab_gps] Failed to reset ab_gps:', postErr);
        } finally {
            _abGpsTriggerInFlight = false;
        }
    } catch (err) {
        console.error('[ab_gps] Error checking trigger:', err);
    }
}

widgetIntervals.push(setInterval(checkAbGpsTrigger, 2000));

// ══════════════════════════════════════════════
// ── Navigation RPC Controls ──
// ══════════════════════════════════════════════

async function sendNavRpc(method, label, btn) {
    if (!token) {
        showNotification('Token not available. Please log in first.', 'error');
        return;
    }
    var _origBtnHtml = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Sending…</span>';
    }
    showNotification('Sending: ' + label, 'info');
    var _rpcSuccess = null;
    try {
        const res = await fetch('https://dashboard.antrobotics.de/api/rpc/twoway/' + "${deviceID}", {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                method: method,
                params: {},
                persistent: false,
                timeout: 5000
            })
        });
        const text = await res.text();
        let payload;
        try { payload = JSON.parse(text); } catch (e) { payload = text; }

        if (res.ok) {
            const msg = (typeof payload === 'object' && payload.message) ? payload.message : label + ' sent successfully';
            showNotification(msg, 'success');
            _rpcSuccess = true;
        } else {
            let msg;
            if (typeof payload === 'object' && payload.message) {
                msg = payload.message;
            } else if (res.status === 504 || res.status === 408) {
                msg = 'Robot not responding — check connection and try again';
            } else if (res.status === 401 || res.status === 403) {
                if (res.status === 401) showJwtExpiredPopup();
                msg = 'Session expired — please refresh and log in again';
            } else if (res.status >= 500) {
                msg = 'Server unavailable — please try again in a moment';
            } else {
                msg = 'Could not complete request — please try again';
            }
            showNotification(msg, 'error');
            _rpcSuccess = false;
        }
    } catch (err) {
        showNotification('No connection — check your network and try again', 'error');
        _rpcSuccess = false;
    } finally {
        if (btn && _origBtnHtml !== null) {
            if (_rpcSuccess === true) {
                btn.innerHTML = '<i class="fas fa-check" style="color:#4ade80;"></i><span>Done</span>';
                setTimeout(function() { btn.disabled = false; btn.innerHTML = _origBtnHtml; }, 1500);
            } else if (_rpcSuccess === false) {
                btn.innerHTML = '<i class="fas fa-times" style="color:#f87171;"></i><span>Failed</span>';
                setTimeout(function() { btn.disabled = false; btn.innerHTML = _origBtnHtml; }, 1500);
            } else {
                btn.disabled = false;
                btn.innerHTML = _origBtnHtml;
            }
        }
    }
    return _rpcSuccess;
}

document.getElementById('nav-start-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    sendNavRpc('start', 'Start navigation', this);
});
document.getElementById('nav-pause-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    sendNavRpc('pause', 'Pause navigation', this);
});
document.getElementById('nav-stop-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    sendNavRpc('stop', 'Stop navigation', this);
});

// Prevent clicks on UI controls from bubbling to the map (which creates waypoints)
function preventMapClickOnControls() {
    try {
        const selectors = [
            '.sidebar-btn',
            '#left-sidebar',
            '#row-spacing-panel',
            '#row-spacing-panel',
            '#paths-container',
            '#paths-list',
            '#zones-list',
            '.list-container',
            '#top-status-bar',
            '#bottom-status-bar',
            '#nav-controls-panel',
            '.nav-btn'
        ];
        // Check if event originates from #home (ThingsBoard action button)
        function isFromTBAction(e) {
            var t = e.target;
            while (t) {
                if (t.id === 'home') return true;
                t = t.parentElement;
            }
            return false;
        }
        selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                el.addEventListener('click', function(e){ if (!isFromTBAction(e)) e.stopPropagation(); });
                el.addEventListener('mousedown', function(e){ if (!isFromTBAction(e)) e.stopPropagation(); });
                el.addEventListener('dblclick', function(e){ if (!isFromTBAction(e)) e.stopPropagation(); });
            });
        });
        document.querySelectorAll('#row-spacing-panel input, #row-spacing-panel button, #left-sidebar button').forEach(el => {
            el.addEventListener('click', function(e){ if (!isFromTBAction(e)) e.stopPropagation(); });
            el.addEventListener('mousedown', function(e){ if (!isFromTBAction(e)) e.stopPropagation(); });
        });
    } catch (err) { console.error('preventMapClickOnControls error', err); }
}

// Run once to attach handlers
preventMapClickOnControls();

// ══════════════════════════════════════════════════════════
// ── SIDEBAR TOUCH TOOLTIP ──────────────────────────────────
// ══════════════════════════════════════════════════════════
(function() {
    var tooltipEl = null;
    var tooltipTimer = null;
    var TOOLTIP_DELAY = 400; // ms before tooltip appears
    var TOOLTIP_DURATION = 2200; // ms tooltip stays visible

    function showTooltip(btn) {
        hideTooltip();
        var label = btn.getAttribute('title');
        if (!label) return;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'sidebar-touch-tooltip';
        tooltipEl.textContent = label;
        // Append to sidebar (not button) to avoid overflow:hidden clipping
        var sidebar = document.getElementById('left-sidebar');
        sidebar.appendChild(tooltipEl);
        // Position relative to the button
        var btnRect = btn.getBoundingClientRect();
        var sidebarRect = sidebar.getBoundingClientRect();
        tooltipEl.style.position = 'absolute';
        tooltipEl.style.left = (btnRect.right - sidebarRect.left + 8) + 'px';
        tooltipEl.style.top = (btnRect.top - sidebarRect.top + btnRect.height / 2) + 'px';
        tooltipEl.style.transform = 'translateY(-50%)';
        // Force reflow then show
        void tooltipEl.offsetWidth;
        tooltipEl.classList.add('visible');
        tooltipTimer = setTimeout(hideTooltip, TOOLTIP_DURATION);
    }

    function hideTooltip() {
        if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
        if (tooltipEl && tooltipEl.parentNode) {
            tooltipEl.parentNode.removeChild(tooltipEl);
        }
        tooltipEl = null;
    }

    var btns = document.querySelectorAll('#left-sidebar .sidebar-btn');
    btns.forEach(function(btn) {
        var holdTimer = null;
        var longPressTriggered = false;
        // Prevent native context menu (long-press selection menu) on touch
        btn.addEventListener('contextmenu', function(e) { e.preventDefault(); });
        btn.addEventListener('touchstart', function() {
            longPressTriggered = false;
            holdTimer = setTimeout(function() {
                longPressTriggered = true;
                holdTimer = null;
                showTooltip(btn);
            }, TOOLTIP_DELAY);
        }, { passive: true });
        btn.addEventListener('touchend', function() {
            if (holdTimer) {
                // Short tap — cancel timer, browser will synthesize the click naturally
                clearTimeout(holdTimer);
                holdTimer = null;
            }
            // Long press: longPressTriggered=true, click listener will suppress it
        }, { passive: true });
        btn.addEventListener('click', function(e) {
            if (longPressTriggered) {
                // Tooltip was shown — suppress the click so no action fires
                e.stopImmediatePropagation();
                e.preventDefault();
                longPressTriggered = false;
            }
        });
        btn.addEventListener('touchcancel', function() {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            longPressTriggered = false;
            hideTooltip();
        }, { passive: true });
        btn.addEventListener('touchmove', function() {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            longPressTriggered = false;
            hideTooltip();
        }, { passive: true });
    });
})();

// ══════════════════════════════════════════════
// ── Click & Go Template Logic ──
// ══════════════════════════════════════════════
var clickGoState = {
    active: false,
    picking: null,       // 'A', 'B', or null
    pointA: null,        // {lat, lng}
    pointB: null,
    markerA: null,       // Leaflet Marker
    markerB: null,
    line: null,          // Leaflet Polyline
};

function buildClickGoPanel() {
    if (document.getElementById('clickgo-panel')) return;

    // Overlay
    var overlay = document.createElement('div');
    overlay.id = 'clickgo-overlay';
    overlay.onclick = closeClickGoPanel;
    document.body.appendChild(overlay);

    // Panel
    var panel = document.createElement('div');
    panel.id = 'clickgo-panel';
    panel.innerHTML =
        '<div class="cg-header">' +
        '  <h3><i class="fas fa-route" style="margin-right:8px;color:#60a5fa;"></i>Click &amp; Go</h3>' +
        '  <button class="cg-close" onclick="closeClickGoPanel()">&times;</button>' +
        '</div>' +
        '<div class="cg-body">' +
        '  <div style="font-size:13px;color:#9ca3af;margin-bottom:14px;">Robot shuttle mission — drives back and forth between A and B.</div>' +
        '  <ol class="cg-mission-list" id="cg-mission-list">' +
        '    <li><span class="cg-step-num">1</span> Click the <b>Go</b> button</li>' +
        '    <li><span class="cg-step-num">2</span> Drive from <b style="color:#22c55e">A</b> to <b style="color:#ef4444">B</b></li>' +
        '    <li><span class="cg-step-num">3</span> Click the <b>Go</b> button</li>' +
        '    <li><span class="cg-step-num">4</span> Drive from <b style="color:#ef4444">B</b> to <b style="color:#22c55e">A</b></li>' +
        '    <li><span class="cg-step-num">&#8634;</span> Repeat&hellip;</li>' +
        '  </ol>' +
        '  <div class="cg-coords">' +
        '    <div class="cg-coord-row">' +
        '      <span class="cg-coord-label cg-a">A</span>' +
        '      <span class="cg-coord-text" id="cg-coord-a">Not set</span>' +
        '      <button class="cg-pick-btn" id="cg-pick-a" onclick="clickGoPick(\'A\')">Pick on map</button>' +
        '    </div>' +
        '    <div class="cg-coord-row">' +
        '      <span class="cg-coord-label cg-b">B</span>' +
        '      <span class="cg-coord-text" id="cg-coord-b">Not set</span>' +
        '      <button class="cg-pick-btn" id="cg-pick-b" onclick="clickGoPick(\'B\')">Pick on map</button>' +
        '    </div>' +
        '  </div>' +
        '</div>' +
        '<div class="cg-actions">' +
        '  <button class="cg-btn cg-btn-cancel" onclick="closeClickGoPanel()">Cancel</button>' +
        '  <button class="cg-btn cg-btn-confirm" id="cg-confirm-btn" onclick="confirmClickGo()" disabled>Confirm</button>' +
        '</div>';
    document.body.appendChild(panel);
}

function makeClickGoPanelDraggable() {
    var panel = document.getElementById('clickgo-panel');
    var header = panel ? panel.querySelector('.cg-header') : null;
    if (!panel || !header || panel._dragInit) return;
    panel._dragInit = true;
    var startX, startY, startLeft, startTop;
    header.addEventListener('mousedown', function(e) {
        if (e.target.closest('.cg-close')) return; // don't drag on close btn
        e.preventDefault();
        var rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        // Reset any centering transform so top/left work correctly
        panel.style.transform = 'none';
        panel.style.left = startLeft + 'px';
        panel.style.top = startTop + 'px';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        panel.style.left = (startLeft + dx) + 'px';
        panel.style.top = (startTop + dy) + 'px';
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }
}

function openClickGoPanel() {
    if (!map) {
        showNotification('Initialize the map first.', 'error');
        return;
    }
    buildClickGoPanel();
    makeClickGoPanelDraggable();
    // Reset state
    clearClickGoMarkers();
    clickGoState.pointA = null;
    clickGoState.pointB = null;
    clickGoState.picking = null;
    clickGoState.active = true;
    updateClickGoUI();
    document.getElementById('clickgo-overlay').style.display = 'block';
    document.getElementById('clickgo-panel').style.display = 'block';
}

function closeClickGoPanel() {
    var overlay = document.getElementById('clickgo-overlay');
    var panel = document.getElementById('clickgo-panel');
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.display = 'none';
    clickGoState.active = false;
    clickGoState.picking = null;
    clearClickGoMarkers();
}

function clearClickGoMarkers() {
    if (!map) { clickGoState.markerA = null; clickGoState.markerB = null; clickGoState.line = null; return; }
    if (clickGoState.markerA) { map.removeLayer(clickGoState.markerA); clickGoState.markerA = null; }
    if (clickGoState.markerB) { map.removeLayer(clickGoState.markerB); clickGoState.markerB = null; }
    if (clickGoState.line) { map.removeLayer(clickGoState.line); clickGoState.line = null; }
}

function clickGoPick(which) {
    clickGoState.picking = which;
    // Minimise panel while picking
    document.getElementById('clickgo-panel').style.opacity = '0.35';
    document.getElementById('clickgo-panel').style.pointerEvents = 'none';
    showNotification('Click on the map to set point ' + which + '.', 'info');
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', function(e) {
        handleClickGoPick(e.latlng, which);
    });
    updatePickBtnStyle();
}

function handleClickGoPick(latlng, which) {
    map.getContainer().style.cursor = '';
    if (which === 'A') {
        clickGoState.pointA = { lat: latlng.lat, lng: latlng.lng };
    } else {
        clickGoState.pointB = { lat: latlng.lat, lng: latlng.lng };
    }
    clickGoState.picking = null;
    document.getElementById('clickgo-panel').style.opacity = '1';
    document.getElementById('clickgo-panel').style.pointerEvents = 'auto';
    drawClickGoMarkers();
    updateClickGoUI();
}

function makeClickGoIcon(label, color) {
    return L.divIcon({
        className: 'ab-point-marker',
        html: '<div style="width:32px;height:32px;border-radius:50%;background:' + color + ';display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.5);">' + label + '</div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
}

function drawClickGoMarkers() {
    // Remove old
    if (clickGoState.markerA) { map.removeLayer(clickGoState.markerA); clickGoState.markerA = null; }
    if (clickGoState.markerB) { map.removeLayer(clickGoState.markerB); clickGoState.markerB = null; }
    if (clickGoState.line) { map.removeLayer(clickGoState.line); clickGoState.line = null; }

    if (clickGoState.pointA) {
        clickGoState.markerA = L.marker([clickGoState.pointA.lat, clickGoState.pointA.lng], {
            icon: makeClickGoIcon('A', '#22c55e'),
            draggable: true,
            zIndexOffset: 5000
        }).addTo(map);
        clickGoState.markerA.on('drag', function() {
            var pos = clickGoState.markerA.getLatLng();
            clickGoState.pointA = { lat: pos.lat, lng: pos.lng };
            drawClickGoLine();
        });
        clickGoState.markerA.on('dragend', function() {
            var pos = clickGoState.markerA.getLatLng();
            clickGoState.pointA = { lat: pos.lat, lng: pos.lng };
            drawClickGoLine();
            updateClickGoUI();
        });
    }

    if (clickGoState.pointB) {
        clickGoState.markerB = L.marker([clickGoState.pointB.lat, clickGoState.pointB.lng], {
            icon: makeClickGoIcon('B', '#ef4444'),
            draggable: true,
            zIndexOffset: 5000
        }).addTo(map);
        clickGoState.markerB.on('drag', function() {
            var pos = clickGoState.markerB.getLatLng();
            clickGoState.pointB = { lat: pos.lat, lng: pos.lng };
            drawClickGoLine();
        });
        clickGoState.markerB.on('dragend', function() {
            var pos = clickGoState.markerB.getLatLng();
            clickGoState.pointB = { lat: pos.lat, lng: pos.lng };
            drawClickGoLine();
            updateClickGoUI();
        });
    }

    drawClickGoLine();
}

function drawClickGoLine() {
    if (clickGoState.line) { map.removeLayer(clickGoState.line); clickGoState.line = null; }
    if (clickGoState.pointA && clickGoState.pointB) {
        clickGoState.line = L.polyline(
            [[clickGoState.pointA.lat, clickGoState.pointA.lng], [clickGoState.pointB.lat, clickGoState.pointB.lng]],
            { color: '#60a5fa', weight: 4, dashArray: '10 6', opacity: 0.85 }
        ).addTo(map);
    }
}

function updateClickGoUI() {
    var coordA = document.getElementById('cg-coord-a');
    var coordB = document.getElementById('cg-coord-b');
    var confirmBtn = document.getElementById('cg-confirm-btn');
    if (coordA) coordA.textContent = clickGoState.pointA
        ? clickGoState.pointA.lat.toFixed(7) + ', ' + clickGoState.pointA.lng.toFixed(7)
        : 'Not set';
    if (coordB) coordB.textContent = clickGoState.pointB
        ? clickGoState.pointB.lat.toFixed(7) + ', ' + clickGoState.pointB.lng.toFixed(7)
        : 'Not set';
    if (confirmBtn) confirmBtn.disabled = !(clickGoState.pointA && clickGoState.pointB);
    updatePickBtnStyle();
}

function updatePickBtnStyle() {
    var btnA = document.getElementById('cg-pick-a');
    var btnB = document.getElementById('cg-pick-b');
    if (btnA) {
        btnA.className = 'cg-pick-btn' + (clickGoState.picking === 'A' ? ' picking' : '');
        btnA.textContent = clickGoState.picking === 'A' ? 'Picking…' : (clickGoState.pointA ? 'Re-pick' : 'Pick on map');
    }
    if (btnB) {
        btnB.className = 'cg-pick-btn' + (clickGoState.picking === 'B' ? ' picking' : '');
        btnB.textContent = clickGoState.picking === 'B' ? 'Picking…' : (clickGoState.pointB ? 'Re-pick' : 'Pick on map');
    }
}

function confirmClickGo() {
    if (!clickGoState.pointA || !clickGoState.pointB) return;

    var A = clickGoState.pointA;
    var B = clickGoState.pointB;

    // Store A/B in their own persistent storage (not waypoints)
    clickGoState.confirmedA = { lat: A.lat, lng: A.lng };
    clickGoState.confirmedB = { lat: B.lat, lng: B.lng };

    // Close the setup panel (keep markers on map for reference)
    var overlay = document.getElementById('clickgo-overlay');
    var panel = document.getElementById('clickgo-panel');
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.display = 'none';
    clickGoState.active = false;

    // Show mission preview with BT XML
    showClickGoMissionPreview(A, B);
}

// ── Click & Go Mission Preview + BT XML Export ──

function showClickGoMissionPreview(A, B) {
    // Build or reuse the preview panel
    buildClickGoMissionPreview();
    makeMissionPreviewDraggable();

    function fmt(n) { return Number(n).toFixed(12); }

    // ── Build the mission step list ──
    var stepsHtml =
        '<li><span class="cg-step-num">1</span> <b>Wait</b> for kick button press</li>' +
        '<li><span class="cg-step-num">2</span> Drive from <b style="color:#22c55e">A</b> (' + A.lat.toFixed(6) + ', ' + A.lng.toFixed(6) + ') → <b style="color:#ef4444">B</b> (' + B.lat.toFixed(6) + ', ' + B.lng.toFixed(6) + ')</li>' +
        '<li><span class="cg-step-num">3</span> <b>Wait</b> for kick button press</li>' +
        '<li><span class="cg-step-num">4</span> Drive from <b style="color:#ef4444">B</b> → <b style="color:#22c55e">A</b></li>' +
        '<li><span class="cg-step-num cg-repeat">&#8634;</span> Repeat forever</li>';
    document.getElementById('cg-preview-steps').innerHTML = stepsHtml;

    // ── Build BT XML ──
    var lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<root BTCPP_format="4"');
    lines.push('  main_tree_to_execute="RootTree">');
    lines.push('  <BehaviorTree ID="RootTree">');
    lines.push('    <ReactiveSequence>');
    lines.push('      <Fallback>');
    lines.push('        <ReadPanel light="{lightStatus}"');
    lines.push('                   button="{buttonStatus}"');
    lines.push('                   potentiometer="{potentiometerStatus}"');
    lines.push('                   notaus="{notausStatus}"');
    lines.push('                   button_duration="{buttonDuration}"/>');
    lines.push('        <ForceFailure>');
    lines.push('          <ManualMode light="{lightStatus}"/>');
    lines.push('        </ForceFailure>');
    lines.push('      </Fallback>');
    lines.push('');
    lines.push('      <Fallback>');
    lines.push('        <SubTree ID="isSensorOk"');
    lines.push('                 _autoremap="true"/>');
    lines.push('        <Inverter>');
    lines.push('          <ForceManualMode button="{buttonStatus}"/>');
    lines.push('        </Inverter>');
    lines.push('      </Fallback>');
    lines.push('');
    lines.push('      <Fallback>');
    lines.push('        <IsRTKOK topic_name="/gpsfix" delay_sec="1"/>');
    lines.push('        <Inverter>');
    lines.push('          <ForceManualMode button="{buttonStatus}"/>');
    lines.push('        </Inverter>');
    lines.push('      </Fallback>');
    lines.push('');
    lines.push('      <Fallback>');
    lines.push('        <IsStopRequested topic_name="/stop_requested" invert="false"/>');
    lines.push('        <Inverter>');
    lines.push('          <ForceManualMode button="{buttonStatus}"/>');
    lines.push('        </Inverter>');
    lines.push('      </Fallback>');
    lines.push('');
    lines.push('      <!-- Click & Go shuttle loop -->');
    lines.push('      <ReactiveSequence>');
    lines.push('        <SequenceWithMemory>');
    lines.push('');
    // Step 1: Wait for button, then go A→B
    lines.push('          <!-- Wait for kick button then drive A → B -->');
    lines.push('          <WaitForTrigger topic_name="/roboteq/kick_button"/>');
    lines.push('          <ConvertGnssPointsToLocal');
    lines.push('            gnss_points="' + fmt(A.lat) + ', ' + fmt(A.lng) + ',0.0;');
    lines.push('                         ' + fmt(B.lat) + ', ' + fmt(B.lng) + ',0.0"');
    lines.push('            last_qx="0.0" last_qy="0.0" last_qz="0.0" last_qw="1.0"');
    lines.push('            poses="{poses_ab}" />');
    lines.push('          <GoThrough poses="{poses_ab}"/>');
    lines.push('');
    // Step 2: Wait for button, then go B→A
    lines.push('          <!-- Wait for kick button then drive B → A -->');
    lines.push('          <WaitForTrigger topic_name="/roboteq/kick_button"/>');
    lines.push('          <ConvertGnssPointsToLocal');
    lines.push('            gnss_points="' + fmt(B.lat) + ', ' + fmt(B.lng) + ',0.0;');
    lines.push('                         ' + fmt(A.lat) + ', ' + fmt(A.lng) + ',0.0"');
    lines.push('            last_qx="0.0" last_qy="0.0" last_qz="0.0" last_qw="1.0"');
    lines.push('            poses="{poses_ba}" />');
    lines.push('          <GoThrough poses="{poses_ba}"/>');
    lines.push('');
    lines.push('          <ForceManualMode button="{buttonStatus}"/>');
    lines.push('        </SequenceWithMemory>');
    lines.push('      </ReactiveSequence>');
    lines.push('');
    lines.push('    </ReactiveSequence>');
    lines.push('  </BehaviorTree>');
    lines.push('');
    lines.push('  <BehaviorTree ID="initialization">');
    lines.push('    <Sequence>');
    lines.push('      <RetryUntilSuccessful num_attempts="-1">');
    lines.push('        <Sequence>');
    lines.push('          <SetLightMode light="51"/>');
    lines.push('          <SubTree ID="isSensorOk" _autoremap="true"/>');
    lines.push('          <Delay delay_msec="100">');
    lines.push('            <ForceManualMode button="{buttonStatus}"/>');
    lines.push('          </Delay>');
    lines.push('          <Inverter>');
    lines.push('            <ReadPanel light="{lightStatus}"');
    lines.push('                       button="{buttonStatus}"');
    lines.push('                       potentiometer="{potentiometerStatus}"');
    lines.push('                       notaus="{notausStatus}"');
    lines.push('                       button_duration="{buttonDuration}"/>');
    lines.push('          </Inverter>');
    lines.push('        </Sequence>');
    lines.push('      </RetryUntilSuccessful>');
    lines.push('      <Fallback>');
    lines.push('        <RetryUntilSuccessful num_attempts="5">');
    lines.push('          <Inverter>');
    lines.push('            <SetLightMode light="52"/>');
    lines.push('          </Inverter>');
    lines.push('        </RetryUntilSuccessful>');
    lines.push('        <AlwaysSuccess/>');
    lines.push('      </Fallback>');
    lines.push('    </Sequence>');
    lines.push('  </BehaviorTree>');
    lines.push('  <BehaviorTree ID="isSensorOk">');
    lines.push('    <Sequence>');
    lines.push('      <IsLidarOk topic_name="/valera/front/lidar"/>');
    lines.push('    </Sequence>');
    lines.push('  </BehaviorTree>');
    lines.push('  <TreeNodesModel>');
    lines.push('    <Action ID="WaitForTrigger" editable="true">');
    lines.push('      <input_port name="topic_name" default="/roboteq/kick_button"/>');
    lines.push('    </Action>');
    lines.push('    <Action ID="ForceManualMode" editable="true">');
    lines.push('      <input_port name="button" default="{buttonStatus}"/>');
    lines.push('    </Action>');
    lines.push('    <Condition ID="IsLidarOk" editable="true"/>');
    lines.push('    <Action ID="ManualMode" editable="true">');
    lines.push('      <input_port name="light"/>');
    lines.push('    </Action>');
    lines.push('    <Action ID="ReadPanel" editable="true">');
    lines.push('      <output_port name="light"/>');
    lines.push('      <output_port name="button"/>');
    lines.push('      <output_port name="potentiometer"/>');
    lines.push('      <output_port name="notaus"/>');
    lines.push('      <output_port name="button_duration"/>');
    lines.push('    </Action>');
    lines.push('    <Action ID="SetLightMode" editable="true">');
    lines.push('      <input_port name="light" default="52"/>');
    lines.push('    </Action>');
    lines.push('  </TreeNodesModel>');
    lines.push('</root>');

    var xml = lines.join('\n');

    // Escape for HTML display
    var xmlDisplay = xml.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    document.getElementById('cg-xml-preview').textContent = xml;

    // Store XML for export
    clickGoState._lastXml = xml;

    // Show preview
    document.getElementById('cg-preview-overlay').style.display = 'block';
    document.getElementById('clickgo-mission-preview').style.display = 'block';
}

function makeMissionPreviewDraggable() {
    var panel = document.getElementById('clickgo-mission-preview');
    var header = panel ? panel.querySelector('.cg-header') : null;
    if (!panel || !header || panel._dragInit) return;
    panel._dragInit = true;
    var startX, startY, startLeft, startTop;
    header.addEventListener('mousedown', function(e) {
        if (e.target.closest('.cg-close')) return;
        e.preventDefault();
        var rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        panel.style.transform = 'none';
        panel.style.left = startLeft + 'px';
        panel.style.top = startTop + 'px';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        panel.style.left = (startLeft + dx) + 'px';
        panel.style.top = (startTop + dy) + 'px';
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }
}

function buildClickGoMissionPreview() {
    if (document.getElementById('clickgo-mission-preview')) return;

    var overlay = document.createElement('div');
    overlay.id = 'cg-preview-overlay';
    overlay.onclick = closeClickGoMissionPreview;
    document.body.appendChild(overlay);

    var panel = document.createElement('div');
    panel.id = 'clickgo-mission-preview';
    panel.innerHTML =
        '<div class="cg-header">' +
        '  <h3><i class="fas fa-clipboard-list" style="margin-right:8px;color:#60a5fa;"></i>Mission Plan</h3>' +
        '  <button class="cg-close" onclick="closeClickGoMissionPreview()">&times;</button>' +
        '</div>' +
        '<div id="cg-preview-body">' +
        '  <div style="font-size:13px;color:#9ca3af;margin-bottom:10px;">Click &amp; Go shuttle mission — the robot repeats this cycle:</div>' +
        '  <ol class="cg-preview-steps" id="cg-preview-steps"></ol>' +
        '  <div style="font-size:13px;color:#9ca3af;margin-top:14px;margin-bottom:4px;"><i class="fas fa-code" style="margin-right:6px;"></i>Behavior Tree XML:</div>' +
        '  <pre id="cg-xml-preview"></pre>' +
        '</div>' +
        '<div class="cg-actions">' +
        '  <button class="cg-btn cg-btn-cancel" onclick="closeClickGoMissionPreview()">Close</button>' +
        '  <button class="cg-btn cg-btn-confirm" id="cg-export-btn" onclick="exportClickGoMission()"><i class="fas fa-upload" style="margin-right:6px;"></i>Export to Device</button>' +
        '</div>';
    document.body.appendChild(panel);
}

function closeClickGoMissionPreview() {
    var overlay = document.getElementById('cg-preview-overlay');
    var panel = document.getElementById('clickgo-mission-preview');
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.display = 'none';
}

async function exportClickGoMission() {
    if (!clickGoState._lastXml) {
        showNotification('No mission XML to export.', 'error');
        return;
    }
    if (!token) {
        showNotification('Token not available. Please log in first.', 'error');
        return;
    }
    var exportBtn = document.getElementById('cg-export-btn');
    var _origCgBtnHtml = exportBtn ? exportBtn.innerHTML : null;
    if (exportBtn) { exportBtn.disabled = true; exportBtn.textContent = 'Exporting…'; }
    var _cgSuccess = null;

    try {
        var resp = await fetch(`https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ missionXml: clickGoState._lastXml })
        });
        if (resp.ok) {
            showNotification('Click & Go mission exported — syncing with robot...', 'success');
            // Sync mission to robot via RPC
            _cgSuccess = await sendNavRpc('syncPlan', 'Sync mission') === true;
        } else {
            console.error('Failed to push Click&Go mission XML:', await resp.text());
            showNotification('Failed to export mission XML.', 'error');
            _cgSuccess = false;
        }
    } catch (err) {
        console.error('Error exporting Click&Go mission XML:', err);
        showNotification('Error exporting mission XML.', 'error');
        _cgSuccess = false;
    }
    if (exportBtn) {
        if (_cgSuccess === true) {
            exportBtn.innerHTML = '<i class="fas fa-check" style="color:#4ade80;"></i><span>Done</span>';
            setTimeout(function() { closeClickGoMissionPreview(); }, 1500);
        } else if (_cgSuccess === false) {
            exportBtn.innerHTML = '<i class="fas fa-times" style="color:#f87171;"></i><span>Failed</span>';
            setTimeout(function() { exportBtn.disabled = false; exportBtn.innerHTML = _origCgBtnHtml; }, 1500);
        } else {
            exportBtn.disabled = false;
            exportBtn.innerHTML = _origCgBtnHtml;
        }
    }
}

// ─── WIDGET DESTROY / CLEANUP ────────────────────────────────
function destroyGpsMapWidget() {
    // Guard: only prevent double-destroy of the SAME instance.
    // Do NOT use isAlive() here — when a new instance takes over and
    // changes __gpsWidgetInstanceId, isAlive() returns false which
    // would skip all cleanup, leaving intervals and listeners running.
    if (widgetDestroyed) return;
    widgetDestroyed = true;

    console.log('[GPS Widget] Destroying instance ' + _instanceId);

    // Clear all polling intervals
    widgetIntervals.forEach(function(id) { clearInterval(id); });
    widgetIntervals.length = 0;

    // Remove all tracked window/document event listeners
    _eventListeners.forEach(function(entry) {
        try { entry.target.removeEventListener(entry.event, entry.handler); } catch(e) {}
    });
    _eventListeners.length = 0;

    // Close Click & Go panels
    try { closeClickGoPanel(); } catch(e) {}
    try { closeClickGoMissionPreview(); } catch(e) {}

    // Remove robot trail markers
    if (window.robotTrailMarkers) {
        window.robotTrailMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e) {} });
        window.robotTrailMarkers = [];
    }
    if (robotTrailLayer) {
        try { map.removeLayer(robotTrailLayer); } catch(e) {}
        robotTrailLayer = null;
    }
    if (robotTrailOutlineLayer) {
        try { map.removeLayer(robotTrailOutlineLayer); } catch(e) {}
        robotTrailOutlineLayer = null;
    }
    if (robotPathOutlineLayer) {
        try { map.removeLayer(robotPathOutlineLayer); } catch(e) {}
        robotPathOutlineLayer = null;
    }
    clearHistoricalPath();
    if (window.obstacleMarker && map) {
        try { map.removeLayer(window.obstacleMarker); } catch(e) {}
        window.obstacleMarker = null;
    }

    // Reset AB state
    if (map) { try { resetABState(); } catch(e) {} }

    // Remove all map layers
    if (map) {
        markers.forEach(function(m) { try { map.removeLayer(m); } catch(e) {} });
        highlightmarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e) {} });
        inclusionZones.forEach(function(z) { try { map.removeLayer(z); } catch(e) {} });
        exclusionZones.forEach(function(z) { try { map.removeLayer(z); } catch(e) {} });
        cornerMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e) {} });
        midpointMarkers.forEach(function(m) { try { map.removeLayer(m); } catch(e) {} });
        if (polyline) { try { map.removeLayer(polyline); } catch(e) {} }
        if (boundingPolygon) { try { map.removeLayer(boundingPolygon); } catch(e) {} }
        if (shadowPolygon) { try { map.removeLayer(shadowPolygon); } catch(e) {} }
        if (robotMarker) { try { map.removeLayer(robotMarker); } catch(e) {} }
    }

    // Destroy the Leaflet map
    if (map) { try { map.remove(); } catch(e) {} }
    map = null;

    // Disconnect DOM removal observer
    if (_gpsMapDomObserver) _gpsMapDomObserver.disconnect();

    // Clear global references
    window.__gpsMapWidgetDestroy = null;
    if (window.__gpsWidgetInstanceId === _instanceId) {
        window.__gpsWidgetInstanceId = null;
    }
    window.__gpsWidgetIntervalIds = null;
    window.__gpsWidgetEventListeners = null;
    // Clean up localStorage instance slot so the next instance
    // does not leave a stale entry when this frame is destroyed.
    try {
        if (localStorage.getItem(_lcStorageKey) === _instanceId) {
            localStorage.removeItem(_lcStorageKey);
        }
    } catch(e) {}
}

// Store globally so the next widget instance can call it
window.__gpsMapWidgetDestroy = destroyGpsMapWidget;

// Destroy on iframe unload: fires when ThingsBoard removes this iframe
// to switch to a different device dashboard, preventing stale intervals
// from the old device continuing to update the new widget's DOM.
addTrackedListener(window, 'pagehide', destroyGpsMapWidget);
addTrackedListener(window, 'beforeunload', destroyGpsMapWidget);
addTrackedListener(window, 'unload', destroyGpsMapWidget);

// Also detect if our map container is removed from the DOM (fallback)
var _gpsMapDomObserver = null;
var _gpsMapContainer = document.getElementById('map');
if (_gpsMapContainer && _gpsMapContainer.parentNode) {
    _gpsMapDomObserver = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
            for (var j = 0; j < mutations[i].removedNodes.length; j++) {
                if (mutations[i].removedNodes[j] === _gpsMapContainer ||
                    (mutations[i].removedNodes[j].contains && mutations[i].removedNodes[j].contains(_gpsMapContainer))) {
                    destroyGpsMapWidget();
                    return;
                }
            }
        }
    });
    _gpsMapDomObserver.observe(_gpsMapContainer.parentNode, { childList: true, subtree: true });
}

// ─── DEVICE CHANGE / INSTANCE STALENESS DETECTION ───────────
// If ThingsBoard re-renders the widget with a new deviceID (without
// a full page reload), the new IIFE sets a new __gpsWidgetInstanceId.
// This interval detects when *this* instance is no longer the active
// one and auto-destroys itself — the definitive fix for "two devices
// running at the same time" after a device switch.
widgetIntervals.push(setInterval(function() {
    if (window.__gpsWidgetInstanceId !== _instanceId) {
        console.warn('[GPS Widget] Instance ' + _instanceId + ' is stale (window). Destroying.');
        destroyGpsMapWidget();
        return;
    }
    // Cross-frame: if storage event was missed (frame suspended/frozen),
    // the polling fallback catches a newer instance registered in localStorage.
    try {
        var _si = localStorage.getItem(_lcStorageKey);
        if (_si && _si !== _instanceId) {
            console.warn('[GPS Widget] Instance ' + _instanceId + ' is stale (localStorage: ' + _si + '). Destroying.');
            destroyGpsMapWidget();
            return;
        }
    } catch(e) {}
    // Also detect device change when ThingsBoard re-renders the HTML
    // template (updating data-device-id) without re-executing the script.
    var container = document.getElementById('gps-container');
    if (container) {
        var domDeviceId = container.getAttribute('data-device-id');
        if (domDeviceId && domDeviceId !== _widgetDeviceId) {
            console.warn('[GPS Widget] Device changed in DOM (' + domDeviceId + ' vs ' + _widgetDeviceId + '). Destroying stale instance.');
            destroyGpsMapWidget();
        }
    }
}, 1000));

// Also auto-destroy when the page becomes hidden (ThingsBoard SPA
// navigation) and a different instance has taken over by the time
// the page becomes visible again.
addTrackedListener(document, 'visibilitychange', function() {
    if (document.hidden) return;
    // Page became visible — check window AND localStorage (cross-frame)
    if (!isAlive()) destroyGpsMapWidget();
});

// Additional events for the app (WebView) which may not fire visibilitychange
addTrackedListener(window, 'focus', function() {
    if (!isAlive()) destroyGpsMapWidget();
});
addTrackedListener(window, 'pageshow', function() {
    if (!isAlive()) destroyGpsMapWidget();
});

// ─── PATHS PANEL TOGGLE ──────────────────────────────────
var pathsToggleBtn = document.getElementById('paths-toggle-btn');
var pathsPanel = document.getElementById('paths-container');
if (pathsToggleBtn && pathsPanel) {
    pathsPanel.classList.add('collapsed');
    pathsToggleBtn.addEventListener('click', function() {
        var isCollapsed = pathsPanel.classList.toggle('collapsed');
        pathsToggleBtn.classList.toggle('panel-open', !isCollapsed);
    });
}

// ─── COLLAPSIBLE LIST SECTIONS ──────────────────────────
// Toggle handled via inline onclick on each h3.list-toggle

// ─── RESPONSIVE: watch actual container size, apply classes ──
(function() {
    var c = document.getElementById('gps-container');
    if (!c || typeof ResizeObserver === 'undefined') return;
    function apply() {
        var w = c.offsetWidth, h = c.offsetHeight;
        c.classList.remove('bp-laptop', 'bp-tablet', 'bp-mobile', 'bp-short');
        if (w <= 599)       c.classList.add('bp-mobile');
        else if (w <= 959)  c.classList.add('bp-tablet');
        else if (w <= 1279) c.classList.add('bp-laptop');
        if (h <= 880)       c.classList.add('bp-short');
        // Tell Leaflet the container size changed so it redraws tiles/paths correctly
        if (map) map.invalidateSize({ animate: false });
    }
    new ResizeObserver(apply).observe(c);
    apply();
})();

// ─── FOCUS MODE ──────────────────────────────────────────
window._focusMode = false;
function toggleFocusMode() {
    window._focusMode = !window._focusMode;
    var btn = document.getElementById('focus-mode-btn');
    if (btn) btn.classList.toggle('active', window._focusMode);
}

// ─── LOCK MODE ───────────────────────────────────────────
function toggleLockMode() {
    lockMode = !lockMode;
    var btn = document.getElementById('lock-mode-btn');
    if (btn) {
        btn.classList.toggle('lock-active', lockMode);
        var icon = btn.querySelector('i');
        if (icon) icon.className = lockMode ? 'fas fa-lock' : 'fas fa-lock-open';
    }
    showNotification(lockMode ? 'Widget locked — editing disabled.' : 'Widget unlocked — editing enabled.', 'info');
}

function applyNavigationMode(mode) {
    var prevMode = navigationMode;
    navigationMode = mode;
    var isRowFollow = mode === 'row-follow';

    // Segmented control highlight
    var optGps = document.getElementById('nav-mode-opt-gps');
    var optRow = document.getElementById('nav-mode-opt-row');
    if (optGps) optGps.className = 'nav-mode-opt' + (!isRowFollow ? ' nav-mode-opt-active-gps' : '');
    if (optRow) optRow.className = 'nav-mode-opt' + (isRowFollow ? ' nav-mode-opt-active-row' : '');

    // Export button label
    var exportBtn = document.getElementById('bottom-export-btn');
    if (exportBtn) {
        var span = exportBtn.querySelector('span');
        if (span) span.textContent = isRowFollow ? 'Export Row Following Mission' : 'Export GPS Mission';
    }

    // Sidebar: hide editing groups when in row-follow mode
    var sidebar = document.getElementById('left-sidebar');
    if (sidebar) sidebar.classList.toggle('row-follow-mode', isRowFollow);

    // Map visibility: only act when map is initialized
    if (typeof map === 'undefined' || !map) return;

    if (isRowFollow) {
        // Hide waypoint markers (index 1+ are real markers)
        markers.slice(1).forEach(function(m) { try { map.removeLayer(m); } catch(e) {} });
        // Hide path layers (updatePath clears them already; call it to clear any current path)
        updatePath();
        // Hide zone polygons
        inclusionZones.forEach(function(z) { try { map.removeLayer(z); } catch(e) {} });
        exclusionZones.forEach(function(z) { try { map.removeLayer(z); } catch(e) {} });
    } else {
        // Restore waypoint markers
        markers.slice(1).forEach(function(m) { try { m.addTo(map); } catch(e) {} });
        // Restore path drawing
        updatePath();
        // Restore zone polygons
        inclusionZones.forEach(function(z) { try { z.addTo(map); } catch(e) {} });
        exclusionZones.forEach(function(z) { try { z.addTo(map); } catch(e) {} });
    }
}

async function setNavigationMode(mode) {
    if (mode === navigationMode) return;
    applyNavigationMode(mode);
    showNotification(mode === 'row-follow' ? 'Mode: Pure Row Following' : 'Mode: GPS Navigation', 'info');
    if (!token) return;
    try {
        await fetch(`https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/SHARED_SCOPE`, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Authorization': 'Bearer ' + token },
            body: JSON.stringify({ nav_mode: mode })
        });
    } catch (e) { console.error('Failed to save nav_mode:', e); }
}

async function loadNavigationMode() {
    if (!token) return;
    try {
        const r = await fetch(`https://dashboard.antrobotics.de/api/plugins/telemetry/DEVICE/${deviceID}/values/attributes/SHARED_SCOPE?keys=nav_mode`, {
            headers: { 'Accept': 'application/json', 'X-Authorization': 'Bearer ' + token }
        });
        if (r.ok) {
            const data = await r.json();
            if (data && data[0] && data[0].value) applyNavigationMode(data[0].value);
        }
    } catch (e) { console.error('Failed to load nav_mode:', e); }
}


// Expose functions as globals so HTML onclick="functionName()" attributes work
window.initializeMap = initializeMap;
window.setMode = setMode;
window.toggleFocusMode = toggleFocusMode;
window.toggleLockMode = toggleLockMode;
window.setNavigationMode = setNavigationMode;
window.undoLastWaypoint = undoLastWaypoint;
window.clearAllWaypoints = clearAllWaypoints;
window.reversePath = reversePath;
window.saveRoute = saveRoute;
window.loadRoute = loadRoute;
window.addWaypointFromRobot = addWaypointFromRobot;
window.startABLines = startABLines;
window.generateABPath = generateABPath;
window.addABUTurns = addABUTurns;
window.saveIndividualABLine = saveIndividualABLine;
window.openClickGoPanel = openClickGoPanel;
window.closeClickGoPanel = closeClickGoPanel;
window.clickGoPick = clickGoPick;
window.confirmClickGo = confirmClickGo;
window.closeClickGoMissionPreview = closeClickGoMissionPreview;
window.exportClickGoMission = exportClickGoMission;
window.openPathHistoryPanel = openPathHistoryPanel;
window.closePathHistoryPanel = closePathHistoryPanel;
window.loadPathHistory = loadPathHistory;
window.clearHistoricalPath = clearHistoricalPath;

export default {
    initializeMap,
    setMode,
    toggleFocusMode,
    toggleLockMode,
    setNavigationMode,
    undoLastWaypoint,
    clearAllWaypoints,
    reversePath,
    saveRoute,
    loadRoute,
    addWaypointFromRobot,
    startABLines,
    generateABPath,
    addABUTurns,
    saveIndividualABLine,
    openClickGoPanel,
    closeClickGoPanel,
    clickGoPick,
    confirmClickGo,
    closeClickGoMissionPreview,
    exportClickGoMission,
    openPathHistoryPanel,
    closePathHistoryPanel,
    loadPathHistory,
    clearHistoricalPath,
};
