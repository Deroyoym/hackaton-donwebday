require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- Datos (archivo JSON) ----------
const DEFAULT_DATA = {
  config: {
    negocio: 'Pizzería Don Pepe',
    telefono: '',
    envio: 1500,
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

async function callIA(messages) {
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
    return parseJSON(content);
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
  pedido.respuesta_sugerida = pedido.respuesta_sugerida.replace(/\{\s*TOTAL\s*\}/gi, () => '$' + pedido.total.toLocaleString('es-AR'));
  return pedido;
}

function calcularTotales(p, config) {
  p.subtotal = p.items.reduce((s, i) => s + i.cantidad * i.precio_unit, 0);
  p.envio = p.entrega.tipo === 'envio' ? Number(config.envio) || 0 : 0;
  p.total = p.subtotal + p.envio;
  return p;
}

// ---------- API ----------
app.get('/api/config', (req, res) => res.json(data.config));

app.put('/api/config', (req, res) => {
  const b = req.body || {};
  const menu = (Array.isArray(b.menu) ? b.menu : [])
    .map((m) => ({ producto: str(m?.producto), precio: Math.max(0, Number(m?.precio) || 0) }))
    .filter((m) => m.producto);
  if (!menu.length) return res.status(400).json({ error: 'El menú necesita al menos un producto.' });
  data.config = {
    negocio: str(b.negocio) || 'Mi negocio',
    telefono: str(b.telefono),
    envio: Math.max(0, Number(b.envio) || 0),
    menu
  };
  saveData();
  res.json(data.config);
});

app.post('/api/procesar', async (req, res) => {
  const texto = str(req.body?.texto);
  if (!texto) return res.status(400).json({ error: 'Pegá el mensaje del cliente.' });
  if (texto.length > 8000) return res.status(400).json({ error: 'El texto es muy largo (máx. 8000 caracteres).' });
  try {
    const raw = await callIA([
      { role: 'system', content: buildPrompt(data.config) },
      { role: 'user', content: `Mensaje(s) del cliente:\n"""\n${texto}\n"""` }
    ]);
    res.json(normalizarPedido(raw, data.config));
  } catch (e) {
    console.error('procesar:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Error inesperado.' });
  }
});

app.get('/api/pedidos', (req, res) => res.json([...data.pedidos].reverse()));

app.post('/api/pedidos', (req, res) => {
  const b = req.body || {};
  const items = (Array.isArray(b.items) ? b.items : [])
    .map((i) => ({ producto: str(i?.producto), cantidad: Math.max(1, Math.round(Number(i?.cantidad) || 1)), precio_unit: Math.max(0, Number(i?.precio_unit) || 0), nota: str(i?.nota) }))
    .filter((i) => i.producto);
  if (!items.length) return res.status(400).json({ error: 'El pedido no tiene productos.' });
  const tipo = ['envio', 'retiro'].includes(b?.entrega?.tipo) ? b.entrega.tipo : '';
  const pedido = calcularTotales({
    id: data.nextId++,
    creado: new Date().toISOString(),
    estado: 'nuevo',
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
app.patch('/api/pedidos/:id', (req, res) => {
  const p = data.pedidos.find((x) => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (!ESTADOS.includes(req.body?.estado)) return res.status(400).json({ error: 'Estado inválido.' });
  p.estado = req.body.estado;
  saveData();
  res.json(p);
});

app.get('/api/health', (req, res) => res.json({ ok: true, ia: !!OPENAI_API_KEY, modelo: OPENAI_MODEL }));

app.listen(PORT, () => console.log(`Pedido Express en http://localhost:${PORT}`));
