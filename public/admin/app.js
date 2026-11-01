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
let imagen = ''; // captura comprimida (data URL)

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').classList.toggle('hidden', !msg);
}

async function init() {
  try {
    config = await api('/api/config');
    $('#agregarProd').innerHTML = config.menu.map((m, i) => `<option value="${i}">${esc(m.producto)} · ${money(m.precio)}</option>`).join('');
  } catch (e) { showError(e.message); }
}

// ---------- Texto y ejemplos ----------
function contarCaracteres() {
  $('#contador').textContent = $('#texto').value.length + ' caracteres';
}
$('#texto').addEventListener("input", contarCaracteres);

document.querySelectorAll('[data-ej]').forEach((b) => b.addEventListener('click', () => {
  $('#texto').value = EJEMPLOS[b.dataset.ej];
  contarCaracteres();
  $('#texto').focus();
}));

$('#btnLimpiar').addEventListener('click', () => {
  setCaptura('');
  $('#texto').value = '';
  contarCaracteres();
  pedido = null;
  $('#resultado').classList.add('hidden');
  $('#vacio').classList.remove('hidden');
  $('#iaTiempo').classList.add('hidden');
  $('#paso').textContent = 'Paso 1 de 2';
  showError('');
});

// ---------- Captura de pantalla ----------
function comprimirImagen(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Achicamos hasta que pese < ~800 KB para que suba rápido.
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
    procesar(); // un toque: subís la captura y ya se procesa
  } catch (err) { showError(err.message); }
});
$('#btnQuitarCaptura').addEventListener('click', () => setCaptura(''));

// Pegar una captura con Ctrl+V (WhatsApp Web)
document.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  try { setCaptura(await comprimirImagen(item.getAsFile())); } catch (err) { showError(err.message); }
});

// ---------- Dictado por voz ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function estadoDictado(grabando) {
  $('#btnDictar').classList.toggle('recording', grabando);
  $('#dictarIc').className = 'ic ' + (grabando ? 'orange' : 'dark');
  $('#dictarIc').innerHTML = icon(grabando ? 'stop' : 'mic');
  $('#dictarTit').textContent = grabando ? 'Escuchando… tocá para terminar' : 'Dictar llamada en vivo';
  $('#dictarSub').textContent = grabando ? 'Hablá normal, se va escribiendo' : 'Hablá y se escribe solo';
}

$('#btnDictar').addEventListener('click', () => {
  if (rec) { rec.stop(); return; }
  if (!SR) return showError('Tu navegador no permite dictado. Probá con Chrome.');
  // Los navegadores solo dejan usar el micrófono en sitios https (o localhost).
  if (!window.isSecureContext) {
    const https = 'https://' + location.host + location.pathname;
    $('#error').innerHTML = `El dictado necesita una conexión segura. <a href="${https}">Abrí la versión https</a>.`;
    $('#error').classList.remove('hidden');
    return;
  }
  iniciarDictado();
});

// Chrome corta el reconocimiento tras unos segundos de silencio aunque sea "continuous".
// Mientras el usuario no toque "terminar", lo volvemos a arrancar solo.
function iniciarDictado() {
  const base = $('#texto').value;
  let dicho = '';
  let seguir = true;
  const ERRORES = {
    'not-allowed': 'Permití el uso del micrófono para dictar (ícono del candado en la barra de direcciones).',
    'service-not-allowed': 'El navegador bloqueó el dictado. Probá con Google Chrome.',
    'audio-capture': 'No se encontró un micrófono conectado.',
    network: 'El dictado necesita internet y Google Chrome (otros navegadores no lo soportan bien).'
  };

  const arrancar = () => {
    const r = new SR();
    r.lang = 'es-AR';
    r.continuous = true;
    r.interimResults = true; // muestra el texto mientras hablás
    r.onresult = (ev) => {
      let parcial = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) dicho += ev.results[i][0].transcript.trim() + ' ';
        else parcial += ev.results[i][0].transcript;
      }
      $('#texto').value = (base ? base + '\n' : '') + (dicho + parcial).trim();
      contarCaracteres();
    };
    r.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return; // silencio: seguimos escuchando
      seguir = false;
      showError(ERRORES[ev.error] || 'No se pudo usar el micrófono (' + ev.error + ').');
    };
    r.onend = () => {
      if (seguir) {
        try { arrancar(); return; } catch {}
      }
      rec = null;
      estadoDictado(false);
    };
    r.start();
    actual = r;
  };

  let actual = null;
  // "rec" es el control global: el botón "terminar" llama a rec.stop() y corta los reinicios.
  rec = { stop: () => { seguir = false; try { actual && actual.stop(); } catch {} } };
  try {
    arrancar();
  } catch (e) {
    rec = null;
    return showError('No se pudo iniciar el dictado: ' + e.message);
  }
  showError('');
  estadoDictado(true);
}

// ---------- Procesar con IA ----------
async function procesar() {
  const texto = $('#texto').value.trim();
  if (!texto && !imagen) return showError('Subí una captura, dictá o pegá el mensaje del cliente.');
  if (rec) rec.stop();
  showError('');
  const btn = $('#btnProcesar');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${imagen ? 'Leyendo la captura…' : 'Interpretando…'}`;
  const t0 = performance.now();
  try {
    pedido = await api('/api/procesar', { method: 'POST', body: { texto, imagen } });
    pedido.texto_original = texto || '(captura de pantalla)';
    pedido.origen = imagen ? 'captura' : 'manual';
    $('#iaTiempo').textContent = 'IA ' + ((performance.now() - t0) / 1000).toFixed(1) + 's';
    $('#iaTiempo').classList.remove('hidden');
    render();
    $('#vacio').classList.add('hidden');
    $('#resultado').classList.remove('hidden');
    $('#guardado').classList.add('hidden');
    $('#paso').textContent = 'Paso 2 de 2 · revisá y confirmá';
    if (window.innerWidth <= 1000) $('.side').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = icon('zap') + 'Procesar con IA';
  }
}
$('#btnProcesar').addEventListener('click', procesar);

// ---------- Render de la comanda ----------
function render() {
  $('#cNombre').value = pedido.cliente.nombre;
  $('#cTel').value = pedido.cliente.telefono;
  $('#eTipo').value = pedido.entrega.tipo;
  $('#eHorario').value = pedido.entrega.horario;
  $('#eDir').value = pedido.entrega.direccion;
  $('#pago').value = pedido.pago;
  $('#respuesta').value = pedido.respuesta_sugerida;
  $('#hora').textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  let html = '';
  if (pedido.faltantes.length) {
    html += `<div class="alert warn">${icon('alert')}<div><b>Falta preguntarle al cliente</b><ul>${pedido.faltantes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div></div>`;
  }
  if (pedido.no_reconocidos.length) {
    html += `<div class="alert bad">${icon('x')}<div><b>No está en tu menú</b><ul>${pedido.no_reconocidos.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div></div>`;
  }
  $('#alertas').innerHTML = html;
  renderItems();
}

function renderItems() {
  $('#items').innerHTML = pedido.items.length
    ? pedido.items.map((it, i) => `
      <div class="item">
        <div class="qty">
          <button type="button" data-menos="${i}" aria-label="Restar">−</button>
          <span>${it.cantidad}x</span>
          <button type="button" data-mas="${i}" aria-label="Sumar">+</button>
        </div>
        <div class="name"><b>${esc(it.producto)}</b><small>${it.nota ? esc(it.nota) : money(it.precio_unit) + ' c/u'}</small></div>
        <div class="price">${money(it.cantidad * it.precio_unit)}</div>
        <button type="button" class="del" data-del="${i}" aria-label="Quitar">${icon('trash')}</button>
      </div>`).join('')
    : `<div class="alert warn">${icon('info')}<div>No se detectaron productos del menú. Agregalos abajo.</div></div>`;
  renderTotales();
}

function renderTotales() {
  const tipo = $('#eTipo').value;
  const sub = pedido.items.reduce((s, i) => s + i.cantidad * i.precio_unit, 0);
  const envio = tipo === 'envio' ? Number(config.envio) || 0 : 0;
  $('#tSub').textContent = money(sub);
  $('#tEnvio').innerHTML = tipo === 'envio'
    ? `<span class="mono">${money(envio)}</span>`
    : `<span class="pill gray">${tipo === 'retiro' ? 'Sin cargo (retira)' : 'A definir'}</span>`;
  $('#tTotal').textContent = money(sub + envio);
  $('#eIc').innerHTML = icon(tipo === 'envio' ? 'bike' : 'store');
  $('#dirWrap').classList.toggle('hidden', tipo === 'retiro');
  updateWa();
}

function updateWa() {
  $('#btnWa').href = waLink($('#cTel').value, $('#respuesta').value);
}

$('#items').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const { mas, menos, del } = b.dataset;
  if (mas !== undefined) pedido.items[mas].cantidad++;
  else if (menos !== undefined) {
    if (pedido.items[menos].cantidad > 1) pedido.items[menos].cantidad--;
    else pedido.items.splice(Number(menos), 1);
  } else if (del !== undefined) pedido.items.splice(Number(del), 1);
  else return;
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
  } catch {
    $('#respuesta').select();
    document.execCommand('copy');
  }
  $('#btnCopiar span:last-child').textContent = '¡Copiado!';
  setTimeout(() => ($('#btnCopiar span:last-child').textContent = 'Copiar'), 1500);
});

// ---------- Guardar (mandar a cocina) ----------
$('#btnGuardar').addEventListener('click', async () => {
  const btn = $('#btnGuardar');
  if (!pedido.items.length) return showError('La comanda no tiene productos.');
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
    $('#guardado').innerHTML = `${icon('checkCircle')} Comanda <b class="mono">#${p.id}</b> enviada a cocina (${money(p.total)}). <a href="/admin/panel.html">Ver comandas</a>`;
    $('#guardado').classList.remove('hidden');
    actualizarContador();
  } catch (e) {
    $('#guardado').classList.add('hidden');
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
});


init();
