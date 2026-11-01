const $ = (s) => document.querySelector(s);
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch {
    throw new Error('No hay conexión con el servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Link de WhatsApp: si hay teléfono, abre el chat directo; si no, deja elegir contacto.
function waLink(tel, texto) {
  let num = String(tel || '').replace(/\D/g, '');
  if (num && !num.startsWith('54') && num.length <= 11) num = '549' + num.replace(/^0/, '').replace(/^15/, '');
  return `https://wa.me/${num}?text=${encodeURIComponent(texto)}`;
}
