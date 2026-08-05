/**
 * STANDALONE Facilio booking form — plain JavaScript build (NO JSX, NO bundler), so the file
 * itself is uploadable where only css/html/jpeg/jpg/js/json/png/svg/txt/pdf are allowed.
 *
 * Requires the React + ReactDOM UMD globals (see index.html). Talks to the host org only
 * through the FacilioAppSDK bridge (auto-loaded from the Facilio CDN).
 *
 * Rules (kept in sync with the floorplan app's booking modal BY HAND):
 *  - Org form auto-picked by LINK NAME per resource type (desk/space/parking form).
 *  - ONLY rooms book slots (HARDCODED 2h), same-day only. Desks/parking/lockers: no slots —
 *    start/end selects, up to one week ahead.
 *  - Today's already-started slots/start times are rejected client-side.
 *  - Create goes to `spacebooking` with the right resource lookup field and parentModuleId.
 *
 * Usage:  FacilioBookingForms.mount(document.getElementById('root'), {
 *           unitType: 'room', resourceId: 123, resourceLabel: 'E-1-CO11',
 *           onDone: function (id) {}, onCancel: function () {}
 *         });
 */
(function (global) {
  'use strict';

  var SDK_URL = 'https://static.facilio.com/apps-sdk/beta/facilio_apps_sdk.min.js';
  var SDK_TIMEOUT = 20000;
  var ROOM_SLOT_MINUTES = 120;

  var sdkReady = null;
  function facilioAppReady() {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('FacilioAppSDK never fired app.loaded')); }
      }, SDK_TIMEOUT);
      function settle(app) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(app); }
      }
      function fail(err) {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      }
      function start() {
        try {
          // init() shape varies across SDK builds: emitter app, plain ready app (no .on —
          // crashed live), or a Promise of either.
          Promise.resolve(global.FacilioAppSDK.init()).then(function (app) {
            global.facilioApp = app;
            if (!app) return fail(new Error('FacilioAppSDK.init() returned nothing'));
            if (typeof app.on === 'function') {
              app.on('app.loaded', function () { settle(app); });
              setTimeout(function () { if (!settled && app.api && app.request) settle(app); }, 2500);
            } else {
              settle(app);
            }
          }).catch(fail);
        } catch (err) {
          fail(err);
        }
      }
      if (global.FacilioAppSDK) { start(); return; }
      var script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = start;
      script.onerror = function () {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('failed to load FacilioAppSDK')); }
      };
      document.head.appendChild(script);
    });
    return sdkReady;
  }

  function qs(params) {
    if (!params) return '';
    var parts = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function customGet(path, params) {
    return facilioAppReady().then(function (app) {
      return app.request.invokeFacilioAPI(path + qs(params), { method: 'GET' });
    }).then(function (raw) {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });
  }
  function fetchAll(moduleName, params) {
    return facilioAppReady().then(function (app) { return app.api.fetchAll(moduleName, params || {}); });
  }
  function createRecord(moduleName, params) {
    return facilioAppReady().then(function (app) { return app.api.createRecord(moduleName, params); });
  }

  // ---- org form, picked by LINK NAME -------------------------------------
  var FORM_PREFS = {
    workstation: [/desk/i],
    parking: [/parking/i],
    room: [/^space_/i, /spacebooking/i],
    default: [/default_spacebooking/i, /spacebooking/i],
  };

  function fetchBookingForm(unitType) {
    return customGet('v2/spacebooking/forms', { moduleName: 'spacebooking', skipPermission: true }).catch(function () { return null; })
      .then(function (listBody) {
        var forms = ((listBody && listBody.result && listBody.result.forms) || []).filter(function (f) { return !f.hideInList; });
        if (!forms.length) return null;
        var patterns = (FORM_PREFS[unitType] || []).concat(FORM_PREFS.default);
        var chosen = null;
        for (var i = 0; i < patterns.length && !chosen; i++) {
          chosen = forms.find(function (f) { return patterns[i].test(f.name || ''); }) || null;
        }
        if (!chosen) {
          // Type-aware last resort — never hand another type's form over (rooms were landing
          // on the desk form when no link-name pattern matched).
          var avoid = unitType === 'room' ? /desk|parking|hot/i : unitType === 'workstation' ? /space|room|parking/i : /desk|space|room|hot/i;
          chosen = forms.find(function (f) { return !avoid.test(f.name || ''); }) || null;
        }
        chosen = chosen || forms[0];
        return customGet('v2/forms/spacebooking', { fetchFormRuleFields: true, forCreate: true, formId: chosen.id, skipPermission: true })
          .catch(function () { return null; })
          .then(function (detailBody) {
            var form = detailBody && detailBody.result && (detailBody.result.form || (detailBody.result.sections ? detailBody.result : null));
            if (!form) return { id: chosen.id, name: chosen.name, displayName: chosen.displayName, fields: [] };
            var fields = (form.sections || []).reduce(function (acc, s) { return acc.concat(s.fields || []); }, [])
              .map(function (ff) {
                return {
                  name: (ff.field && ff.field.name) || ff.fieldName || '',
                  label: ff.displayName || (ff.field && ff.field.displayName) || '',
                  required: !!ff.required,
                  type: ff.displayTypeEnum || (ff.field && ff.field.displayTypeEnum) || 'TEXTBOX',
                  lookupModule: ff.field && ff.field.lookupModule && ff.field.lookupModule.name,
                  sequence: ff.sequenceNumber || 0,
                };
              })
              .filter(function (f) { return f.name; })
              .sort(function (a, b) { return a.sequence - b.sequence; });
            return { id: form.id, name: form.name, displayName: form.displayName, fields: fields };
          });
      });
  }

  // ---- create payload ------------------------------------------------------
  var RESOURCE_LOOKUP_FIELD = { workstation: 'desk', room: 'space', parking: 'parkingStall', locker: 'locker' };
  var RESOURCE_MODULE = { workstation: 'desks', room: 'space', parking: 'parkingstall', locker: 'lockers' };

  var modulesCache = null;
  function moduleIdByName() {
    if (!modulesCache) {
      modulesCache = customGet('v3/modules/list/all', { skipPermission: true }).then(function (body) {
        var map = {};
        var data = (body && body.data) || {};
        [data.modules, data.systemModules, data.customModules, body && body.modules].forEach(function (list) {
          if (!Array.isArray(list)) return;
          list.forEach(function (m) {
            var id = Number(m && (m.id !== undefined ? m.id : m.moduleId));
            var name = m && (m.name || m.moduleName);
            if (name && isFinite(id)) map[String(name)] = id;
          });
        });
        return map;
      }).catch(function () { return {}; });
    }
    return modulesCache;
  }

  // ---- ORG TIMEZONE: values on the wire are EPOCH MILLIS computed in the org's zone; all
  // "today"/"now" guards read the org clock. Browser zone is only the unresolved fallback.
  var orgTzCache = null;
  function fetchOrgTimezone() {
    if (!orgTzCache) {
      orgTzCache = customGet('v2/account').catch(function () { return null; }).then(function (body) {
        var account = (body && (body.result && body.result.account)) || (body && body.account) || null;
        var cands = account ? [account.org && account.org.timezone, account.org && account.org.timeZone, account.user && account.user.timezone] : [];
        for (var i = 0; i < cands.length; i++) {
          var tz = cands[i];
          if (typeof tz === 'string' && tz) {
            try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { /* next */ }
          }
        }
        return null;
      });
    }
    return orgTzCache;
  }
  function tzParts(at, tz) {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(at));
    var get = function (t) { var x = parts.find(function (q) { return q.type === t; }); return Number((x && x.value) || 0); };
    return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
  }
  function tzOffsetMs(tz, at) {
    var q = tzParts(at, tz);
    return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - at;
  }
  function epochAt(dateISO, minutes, tz) {
    var p = dateISO.split('-').map(Number);
    if (!tz) return new Date(p[0], (p[1] || 1) - 1, p[2] || 1, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
    var guess = Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1, Math.floor(minutes / 60), minutes % 60, 0, 0);
    var t = guess - tzOffsetMs(tz, guess);
    var off2 = tzOffsetMs(tz, t);
    if (guess - off2 !== t) t = guess - off2;
    return t;
  }
  function dateISOInTz(at, tz) {
    if (!tz) {
      var d = new Date(at);
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    var q = tzParts(at, tz);
    return q.y + '-' + ('0' + q.mo).slice(-2) + '-' + ('0' + q.d).slice(-2);
  }
  function orgNow(tz) {
    if (!tz) {
      var d = new Date();
      return { dateISO: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2), minutes: d.getHours() * 60 + d.getMinutes() };
    }
    var q = tzParts(Date.now(), tz);
    return { dateISO: q.y + '-' + ('0' + q.mo).slice(-2) + '-' + ('0' + q.d).slice(-2), minutes: q.h * 60 + q.mi };
  }

  function createSpaceBooking(input) {
    return Promise.all([moduleIdByName(), fetchOrgTimezone()]).then(function (rr) {
      var map = rr[0];
      var tz = rr[1];
      var parentModuleId = map[RESOURCE_MODULE[input.unitType]];
      if (!parentModuleId) return { ok: false, reason: 'could not resolve parentModuleId' };
      var internal = (input.internalAttendees || []).map(function (id) { return { id: id }; });
      if (input.reservedBy && !internal.some(function (a) { return a.id === input.reservedBy; })) internal.unshift({ id: input.reservedBy });
      var data = Object.assign({}, input.extras || {});
      if (input.formId) { data.formId = input.formId; data.actionFormId = input.formId; }
      data[RESOURCE_LOOKUP_FIELD[input.unitType]] = { id: input.resourceId };
      data.parentModuleId = parentModuleId;
      data.bookingStartTime = epochAt(input.dateISO, input.startMinutes, tz);
      // Breach marker = start + 30min, sent explicitly on create (mirrors the main app).
      data.bookingbreachtime = data.bookingStartTime + 1800000;
      data.bookingEndTime = epochAt(input.dateISO, input.endMinutes, tz);
      data.noOfAttendees = input.noOfAttendees > 0 ? input.noOfAttendees : Math.max(1, internal.length);
      data.name = input.name || input.resourceLabel + ' booking';
      if (input.description) data.description = input.description;
      data.internalAttendees = internal;
      data.externalAttendees = (input.externalAttendees || []).map(function (id) { return { id: id }; });
      if (input.reservedBy) data.reservedBy = { id: input.reservedBy };
      if (input.host) data.host = { id: input.host };
      return createRecord('spacebooking', { data: data }).then(function (res) {
        if (res.error) return { ok: false, reason: res.error.message || ('code ' + res.error.code) };
        return { ok: true, id: res.spacebooking && res.spacebooking.id };
      });
    });
  }

  // ---- UI -------------------------------------------------------------------
  var KNOWN = { name: 1, description: 1, host: 1, reservedBy: 1, noOfAttendees: 1, bookingStartTime: 1, bookingEndTime: 1, bookingbreachtime: 1, internalAttendees: 1, externalAttendees: 1 };
  var RESOURCE_LOOKUPS = { desks: 1, space: 1, basespace: 1, parkingstall: 1, facility: 1, parkinglot: 1, lockers: 1 };
  var PEOPLE_LOOKUPS = { people: 1, employee: 1, clientcontact: 1, users: 1 };

  var S = {
    root: { font: '400 13.5px/1.45 system-ui, sans-serif', color: '#1c2733', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 },
    label: { display: 'block', font: '600 11.5px/1 system-ui, sans-serif', color: '#5b6b7d', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.03em' },
    input: { width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #d5dce4', font: 'inherit', background: '#fff' },
    chip: { padding: '6px 10px', borderRadius: 6, border: '1px solid #d5dce4', background: '#fff', font: '500 12px/1 system-ui, sans-serif', cursor: 'pointer' },
    chipActive: { border: '1px solid #0059d6', background: '#eef4fd', color: '#0059d6' },
    chipDisabled: { background: '#f2f4f7', color: '#b3bdc9', cursor: 'not-allowed' },
    button: { padding: '10px 16px', borderRadius: 8, border: 'none', background: '#0059d6', color: '#fff', font: '600 13.5px system-ui, sans-serif', cursor: 'pointer' },
    ghost: { padding: '10px 16px', borderRadius: 8, background: '#fff', color: '#1c2733', border: '1.5px solid #d5dce4', font: '600 13.5px system-ui, sans-serif', cursor: 'pointer' },
    error: { color: '#b61919', font: '500 12.5px system-ui, sans-serif' },
  };

  function fmtTime(m) {
    var h24 = Math.floor(m / 60);
    var ampm = h24 % 24 >= 12 ? 'PM' : 'AM';
    var h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return h12 + ':' + ('0' + (m % 60)).slice(-2) + ' ' + ampm;
  }

  function BookingForm(props) {
    var React = global.React;
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var unitType = props.unitType;
    var isRoom = unitType === 'room';
    // ONLY rooms book by slots — desks, parking, and lockers all book a plain start/end window.
    var useSlots = isRoom;
    var slotLen = ROOM_SLOT_MINUTES;
    var _tz = useState(null), tz = _tz[0], setTz = _tz[1];
    useEffect(function () {
      var alive = true;
      fetchOrgTimezone().then(function (z) { if (alive) setTz(z); });
      return function () { alive = false; };
    }, []);
    var nowOrg = orgNow(tz);
    var minDate = nowOrg.dateISO;
    var maxDate = isRoom ? minDate : dateISOInTz(Date.now() + 7 * 86400000, tz);
    var nowMinutes = nowOrg.minutes;

    var _form = useState(null), form = _form[0], setForm = _form[1];
    var _loading = useState(true), loading = _loading[0], setLoading = _loading[1];
    var _contacts = useState([]), contacts = _contacts[0], setContacts = _contacts[1];
    var _date = useState(minDate), date = _date[0], setDate = _date[1];
    var _slot = useState(null), slotStart = _slot[0], setSlotStart = _slot[1];
    var defStart = Math.min(1410, Math.ceil(nowMinutes / 30) * 30);
    var _start = useState(defStart), startMin = _start[0], setStartMin = _start[1];
    var _end = useState(Math.min(1440, defStart + 60)), endMin = _end[0], setEndMin = _end[1];
    var _name = useState(''), name = _name[0], setName = _name[1];
    var _desc = useState(''), description = _desc[0], setDescription = _desc[1];
    var _host = useState(''), host = _host[0], setHost = _host[1];
    var _resBy = useState(''), reservedBy = _resBy[0], setReservedBy = _resBy[1];
    var _att = useState('1'), noOfAttendees = _att[0], setNoOfAttendees = _att[1];
    var _extras = useState({}), extras = _extras[0], setExtras = _extras[1];
    var _busy = useState(false), submitting = _busy[0], setSubmitting = _busy[1];
    var _err = useState(null), error = _err[0], setError = _err[1];

    useEffect(function () {
      var alive = true;
      fetchBookingForm(unitType).then(function (f) { if (alive) setForm(f); }).finally(function () { if (alive) setLoading(false); });
      fetchAll('clientcontact', { page: 1, perPage: 500 }).then(function (res) {
        if (alive) setContacts((res.list || []).map(function (c) { return { id: Number(c.id), name: c.name }; }));
      }).catch(function () {});
      return function () { alive = false; };
    }, [unitType]);

    var slots = [];
    for (var m = 0; m + slotLen <= 1440; m += slotLen) slots.push(m);
    function slotSelectable(mm) { return date !== minDate || mm >= nowMinutes; }
    var TIMES = [];
    for (var t = 0; t <= 1440; t += 30) TIMES.push(t);

    function setExtra(fieldName, v) {
      setExtras(function (x) { var n = Object.assign({}, x); n[fieldName] = v; return n; });
    }

    function onSubmit() {
      setError(null);
      if (date < minDate || date > maxDate) {
        setError(isRoom ? 'Rooms can only be booked for today.' : 'Bookings can be made at most one week ahead.');
        return;
      }
      var start, end;
      if (useSlots) {
        if (slotStart == null) { setError('Pick a time slot.'); return; }
        if (!slotSelectable(slotStart)) { setError('That slot has already started — pick an upcoming one.'); return; }
        start = slotStart; end = slotStart + slotLen;
      } else {
        if (endMin <= startMin) { setError('End time must be after the start time.'); return; }
        if (!slotSelectable(startMin)) { setError('That start time has already passed.'); return; }
        start = startMin; end = endMin;
      }
      var fields = (form && form.fields) || [];
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var lm = (f.lookupModule || '').toLowerCase();
        if (KNOWN[f.name] || RESOURCE_LOOKUPS[lm]) continue;
        if (f.required && !String(extras[f.name] || '').trim()) { setError('"' + (f.label || f.name) + '" is required.'); return; }
      }
      var extraValues = {};
      fields.forEach(function (f) {
        var raw = String(extras[f.name] || '').trim();
        var lm = (f.lookupModule || '').toLowerCase();
        if (!raw || KNOWN[f.name] || RESOURCE_LOOKUPS[lm]) return;
        if (f.lookupModule) { var id = Number(raw); if (isFinite(id)) extraValues[f.name] = { id: id }; }
        else if (f.type === 'NUMBER' || f.type === 'DECIMAL') extraValues[f.name] = Number(raw);
        else if (f.type === 'DECISION_BOX') extraValues[f.name] = raw === '1';
        else extraValues[f.name] = raw;
      });
      setSubmitting(true);
      createSpaceBooking({
        unitType: unitType,
        resourceId: props.resourceId,
        resourceLabel: props.resourceLabel,
        dateISO: date,
        startMinutes: start,
        endMinutes: end,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        host: host ? Number(host) : undefined,
        reservedBy: reservedBy ? Number(reservedBy) : undefined,
        noOfAttendees: Number(noOfAttendees) || 1,
        formId: form && form.id,
        extras: extraValues,
      }).then(function (res) {
        setSubmitting(false);
        if (!res.ok) setError(res.reason || 'Booking failed.');
        else if (props.onDone) props.onDone(res.id);
      });
    }

    function field(label, required, child) {
      return h('div', null,
        h('label', { style: S.label }, required ? h('span', { style: { color: '#b61919', marginRight: 3 } }, '*') : null, label),
        child);
    }
    function contactSelect(value, onChange, label, required) {
      return field(label, required,
        h('select', { style: S.input, value: value, onChange: function (e) { onChange(e.target.value); } },
          [h('option', { key: '', value: '' }, '— Select —')].concat(contacts.map(function (c) {
            return h('option', { key: c.id, value: c.id }, c.name);
          }))));
    }

    if (loading) return h('div', { style: S.root }, "Loading the org's booking form…");

    var timeControls;
    if (useSlots) {
      timeControls = field('Time Slots', true, h('div', null,
        h('input', { style: S.input, type: 'date', value: date, min: minDate, max: maxDate, onChange: function (e) { setDate(e.target.value); } }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 } }, slots.map(function (mm) {
          var ok = slotSelectable(mm);
          var st = Object.assign({}, S.chip, slotStart === mm ? S.chipActive : null, ok ? null : S.chipDisabled);
          return h('button', { key: mm, type: 'button', disabled: !ok, style: st, onClick: function () { setSlotStart(mm); } },
            fmtTime(mm) + ' – ' + fmtTime(mm + slotLen));
        }))));
    } else {
      timeControls = field('Booking Window', true,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 } },
          h('input', { style: S.input, type: 'date', value: date, min: minDate, max: maxDate, onChange: function (e) { setDate(e.target.value); } }),
          h('select', { style: S.input, value: startMin, onChange: function (e) { setStartMin(Number(e.target.value)); } },
            TIMES.filter(function (mm) { return mm < endMin; }).map(function (mm) { return h('option', { key: mm, value: mm }, fmtTime(mm)); })),
          h('select', { style: S.input, value: endMin, onChange: function (e) { setEndMin(Number(e.target.value)); } },
            TIMES.filter(function (mm) { return mm > startMin; }).map(function (mm) { return h('option', { key: mm, value: mm }, fmtTime(mm)); }))));
    }

    var extraFields = ((form && form.fields) || []).filter(function (f) {
      return !KNOWN[f.name] && !RESOURCE_LOOKUPS[(f.lookupModule || '').toLowerCase()];
    }).map(function (f) {
      var lm = (f.lookupModule || '').toLowerCase();
      var control;
      if (f.lookupModule && PEOPLE_LOOKUPS[lm]) {
        control = h('select', { style: S.input, value: extras[f.name] || '', onChange: function (e) { setExtra(f.name, e.target.value); } },
          [h('option', { key: '', value: '' }, '— Select —')].concat(contacts.map(function (c) { return h('option', { key: c.id, value: c.id }, c.name); })));
      } else if (f.type === 'TEXTAREA') {
        control = h('textarea', { style: Object.assign({}, S.input, { height: 56 }), value: extras[f.name] || '', onChange: function (e) { setExtra(f.name, e.target.value); } });
      } else {
        var type = f.type === 'NUMBER' || f.type === 'DECIMAL' ? 'number' : f.type === 'DATE' ? 'date' : f.type === 'DATETIME' ? 'datetime-local' : 'text';
        control = h('input', { style: S.input, type: type, value: extras[f.name] || '', onChange: function (e) { setExtra(f.name, e.target.value); } });
      }
      return h(React.Fragment, { key: f.name }, field(f.label || f.name, f.required, control));
    });

    return h('div', { style: S.root },
      field(isRoom ? 'Location' : unitType === 'parking' ? 'Parking' : 'Desk', true,
        h('div', { style: Object.assign({}, S.input, { background: '#f2f4f7' }) }, props.resourceLabel)),
      field('Name', false, h('input', { style: S.input, value: name, placeholder: 'Enter your text here', onChange: function (e) { setName(e.target.value); } })),
      field('Description', false, h('textarea', { style: Object.assign({}, S.input, { height: 64 }), value: description, onChange: function (e) { setDescription(e.target.value); } })),
      contactSelect(host, setHost, 'Host', false),
      contactSelect(reservedBy, setReservedBy, 'Reserved By', true),
      field('Number Of Attendees', false, h('input', { style: S.input, type: 'number', min: 1, value: noOfAttendees, onChange: function (e) { setNoOfAttendees(e.target.value); } })),
      timeControls,
      extraFields,
      error ? h('div', { style: S.error }, error) : null,
      h('div', { style: { display: 'flex', gap: 10, justifyContent: 'flex-end' } },
        props.onCancel ? h('button', { type: 'button', style: S.ghost, disabled: submitting, onClick: props.onCancel }, 'Cancel') : null,
        h('button', { type: 'button', style: S.button, disabled: submitting, onClick: onSubmit }, submitting ? 'Saving…' : 'Submit Details')));
  }

  global.FacilioBookingForms = {
    BookingForm: BookingForm,
    fetchBookingForm: fetchBookingForm,
    createSpaceBooking: createSpaceBooking,
    mount: function (el, props) {
      var root = global.ReactDOM.createRoot(el);
      root.render(global.React.createElement(BookingForm, props));
      return root;
    },
  };
})(window);
