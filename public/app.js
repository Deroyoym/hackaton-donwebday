const EJEMPLOS = [
  `[20:41] Juan: holaa
[20:41] Juan: tenes muzza?
[20:42] Juan: mandame 2 muzza y una napo, y 6 empanadas de carne
[20:42] Juan: ah y una coca grande
[20:43] Juan: es para calle Belgrano 1234, 2do B
[20:43] Juan: pago en efectivo`,
  `Llamó Marta (11 5555-1234). Quiere una fugazzeta, media docena de empanadas de jyq y una faina. Pasa a buscar a las 21:30. Pregunto si tenemos sin TACC.`,
  `Lucas: buenas, quiero 1 calabresa y 2 cervezas
Lucas: no mejor sacá las cervezas y poné 2 cocas
Lucas: y agregame una docena de empanadas de pollo
Lucas: me lo mandan?`
];

let config = null;
let pedido = null;

async function init() {
  try {
    config = await api('/api/config');
    $('#negocio').textContent = '· ' + config.negocio;
    $('#agregarProd').innerHTML = config.menu.map((m, i) => `<option value="${i}">${esc(m.producto)} (${money(m.precio)})</option>`).join('');
  } catch (e) { showError(e.message); }
}

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').classList.toggle('hidden', !msg);
}

document.querySelectorAll('[data-ej]').forEach((b) => b.addEventListener('click', () => {
  $('#texto').value = EJEMPLOS[b.dataset.ej];
  $('#texto').focus();
}));

// ---------- Captura de pantalla ----------
let imagen = ''; // data URL comprimida

function comprimirImagen(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Achicamos hasta que pese < ~800 KB (el servidor corta pedidos de más de 1 MB).
      let lado = max, calidad = 0.85, out = '';
      for (let i = 0; i < 6; i++) {
        const k = Math.min(1, lado / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', calidad);
        if (out.length < 800_000) break;
        lado *= 0.8;
        calidad = Math.max(0.6, calidad - 0.08);
      }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
    img.src = url;
  });
}

function setCaptura(dataUrl) {
  imagen = dataUrl;
  $('#capturaImg').src = dataUrl || '';
  $('#captura').classList.toggle('hidden', !dataUrl);
  $('#fileCaptura').value = '';
}

$('#fileCaptura').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    setCaptura(await comprimirImagen(f));
    showError('');
    $('#btnProcesar').click(); // un toque: subís la captura y ya se procesa
  } catch (err) { showError(err.message); }
});
$('#btnQuitarCaptura').addEventListener('click', () => setCaptura(''));

// Pegar una captura con Ctrl+V (útil en la compu con WhatsApp Web)
document.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  try { setCaptura(await comprimirImagen(item.getAsFile())); } catch (err) { showError(err.message); }
});

// ---------- Dictado por voz (llamadas) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (SR) {
  $('#btnDictar').classList.remove('hidden');
  $('#btnDictar').addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'es-AR';
    rec.continuous = true;
    rec.interimResults = false;
    const base = $('#texto').value;
    let dicho = '';
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) dicho += ev.results[i][0].transcript + ' ';
      }
      $('#texto').value = (base ? base + '\n' : '') + dicho.trim();
    };
    rec.onerror = (ev) => showError(ev.error === 'not-allowed' ? 'Permití el uso del micrófono para dictar.' : 'No se pudo usar el micrófono (' + ev.error + ').');
    rec.onend = () => {
      rec = null;
      $('#btnDictar').textContent = '🎤 Dictar llamada';
      $('#btnDictar').classList.add('sec');
    };
    rec.start();
    $('#btnDictar').textContent = '⏹ Terminar dictado';
    $('#btnDictar').classList.remove('sec');
  });
}

$('#btnLimpiar').addEventListener('click', () => {
  setCaptura('');
  $('#texto').value = '';
  $('#resultado').classList.add('hidden');
  showError('');
});

$('#btnProcesar').addEventListener('click', async () => {
  const texto = $('#texto').value.trim();
  if (!texto && !imagen) return showError('Subí una captura, dictá o pegá el mensaje del cliente.');
  if (rec) rec.stop();
  showError('');
  const btn = $('#btnProcesar');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${imagen ? 'Leyendo la captura…' : 'Leyendo el pedido…'}`;
  try {
    pedido = await api('/api/procesar', { method: 'POST', body: { texto, imagen } });
    pedido.texto_original = texto || '(captura de pantalla)';
    pedido.origen = imagen ? 'captura' : 'manual';
    render();
    $('#resultado').classList.remove('hidden');
    $('#guardado').classList.add('hidden');
    $('#resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Procesar con IA';
  }
});

function render() {
  $('#cNombre').value = pedido.cliente.nombre;
  $('#cTel').value = pedido.cliente.telefono;
  $('#eTipo').value = pedido.entrega.tipo;
  $('#eHorario').value = pedido.entrega.horario;
  $('#eDir').value = pedido.entrega.direccion;
  $('#pago').value = pedido.pago;
  $('#respuesta').value = pedido.respuesta_sugerida;

  let html = '';
  if (pedido.faltantes.length) html += `<div class="muted">Falta preguntar:</div><div class="chips">${pedido.faltantes.map((f) => `<span class="chip warn">${esc(f)}</span>`).join('')}</div>`;
  if (pedido.no_reconocidos.length) html += `<div class="muted">No está en el menú:</div><div class="chips">${pedido.no_reconocidos.map((f) => `<span class="chip bad">${esc(f)}</span>`).join('')}</div>`;
  $('#alertas').innerHTML = html;
  renderItems();
}

function renderItems() {
  $('#items').innerHTML = pedido.items.length
    ? pedido.items.map((it, i) => `
      <tr>
        <td>${esc(it.producto)}${it.nota ? `<div class="muted">${esc(it.nota)}</div>` : ''}</td>
        <td class="num"><input type="number" min="1" value="${it.cantidad}" data-i="${i}" style="width:64px;text-align:right"></td>
        <td class="num">${money(it.precio_unit)}</td>
        <td class="num">${money(it.cantidad * it.precio_unit)}</td>
        <td class="num"><button class="sec small" data-del="${i}" title="Quitar">✕</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No se detectaron productos del menú.</td></tr>';
  renderTotales();
}

function renderTotales() {
  const tipo = $('#eTipo').value;
  const sub = pedido.items.reduce((s, i) => s + i.cantidad * i.precio_unit, 0);
  const envio = tipo === 'envio' ? Number(config.envio) || 0 : 0;
  $('#totales').innerHTML = (envio ? `<div class="muted" style="font-size:.9rem;font-weight:400">Subtotal ${money(sub)} + envío ${money(envio)}</div>` : '') + `Total ${money(sub + envio)}`;
  updateWa();
}

function updateWa() {
  $('#btnWa').href = waLink($('#cTel').value, $('#respuesta').value);
}

$('#items').addEventListener('input', (e) => {
  if (e.target.dataset.i === undefined) return;
  pedido.items[e.target.dataset.i].cantidad = Math.max(1, parseInt(e.target.value) || 1);
  const row = e.target.closest('tr');
  const it = pedido.items[e.target.dataset.i];
  row.children[3].textContent = money(it.cantidad * it.precio_unit);
  renderTotales();
});
$('#items').addEventListener('click', (e) => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  pedido.items.splice(Number(i), 1);
  renderItems();
});
$('#btnAgregar').addEventListener('click', () => {
  const m = config.menu[$('#agregarProd').value];
  if (!m) return;
  const ex = pedido.items.find((x) => x.producto === m.producto);
  if (ex) ex.cantidad++;
  else pedido.items.push({ producto: m.producto, cantidad: 1, precio_unit: m.precio, nota: '' });
  renderItems();
});
$('#eTipo').addEventListener('change', renderTotales);
$('#respuesta').addEventListener('input', updateWa);
$('#cTel').addEventListener('input', updateWa);

$('#btnCopiar').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#respuesta').value);
    $('#btnCopiar').textContent = '¡Copiado!';
  } catch {
    $('#respuesta').select();
    document.execCommand('copy');
    $('#btnCopiar').textContent = '¡Copiado!';
  }
  setTimeout(() => ($('#btnCopiar').textContent = 'Copiar'), 1500);
});

$('#btnGuardar').addEventListener('click', async () => {
  const btn = $('#btnGuardar');
  btn.disabled = true;
  try {
    const p = await api('/api/pedidos', {
      method: 'POST',
      body: {
        cliente: { nombre: $('#cNombre').value, telefono: $('#cTel').value },
        items: pedido.items,
        entrega: { tipo: $('#eTipo').value, direccion: $('#eDir').value, horario: $('#eHorario').value },
        pago: $('#pago').value,
        faltantes: pedido.faltantes,
        origen: pedido.origen,
        texto_original: pedido.texto_original
      }
    });
    $('#guardado').innerHTML = `Pedido #${p.id} guardado (${money(p.total)}). <a href="/panel.html">Ver panel</a>`;
    $('#guardado').classList.remove('hidden');
  } catch (e) {
    $('#guardado').classList.add('hidden');
    showError(e.message);
    $('#error').scrollIntoView({ behavior: 'smooth' });
  } finally {
    btn.disabled = false;
  }
});

init();
