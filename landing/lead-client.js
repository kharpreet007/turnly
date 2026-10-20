/*
 * Drop-in replacement for the wa.me handoff in landing/index.html.
 * Usage inside the page script:
 *   TurnlyLead.configure({ apiBase: 'https://api.turnly.example' });
 *   const r = await TurnlyLead.submit({ business_type, name, country_code, phone, consent, consent_text, ... });
 *   if (r.ok) showThanks(); else if (r.fallback) showExistingCopyOrOpenWhatsAppScreen(); else showErrors(r.fields);
 * Never throws: if the API is unreachable it returns { ok:false, fallback:true } so the
 * page keeps its existing "copy message / open WhatsApp" result screen (FR-L6).
 */
(function () {
  var cfg = { apiBase: '' };
  function utm() {
    var out = {}, q = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) { if (q.get(k)) out[k] = q.get(k); });
    return out;
  }
  function eventId() { return 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
  window.TurnlyLead = {
    configure: function (c) { Object.assign(cfg, c); },
    async submit(data) {
      var id = eventId();
      var q = new URLSearchParams(location.search);
      var hash = (location.hash || '').replace('#', '');           // e.g. salon-fb1
      var source = data.ad_source || (hash.indexOf('-') > -1 ? hash.split('-').slice(1).join('-') : undefined);
      var body = Object.assign({ utm: utm(), fbclid: q.get('fbclid') || undefined, referrer: document.referrer || undefined, event_id: id, ad_source: source, website: '' }, data);
      try {
        var res = await fetch(cfg.apiBase + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (res.status === 400) { var j = await res.json().catch(function () { return {}; }); return { ok: false, fallback: false, fields: j.fields || [] }; }
        if (!res.ok) return { ok: false, fallback: true };
        // Same event id as the server-side Conversions API event, so Meta deduplicates them.
        if (window.fbq) window.fbq('track', 'Lead', {}, { eventID: id });
        return { ok: true };
      } catch (e) { return { ok: false, fallback: true }; }
    }
  };
})();
