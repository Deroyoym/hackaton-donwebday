# Pedido Express

Asistente con IA que atiende los pedidos de un negocio local las 24 hs y los convierte en comandas listas para cocina.

**Demo:** http://201.32.132.107 (también https://dwday-125148885.online)

## El problema

Un negocio local, como una pizzería de barrio, atiende consultas y pedidos a mano por WhatsApp o por teléfono. En la hora pico se acumulan los mensajes sin responder, se anotan pedidos con errores, se calculan mal los totales y los clientes que esperan se van a otro lado. Así pierde ventas.

## La solución

1. **El cliente pide solo.** Entra a la landing del local, abre el chat y escribe como en WhatsApp ("2 muzzas y una coca, envío a Corrientes 1234"). La IA arma el pedido, le muestra un ticket con precios y total y le pide los datos que faltan. Si el local está cerrado, deja el pedido programado para la apertura.
2. **El local lo recibe ordenado.** El pedido confirmado cae en el panel de comandas con un sonido. Los pedidos que siguen llegando por WhatsApp o teléfono también se cargan rápido: se sube una captura del chat o se dicta la llamada, y la IA los convierte en comanda con una respuesta sugerida para mandar por WhatsApp.
3. **El cliente lo sigue en vivo.** El local cambia el estado (preparando, listo, entregado) y el cliente lo ve actualizarse solo en el chat. Desde otro dispositivo, alcanza con escribir "pedido #2" en el chat.

Pantallas: landing pública con el chat (`/`), login del local (`/login.html`, en la demo el usuario es `admin` y la contraseña `donpepe`), nuevo pedido (`/admin/`), comandas (`/admin/panel.html`) y menú y horarios (`/admin/config.html`).

## Cómo usa la IA

- **Chat de clientes:** el modelo recibe el menú, los precios, los horarios, si el local está abierto o cerrado (lo calcula el servidor con la hora de Argentina) y el pedido armado hasta ese momento. Devuelve JSON con una respuesta corta y el pedido actualizado (productos, cantidades, nombre, teléfono, entrega, dirección y pago).
- **Captura o dictado:** el modelo lee un texto desordenado, una transcripción de una llamada o una **imagen** de un chat de WhatsApp. Devuelve JSON con la comanda, lo que falta preguntar, lo que no está en el menú y un mensaje sugerido para el cliente.
- **Por qué es confiable:** el servidor valida cada producto contra el menú y **calcula los totales él mismo**, así que la IA nunca inventa precios. El servidor también conserva los datos ya dados, define qué falta y nunca da un pedido por confirmado hasta que el cliente toca el botón.

El modelo es `gpt-4o-mini` (API de OpenAI, compatible con otras bases). Si la API está saturada, la app reintenta y muestra un mensaje claro.

## Cómo está armado

### Dominio y servidor

La app no usa subdominios: es una sola app Node en un solo servidor, a la que se llega de dos formas.

| Dirección | Qué hace |
|---|---|
| `https://dwday-125148885.online` | Entrada principal, con certificado Let's Encrypt. Hace falta https para usar el micrófono (dictado). |
| `http://dwday-125148885.online` | Redirige a la versión https. |
| `http://201.32.132.107` | Acceso directo por IP, sin https. Todo anda menos el dictado. |

```
Navegador ──► Nginx (puertos 80 y 443, límite de 8 MB para imágenes)
                └──► Node + Express en 127.0.0.1:3000 (PM2, proceso "app")
                       ├── /public       → páginas HTML, CSS y JS (archivos estáticos)
                       ├── /api/*        → API JSON
                       ├── data.json     → menú, configuración y pedidos
                       └── OpenAI API    → gpt-4o-mini (texto e imágenes)
```

### Páginas

| Ruta | Quién la usa | Para qué |
|---|---|---|
| `/` | Clientes (pública) | Landing del local: estado abierto/cerrado, menú, horarios y el **chat de pedidos** en una ventana flotante. `/#pedir` abre el chat directo (es el link del QR). |
| `/pedir.html` | Clientes | Atajo que redirige a `/#pedir`. |
| `/login.html` | Dueño del local | Inicio de sesión. Después vuelve a la página que se quería abrir. |
| `/admin/` | Dueño (con login) | **Nuevo pedido:** captura de WhatsApp, dictado o texto, y la IA arma la comanda. |
| `/admin/panel.html` | Dueño (con login) | **Comandas:** pedidos en vivo, cambio de estado, aviso por WhatsApp y QR con el link para clientes. |
| `/admin/config.html` | Dueño (con login) | **Menú y precios:** productos, envío, horario de apertura y cierre, días cerrados e información para el asistente. |

Todo lo que está bajo `/admin` está protegido: sin sesión redirige a `/login.html`. La sesión es una cookie firmada (HMAC, HttpOnly, 12 h) y no usa librerías extra.

### API

| Método y ruta | Acceso | Qué hace |
|---|---|---|
| `GET /api/config` | Público | Menú, horarios y el estado abierto/cerrado calculado con la hora de Argentina. |
| `POST /api/chat` | Público | Chat de clientes: recibe la conversación y el pedido actual, y devuelve la respuesta de la IA, el pedido actualizado, lo que falta y si está listo. |
| `POST /api/pedidos` | Público o admin | Crea un pedido. Los precios se recalculan siempre con el menú. |
| `GET /api/pedidos/:id/estado` | Público | Seguimiento: solo devuelve número, estado y tipo de entrega, sin datos personales. |
| `POST /api/procesar` | Admin | Convierte texto, dictado o una captura en comanda, con un mensaje sugerido. |
| `GET /api/pedidos` | Admin | Lista de comandas para el panel. |
| `PATCH /api/pedidos/:id` | Admin | Cambia el estado: nuevo, preparando, listo, entregado o cancelado. |
| `PUT /api/config` | Admin | Guarda menú, horarios e información del negocio. |
| `POST /api/login`, `POST /api/logout`, `GET /api/auth` | — | Sesión del dueño. |
| `GET /api/health` | Público | Estado del servidor y modelo de IA configurado. |

### Cómo se conectan

1. **Cliente → local:** en `/`, el chat llama a `/api/chat` en cada mensaje. Al tocar "Confirmar pedido" se hace `POST /api/pedidos` y el pedido queda guardado en `data.json`.
2. **Local:** `/admin/panel.html` consulta `/api/pedidos` cada 5 s. Cuando llega un pedido nuevo, suena y muestra un contador. El dueño cambia el estado con `PATCH`.
3. **Local → cliente:** el chat del cliente consulta `/api/pedidos/:id/estado` cada 5 s y actualiza la tarjeta de seguimiento. Si recarga la página, el seguimiento vuelve a aparecer; desde otro dispositivo, alcanza con escribir "pedido #N".
4. **Pedidos por WhatsApp o teléfono:** en `/admin/`, la captura o el dictado van a `/api/procesar`. El dueño revisa la comanda y la manda al panel con el mismo `POST /api/pedidos`.
5. **Configuración:** lo que se guarda en `/admin/config.html` lo usa al instante la IA, tanto en el chat como en el procesamiento de pedidos, y también la landing.

### Deploy

El código está en GitHub. En el servidor, el comando `redeploy /root/app` hace `git pull`, instala las dependencias y reinicia el proceso en PM2. Las keys solo están en el `.env` del servidor y nunca se suben al repo.

## Correr en local

```bash
npm install
cp .env.example .env   # completar OPENAI_API_KEY (y opcionalmente OPENAI_BASE_URL, OPENAI_MODEL, ADMIN_PASSWORD)
npm start              # http://localhost:3000
```

El stack es Node + Express en un solo `server.js`, con frontend en HTML, CSS y JS puro en `/public`. Los datos se guardan en `data.json`, no hay base de datos.
