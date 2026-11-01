# Pedido Express

Asistente con IA que atiende los pedidos de un negocio local las 24 hs y los convierte en comandas listas para cocina.

**Demo:** http://201.32.132.107 (también https://dwday-125148885.online)

## El problema

Un negocio local, como una pizzería de barrio, atiende consultas y pedidos a mano por WhatsApp o por teléfono. En la hora pico se acumulan los mensajes sin responder, se anotan pedidos con errores, se calculan mal los totales y los clientes que esperan se van a otro lado. Así pierde ventas.

## La solución

1. **El cliente pide solo.** Entra a la landing del local, abre el chat y escribe como en WhatsApp ("2 muzzas y una coca, envío a Corrientes 1234"). La IA arma el pedido, le muestra un ticket con precios y total y le pide los datos que faltan. Si el local está cerrado, deja el pedido programado para la apertura.
2. **El local lo recibe ordenado.** El pedido confirmado cae en el panel de comandas con un sonido. Los pedidos que siguen llegando por WhatsApp o teléfono también se cargan rápido: se sube una captura del chat o se dicta la llamada, y la IA los convierte en comanda con una respuesta sugerida para mandar por WhatsApp.
3. **El cliente lo sigue en vivo.** El local cambia el estado (preparando, listo, entregado) y el cliente lo ve actualizarse solo en el chat.

Pantallas: landing pública con el chat (`/`), login del local (`/login.html`, en la demo el usuario es `admin` y la contraseña `donpepe`), nuevo pedido (`/admin/`), comandas (`/admin/panel.html`) y menú y horarios (`/admin/config.html`).

## Cómo usa la IA

- **Chat de clientes:** el modelo recibe el menú, los precios, los horarios, si el local está abierto o cerrado (lo calcula el servidor con la hora de Argentina) y el pedido armado hasta ese momento. Devuelve JSON con una respuesta corta y el pedido actualizado (productos, cantidades, nombre, teléfono, entrega, dirección y pago).
- **Captura o dictado:** el modelo lee un texto desordenado, una transcripción de una llamada o una **imagen** de un chat de WhatsApp. Devuelve JSON con la comanda, lo que falta preguntar, lo que no está en el menú y un mensaje sugerido para el cliente.
- **Por qué es confiable:** el servidor valida cada producto contra el menú y **calcula los totales él mismo**, así que la IA nunca inventa precios. El servidor también conserva los datos ya dados, define qué falta y nunca da un pedido por confirmado hasta que el cliente toca el botón.

El modelo es `gpt-4o-mini` (API de OpenAI, compatible con otras bases). Si la API está saturada, la app reintenta y muestra un mensaje claro.

## Correr en local

```bash
npm install
cp .env.example .env   # completar OPENAI_API_KEY (y opcionalmente OPENAI_BASE_URL, OPENAI_MODEL, ADMIN_PASSWORD)
npm start              # http://localhost:3000
```

El stack es Node + Express en un solo `server.js`, con frontend en HTML, CSS y JS puro en `/public`. Los datos se guardan en `data.json`, no hay base de datos.
