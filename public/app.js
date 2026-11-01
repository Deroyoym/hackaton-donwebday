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

$('#btnLimpiar').addEventListener('click', () => {
  $('#texto').value = '';
  $('#resultado').classList.add('hidden');
  showError('');
});

$('#btnProcesar').addEventListener('click', async () => {
  const texto = $('#texto').value.trim();
  if (!texto) return showError('Pegá primero el mensaje del cliente.');
  showError('');
  const btn = $('#btnProcesar');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Leyendo el pedido…';
  try {
    pedido = await api('/api/procesar', { method: 'POST', body: { texto } });
    pedido.texto_original = texto;
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
