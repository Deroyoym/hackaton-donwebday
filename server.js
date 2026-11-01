require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- Login del negocio (cookie firmada, sin dependencias) ----------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'donpepe';
const ES_DEMO = !process.env.ADMIN_PASSWORD; // sin contraseña propia, el login muestra el acceso demo
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('pedido-express:' + ADMIN_PASSWORD + OPENAI_API_KEY).digest('hex');
const SESION_HORAS = 12;

const firmar = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const igualSeguro = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function sesionValida(req) {
  const m = /(?:^|;\s*)pe_sess=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, firma] = decodeURIComponent(m[1]).split('.');
  return !!exp && !!firma && igualSeguro(firma, firmar(exp)) && Number(exp) > Date.now();
}
function cookieSesion(req, valor, maxAge) {
  const segura = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `pe_sess=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${segura ? '; Secure' : ''}`;
}
const soloAdmin = (req, res, next) => (sesionValida(req) ? next() : res.status(401).json({ error: 'Tu sesión venció. Volvé a iniciar sesión.' }));

const app = express();
app.use(express.json({ limit: '8mb' })); // margen para capturas de pantalla en base64
// Las pantallas del negocio (/admin) requieren sesión; si no hay, van al login.
app.use('/admin', (req, res, next) => (sesionValida(req) ? next() : res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl))));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
  const okUser = igualSeguro(String(req.body?.usuario || '').trim().toLowerCase(), ADMIN_USER.toLowerCase());
  const okPass = igualSeguro(String(req.body?.password || ''), ADMIN_PASSWORD);
  if (!okUser || !okPass) {
    await new Promise((r) => setTimeout(r, 600)); // frena intentos por fuerza bruta
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  const exp = String(Date.now() + SESION_HORAS * 3600 * 1000);
  res.setHeader('Set-Cookie', cookieSesion(req, exp + '.' + firmar(exp), SESION_HORAS * 3600));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookieSesion(req, '', 0));
  res.json({ ok: true });
});
app.get('/api/auth', (req, res) => {
  res.json({ logueado: sesionValida(req), demo: ES_DEMO ? { usuario: ADMIN_USER, password: ADMIN_PASSWORD } : null });
});

// ---------- Datos (archivo JSON) ----------
const DEFAULT_DATA = {
  config: {
    negocio: 'Pizzería Don Pepe',
    telefono: '',
    envio: 1500,
    horarios: 'Martes a domingo de 19:30 a 00:00. Lunes cerrado.',
    abre: '19:30',
    cierra: '00:00',
    diasCerrados: [1], // 0 = domingo … 6 = sábado
    info: 'Envíos en un radio de 30 cuadras, demoran entre 30 y 45 minutos. Aceptamos efectivo, transferencia y Mercado Pago. No tenemos opciones sin TACC.',
    menu: [
      { producto: 'Pizza muzzarella', precio: 9000 },
      { producto: 'Pizza napolitana', precio: 10500 },
      { producto: 'Pizza fugazzeta', precio: 10000 },
      { producto: 'Pizza calabresa', precio: 11000 },
      { producto: 'Empanada de carne', precio: 1500 },
      { producto: 'Empanada de jamón y queso', precio: 1500 },
      { producto: 'Empanada de pollo', precio: 1500 },
      { producto: 'Faina', precio: 2500 },
      { producto: 'Coca-Cola 1.5L', precio: 3500 },
      { producto: 'Cerveza Quilmes 1L', precio: 4000 },
      { producto: 'Agua mineral 500ml', precio: 1500 }
    ]
  },
  pedidos: [],
  nextId: 1
};

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...DEFAULT_DATA, ...d, config: { ...DEFAULT_DATA.config, ...(d.config || {}) } };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}
let data = loadData();
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('No se pudo guardar data.json:', e.message);
  }
}

// ---------- IA ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class IAError extends Error {
  constructor(msg, status = 502) { super(msg); this.status = status; }
}

async function callIA(messages, parseRetry = false) {
  if (!OPENAI_API_KEY) throw new IAError('Falta configurar OPENAI_API_KEY en el servidor.', 500);
  const body = { model: OPENAI_MODEL, messages, temperature: 0.2 };
  if (OPENAI_BASE_URL.includes('api.openai.com')) body.response_format = { type: 'json_object' };

  const waits = [2000, 4000];
  for (let intento = 0; intento <= waits.length; intento++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new IAError('La IA tardó demasiado en responder. Probá de nuevo.', 504);
      throw new IAError('No se pudo conectar con la IA. Probá de nuevo.');
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status === 503) {
      if (intento < waits.length) { await sleep(waits[intento]); continue; }
      throw new IAError('La IA está saturada, probá de nuevo en unos segundos.', 503);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('Error IA', res.status, txt.slice(0, 500));
      throw new IAError(`La IA devolvió un error (${res.status}).`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || '';
    try {
      return parseJSON(content);
    } catch (e) {
      // Si la IA no respondió en JSON, reintentamos una vez antes de mostrar error.
      console.error('Respuesta no JSON de la IA:', content.slice(0, 300));
      if (!parseRetry) return callIA(messages, true);
      throw e;
    }
  }
}

function parseJSON(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch {}
  }
  throw new IAError('La IA respondió en un formato inesperado. Probá de nuevo.');
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (s) => str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function buildPrompt(config) {
  const menu = config.menu.map((m) => `- ${m.producto}: $${m.precio}`).join('\n');
  return `Sos el asistente de pedidos de "${config.negocio}", un negocio local de Argentina.
Recibís mensajes de clientes (chats de WhatsApp copiados, notas de llamadas, audios transcriptos) y los convertís en un pedido ordenado.

MENÚ (usá EXACTAMENTE estos nombres de producto):
${menu}
Costo de envío: $${config.envio}

Reglas:
- Mapeá lo que pide el cliente al producto del menú más parecido ("muzza" = "Pizza muzzarella", "una coca" = "Coca-Cola 1.5L", "docena" = 12 unidades, "media docena" = 6).
- Si algo NO está en el menú, ponelo en "no_reconocidos" y no lo inventes en items.
- Si el chat tiene varios mensajes o el cliente cambia de idea, quedate con la versión FINAL del pedido.
- "faltantes": lista corta de datos necesarios que faltan para cerrar el pedido (ej: "dirección de entrega", "horario", "forma de pago", "nombre", "gusto de las empanadas"). Si es envío y no hay dirección, falta la dirección.
- "respuesta_sugerida": mensaje de WhatsApp amable, corto, en español rioplatense, para mandarle al cliente: confirmá el pedido y preguntá lo que falte. Para el monto escribí literalmente {TOTAL} (el sistema lo reemplaza por el total real); no escribas números de precio.
- No inventes datos que el cliente no dio: dejalos en "".

Respondé SOLO con un JSON con esta forma exacta:
{
  "cliente": { "nombre": "", "telefono": "" },
  "items": [ { "producto": "nombre exacto del menú", "cantidad": 1, "nota": "" } ],
  "no_reconocidos": [ "" ],
  "entrega": { "tipo": "envio" | "retiro" | "", "direccion": "", "horario": "" },
  "pago": "",
  "faltantes": [ "" ],
  "respuesta_sugerida": ""
}`;
}

// Valida y completa la respuesta de la IA. El total lo calcula el server con los precios reales.
function normalizarPedido(raw, config) {
  const menuMap = new Map(config.menu.map((m) => [norm(m.producto), m]));
  const items = [];
  const noReconocidos = Array.isArray(raw?.no_reconocidos) ? raw.no_reconocidos.map(str).filter(Boolean) : [];

  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const nombre = str(it?.producto);
    if (!nombre) continue;
    let m = menuMap.get(norm(nombre));
    if (!m) m = config.menu.find((x) => norm(x.producto).includes(norm(nombre)) || norm(nombre).includes(norm(x.producto)));
    const cantidad = Math.max(1, Math.round(Number(it?.cantidad) || 1));
    if (!m) { noReconocidos.push(`${cantidad} x ${nombre}`); continue; }
    items.push({ producto: m.producto, cantidad, precio_unit: Number(m.precio) || 0, nota: str(it?.nota) });
  }

  const tipoRaw = norm(raw?.entrega?.tipo);
  const tipo = tipoRaw.startsWith('env') || tipoRaw.includes('deliv') ? 'envio' : tipoRaw.startsWith('ret') ? 'retiro' : '';
  const pedido = {
    cliente: { nombre: str(raw?.cliente?.nombre), telefono: str(raw?.cliente?.telefono) },
    items,
    no_reconocidos: noReconocidos,
    entrega: { tipo, direccion: str(raw?.entrega?.direccion), horario: str(raw?.entrega?.horario) },
    pago: str(raw?.pago),
    faltantes: Array.isArray(raw?.faltantes) ? raw.faltantes.map(str).filter(Boolean) : [],
    respuesta_sugerida: str(raw?.respuesta_sugerida)
  };
  calcularTotales(pedido, config);
  pedido.respuesta_sugerida = ponerTotal(pedido.respuesta_sugerida, pedido.total);
  return pedido;
}

// La IA escribe {TOTAL} y acá ponemos el monto real calculado con el menú.
function ponerTotal(texto, total) {
  return str(texto).replace(/(?:\$\s?)?\{\s*TOTAL\s*\}/gi, () => '$' + Number(total || 0).toLocaleString('es-AR'));
}

// Qué datos faltan para poder cerrar un pedido del chat (lo decide el server, no la IA).
function faltantesChat(p) {
  const f = [];
  if (!p.items.length) f.push('productos');
  if (!p.cliente.nombre) f.push('nombre');
  if (!p.cliente.telefono) f.push('teléfono');
  if (!p.entrega.tipo) f.push('retiro o envío');
  if (p.entrega.tipo === 'envio' && !p.entrega.direccion) f.push('dirección');
  return f;
}

// ---------- Abierto / cerrado (hora de Argentina) ----------
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const aMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(hhmm));
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : null;
};

function estadoLocal(config, fecha = new Date()) {
  const abre = aMin(config.abre), cierraRaw = aMin(config.cierra);
  if (abre === null || cierraRaw === null) return { abierto: true, texto: 'horario no configurado', proximaApertura: '' };
  const cerrados = new Set(Array.isArray(config.diasCerrados) ? config.diasCerrados.map(Number) : []);
  // Si cierra a la medianoche o después (ej. 19:30 a 01:00), el turno cruza al día siguiente.
  const cruza = cierraRaw <= abre;
  const cierra = cruza ? cierraRaw + 24 * 60 : cierraRaw;

  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(fecha).map((p) => [p.type, p.value]));
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes.weekday);
  const min = Number(partes.hour) * 60 + Number(partes.minute);
  const ayer = (dia + 6) % 7;

  const abiertoHoy = !cerrados.has(dia) && min >= abre && min < cierra;
  const abiertoDesdeAyer = cruza && !cerrados.has(ayer) && min < cierraRaw;
  if (abiertoHoy || abiertoDesdeAyer) {
    return { abierto: true, texto: `abierto ahora, cierra a las ${config.cierra}`, proximaApertura: '' };
  }
  // Próxima apertura
  for (let d = 0; d < 8; d++) {
    const dd = (dia + d) % 7;
    if (cerrados.has(dd)) continue;
    if (d === 0 && min >= abre) continue;
    const cuando = d === 0 ? 'hoy' : d === 1 ? 'mañana' : 'el ' + DIAS[dd];
    return { abierto: false, texto: `cerrado, abre ${cuando} a las ${config.abre}`, proximaApertura: `${cuando} ${config.abre}` };
  }
  return { abierto: false, texto: 'cerrado', proximaApertura: '' };
}

function buildChatPrompt(config, pedidoActual) {
  const menu = config.menu.map((m) => `- ${m.producto}: $${m.precio}`).join('\n');
  const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const estado = pedidoActual
    ? JSON.stringify({ cliente: pedidoActual.cliente, items: pedidoActual.items.map((i) => ({ producto: i.producto, cantidad: i.cantidad, nota: i.nota })), entrega: pedidoActual.entrega, pago: pedidoActual.pago })
    : 'vacío (todavía no pidió nada)';
  const est = estadoLocal(config);
  return `Sos el asistente virtual de "${config.negocio}", un negocio local de Argentina. Atendés a los clientes por chat las 24 hs, como lo haría el mejor empleado del local.

AHORA ES: ${ahora} (hora de Argentina).
ESTADO DEL LOCAL AHORA (calculado por el sistema, es la verdad): ${est.abierto ? 'ABIERTO' : 'CERRADO'} — ${est.texto}.

PEDIDO ACTUAL (lo que ya se anotó; mantenelo y actualizalo con lo nuevo que diga el cliente):
${estado}

INFORMACIÓN DEL NEGOCIO (copiá los datos tal cual, no los cambies):
- Horarios: ${config.horarios || 'no informado'}
- Costo de envío: $${config.envio}
- Otros datos: ${config.info || 'sin datos extra'}

MENÚ (usá EXACTAMENTE estos nombres):
${menu}

Reglas:
- Respondé MUY corto: máximo 2 oraciones (unas 30 palabras), cálido, en español rioplatense, como un mensaje de WhatsApp. Como mucho un emoji.
- El cliente ve en pantalla un ticket con los productos, precios y total. NO enumeres el pedido ni repitas lo que ya anotaste: confirmá el cambio en pocas palabras (ej: "¡Sumé la coca! 🙌") y preguntá lo siguiente que falte.
- Si te preguntan si están abiertos, respondé según ESTADO DEL LOCAL AHORA. Nunca digas que está abierto si dice CERRADO.
- Si el local está CERRADO y el cliente quiere pedir: avisale amablemente que ahora está cerrado, decile cuándo abre y ofrecé dejar el pedido PROGRAMADO para la apertura. Igual anotá en "pedido" desde el primer mensaje todos los productos que pida. Si acepta, seguí armándolo normal y poné en entrega.horario "${est.proximaApertura ? 'apertura ' + est.proximaApertura : 'a la apertura'}" (o el horario que pida el cliente, siempre dentro del horario de atención).
- Usá SOLO la información de arriba. Si te preguntan algo que no está, decí que lo consultás con el local. Nunca inventes productos, precios ni promociones.
- Si piden algo que no está en el menú, decilo y sugerí lo más parecido.
- Ayudá a armar el pedido. En "pedido" devolvé SIEMPRE el estado ACTUAL y COMPLETO del pedido, acumulando todo lo de la conversación (si el cliente cambia algo, actualizalo).
- Para cerrar el pedido hacen falta: productos, nombre, teléfono, retiro o envío y, si es envío, dirección. Preguntá la forma de pago pero no es obligatoria. Pedí los datos de a uno o dos por mensaje, no todos juntos.
- Si el cliente duda, podés sugerir UN complemento (bebida, faina, empanadas) sin insistir.
- Cuando ya estén todos los datos, decí el total escribiendo literalmente {TOTAL} y pedile que toque el botón "Confirmar pedido" (sin volver a listar los productos).
- NUNCA digas que el pedido está confirmado, en preparación o en camino: eso pasa recién cuando el cliente toca el botón.
- Cuando el cliente te dé nombre, teléfono, dirección o forma de pago, guardalos en "pedido" en ese mismo mensaje.
- No escribas el total con números: usá siempre {TOTAL}. Los precios unitarios del menú sí los podés decir.

Respondé SOLO con este JSON:
{
  "respuesta": "mensaje para el cliente",
  "pedido": {
    "cliente": { "nombre": "", "telefono": "" },
    "items": [ { "producto": "nombre exacto del menú", "cantidad": 1, "nota": "" } ],
    "no_reconocidos": [],
    "entrega": { "tipo": "envio" | "retiro" | "", "direccion": "", "horario": "" },
    "pago": ""
  }
}`;
}

function calcularTotales(p, config) {
  p.subtotal = p.items.reduce((s, i) => s + i.cantidad * i.precio_unit, 0);
  p.envio = p.entrega.tipo === 'envio' ? Number(config.envio) || 0 : 0;
  p.total = p.subtotal + p.envio;
  return p;
}

// ---------- API ----------
app.get('/api/config', (req, res) => res.json({ ...data.config, estado: estadoLocal(data.config) }));

app.put('/api/config', soloAdmin, (req, res) => {
  const b = req.body || {};
  const menu = (Array.isArray(b.menu) ? b.menu : [])
    .map((m) => ({ producto: str(m?.producto), precio: Math.max(0, Number(m?.precio) || 0) }))
    .filter((m) => m.producto);
  if (!menu.length) return res.status(400).json({ error: 'El menú necesita al menos un producto.' });
  data.config = {
    negocio: str(b.negocio) || 'Mi negocio',
    telefono: str(b.telefono),
    envio: Math.max(0, Number(b.envio) || 0),
    horarios: str(b.horarios).slice(0, 500),
    abre: aMin(b.abre) !== null ? str(b.abre) : '',
    cierra: aMin(b.cierra) !== null ? str(b.cierra) : '',
    diasCerrados: (Array.isArray(b.diasCerrados) ? b.diasCerrados : []).map(Number).filter((d) => d >= 0 && d <= 6),
    info: str(b.info).slice(0, 2000),
    menu
  };
  saveData();
  res.json(data.config);
});

app.post('/api/procesar', soloAdmin, async (req, res) => {
  const texto = str(req.body?.texto);
  const imagen = str(req.body?.imagen);
  if (!texto && !imagen) return res.status(400).json({ error: 'Pegá el mensaje del cliente o subí una captura.' });
  if (texto.length > 8000) return res.status(400).json({ error: 'El texto es muy largo (máx. 8000 caracteres).' });
  if (imagen && (!/^data:image\/(png|jpe?g|webp);base64,/.test(imagen) || imagen.length > 7_000_000)) {
    return res.status(400).json({ error: 'La imagen no es válida o es muy pesada.' });
  }
  let userContent = `Mensaje(s) del cliente:\n"""\n${texto}\n"""`;
  if (imagen) {
    userContent = [
      { type: 'text', text: 'Esta es una captura de pantalla de un chat de WhatsApp con un cliente. Los mensajes del negocio suelen estar a la derecha (verde) y los del cliente a la izquierda. Leé TODO el chat y armá el pedido del cliente.' + (texto ? `\nNotas extra del negocio: ${texto}` : '') },
      { type: 'image_url', image_url: { url: imagen } }
    ];
  }
  try {
    const raw = await callIA([
      { role: 'system', content: buildPrompt(data.config) },
      { role: 'user', content: userContent }
    ]);
    res.json(normalizarPedido(raw, data.config));
  } catch (e) {
    console.error('procesar:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Error inesperado.' });
  }
});

// Chat de autoatención para clientes: recibe la conversación y devuelve respuesta + estado del pedido.
app.post('/api/chat', async (req, res) => {
  const mensajes = (Array.isArray(req.body?.mensajes) ? req.body.mensajes : [])
    .filter((m) => ['user', 'assistant'].includes(m?.role) && str(m?.content))
    .slice(-20)
    .map((m) => ({ role: m.role, content: str(m.content).slice(0, 2000) }));
  if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Escribí un mensaje.' });
  }
  // Estado del pedido que tenía el cliente (lo manda el navegador), validado contra el menú.
  const previo = req.body?.pedido ? normalizarPedido(req.body.pedido, data.config) : null;
  // El recordatorio de formato va dentro del último mensaje: los modelos chicos lo respetan mejor.
  const ult = mensajes[mensajes.length - 1];
  ult.content += '\n\n[Respondé SOLO con el JSON {"respuesta": "...", "pedido": {...}} con el pedido completo y actualizado.]';
  try {
    const raw = await callIA([{ role: 'system', content: buildChatPrompt(data.config, previo) }, ...mensajes]);
    const pedido = normalizarPedido(raw?.pedido || {}, data.config);
    // Si la IA se "olvida" de datos que ya teníamos, los conservamos.
    if (previo) {
      if (!pedido.items.length && previo.items.length) pedido.items = previo.items;
      for (const k of ['nombre', 'telefono']) pedido.cliente[k] ||= previo.cliente[k];
      for (const k of ['tipo', 'direccion', 'horario']) pedido.entrega[k] ||= previo.entrega[k];
      pedido.pago ||= previo.pago;
      calcularTotales(pedido, data.config);
    }
    const faltantes = faltantesChat(pedido);
    const listo = faltantes.length === 0;
    let respuesta = ponerTotal(raw?.respuesta, pedido.total) || 'Perdón, no te entendí bien. ¿Me lo repetís?';
    if (listo && !/confirmar/i.test(respuesta)) {
      respuesta += `\n\n👉 Total ${'$' + pedido.total.toLocaleString('es-AR')}. Tocá "Confirmar pedido" para enviarlo al local.`;
    }
    res.json({ respuesta, pedido, faltantes, listo });
  } catch (e) {
    console.error('chat:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Error inesperado.' });
  }
});

app.get('/api/pedidos', soloAdmin, (req, res) => res.json([...data.pedidos].reverse()));

app.post('/api/pedidos', (req, res) => {
  const b = req.body || {};
  const admin = sesionValida(req);
  // Los precios salen siempre del menú: el navegador no puede cambiarlos.
  const precios = new Map(data.config.menu.map((m) => [norm(m.producto), m]));
  const items = (Array.isArray(b.items) ? b.items : [])
    .map((i) => {
      const m = precios.get(norm(i?.producto));
      if (!m) return null;
      return { producto: m.producto, cantidad: Math.min(99, Math.max(1, Math.round(Number(i?.cantidad) || 1))), precio_unit: Number(m.precio) || 0, nota: str(i?.nota).slice(0, 200) };
    })
    .filter(Boolean);
  if (!admin) b.origen = 'chat'; // sin sesión, solo puede venir del chat de clientes
  if (!items.length) return res.status(400).json({ error: 'El pedido no tiene productos.' });
  const tipo = ['envio', 'retiro'].includes(b?.entrega?.tipo) ? b.entrega.tipo : '';
  const pedido = calcularTotales({
    id: data.nextId++,
    creado: new Date().toISOString(),
    estado: 'nuevo',
    origen: ['chat', 'captura', 'manual'].includes(b.origen) ? b.origen : 'manual',
    cliente: { nombre: str(b?.cliente?.nombre), telefono: str(b?.cliente?.telefono) },
    items,
    entrega: { tipo, direccion: str(b?.entrega?.direccion), horario: str(b?.entrega?.horario) },
    pago: str(b.pago),
    faltantes: Array.isArray(b.faltantes) ? b.faltantes.map(str).filter(Boolean) : [],
    texto_original: str(b.texto_original).slice(0, 8000)
  }, data.config);
  data.pedidos.push(pedido);
  saveData();
  res.status(201).json(pedido);
});

const ESTADOS = ['nuevo', 'preparando', 'listo', 'entregado', 'cancelado'];
// Seguimiento público para el cliente: solo número, estado y tipo de entrega (sin datos personales).
app.get('/api/pedidos/:id/estado', (req, res) => {
  const p = data.pedidos.find((x) => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ id: p.id, estado: p.estado, entrega: p.entrega?.tipo || '' });
});
app.patch('/api/pedidos/:id', soloAdmin, (req, res) => {
  const p = data.pedidos.find((x) => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (!ESTADOS.includes(req.body?.estado)) return res.status(400).json({ error: 'Estado inválido.' });
  p.estado = req.body.estado;
  saveData();
  res.json(p);
});

app.get('/api/health', (req, res) => res.json({ ok: true, ia: !!OPENAI_API_KEY, modelo: OPENAI_MODEL }));

app.listen(PORT, () => console.log(`Pedido Express en http://localhost:${PORT}`));
